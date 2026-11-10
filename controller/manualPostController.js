"use strict";

const path = require("path");
const fs   = require("fs");

const aiService     = require("../services/aiService");
const canvasService = require("../services/canvasService");
const videoService  = require("../services/videoService");
const cloudinary    = require("../config/cloudinary");

const { postReelToInstagram } = require("../services/instagramService");
const { postReelToFacebook }  = require("../services/facebookService");
const { uploadShort }         = require("../services/youtubeShorts");

const { TMP, safeDelete } = require("../utils/fileUtils");
const { getNextAdBannerUrl } = require("./adBannerController");

// ─────────────────────────────────────────────
// Active SSE connections  { sessionId → res }
// ─────────────────────────────────────────────
const activeStreams = new Map();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function keepMalayalamAndSpaces(text) {
  return text || "";
}

function getSafeYouTubeTitle(text) {
  if (!text || !text.trim()) return "Latest News #Shorts";
  return text.toString().replace(/\s+/g, " ").trim().slice(0, 90);
}

function generateSessionId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function sendSSEMessage(res, type, data) {
  const timestamp = new Date().toLocaleTimeString();
  res.write(`data: ${JSON.stringify({ type, data, timestamp })}\n\n`);
}

/**
 * Broadcast a log entry to the connected SSE client.
 * Returns true if delivered, false if no stream found yet.
 */
function broadcastLog(sessionId, type, message) {
  const stream = activeStreams.get(sessionId);
  if (stream && !stream.destroyed) {
    sendSSEMessage(stream, type, { message });
    return true;
  }
  return false;
}

/**
 * Wait until an SSE client connects for the given sessionId,
 * or give up after `timeoutMs` milliseconds.
 */
function waitForSSEClient(sessionId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (activeStreams.has(sessionId)) return resolve(true);

    const interval = 100; // poll every 100ms
    let elapsed = 0;

    const timer = setInterval(() => {
      elapsed += interval;
      if (activeStreams.has(sessionId)) {
        clearInterval(timer);
        return resolve(true);
      }
      if (elapsed >= timeoutMs) {
        clearInterval(timer);
        return resolve(false); // timed-out – continue anyway
      }
    }, interval);
  });
}

// ─────────────────────────────────────────────
// SSE endpoint  GET /api/manual-post/stream
// ─────────────────────────────────────────────
exports.streamPostLogs = (req, res) => {
  const { sessionId } = req.query;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId required" });
  }

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Flush headers immediately so the client knows it's connected
  res.flushHeaders?.();

  activeStreams.set(sessionId, res);
  sendSSEMessage(res, "connected", { sessionId });

  req.on("close", () => activeStreams.delete(sessionId));
};

// ─────────────────────────────────────────────
// Core processing logic (shared by both routes)
// ─────────────────────────────────────────────
async function processPost({ sessionId, title, description, imageUrl, uploadedFile }) {
  const timestamp   = Date.now();
  const imgFilePath = path.join(TMP, `manual-${timestamp}.png`);
  const vidFilePath = path.join(TMP, `manual-${timestamp}.mp4`);

  try {
    // ── Wait for the SSE client to connect ──────────────────────────────────
    // The HTTP response carrying sessionId reaches the client first;
    // the client then opens the SSE stream.  We poll until it's ready.
    const connected = await waitForSSEClient(sessionId);
    if (!connected) {
      console.warn(`[${sessionId}] SSE client never connected – proceeding without live logs`);
    }

    // ── Validation ──────────────────────────────────────────────────────────
    broadcastLog(sessionId, "info", "📋 Validating inputs…");

    if (!title || !description) {
      broadcastLog(sessionId, "error", "❌ Title and description are required");
      return;
    }

    const cleanTitle = keepMalayalamAndSpaces(title);
    const safeTitle  = getSafeYouTubeTitle(cleanTitle);
    const finalTitle =
      safeTitle && safeTitle.length >= 3
        ? `${safeTitle} 🔥 #Shorts`
        : "Latest News 🔥 #Shorts";

    broadcastLog(sessionId, "success", `✅ Title: "${finalTitle}"`);

    // ── Image source ─────────────────────────────────────────────────────────
    broadcastLog(sessionId, "info", "🖼️ Processing image…");

    let imageSource;

    if (uploadedFile) {
      imageSource = `data:${uploadedFile.mimetype};base64,${uploadedFile.buffer.toString("base64")}`;
      broadcastLog(sessionId, "success", "✅ File uploaded successfully");
    } else if (imageUrl) {
      imageSource = imageUrl;
      broadcastLog(sessionId, "success", "✅ Image URL loaded");
    } else {
      broadcastLog(sessionId, "error", "❌ No image provided");
      return;
    }

    // ── Hashtags ─────────────────────────────────────────────────────────────
    broadcastLog(sessionId, "info", "🏷️ Generating hashtags…");
    const hashtags = await aiService.generateHashtags(`${title} ${description}`);
    broadcastLog(sessionId, "success", `✅ Hashtags: ${hashtags}`);

    // ── Poster ───────────────────────────────────────────────────────────────
  // AFTER — handles { type, buffer } from canvasService
broadcastLog(sessionId, "info", "🎨 Creating news poster…");
const adBanner       = await getNextAdBannerUrl(); // { url, resourceType } | null
const adBannerUrl    = adBanner?.url    || null;
const adResourceType = adBanner?.resourceType || null;
const posterResult = await canvasService.createNewsPoster({
  title:       cleanTitle || title,
  image:       imageSource,
  adBannerUrl,
  adResourceType,
});
// posterResult is { type: "image"|"video", buffer, liveAdVideoUrl, adH }
broadcastLog(sessionId, "success", `✅ Poster created (type: ${posterResult.type})`);

let finalUrl;

if (posterResult.type === "video") {
  // Canvas already composited the MP4 via FFmpeg — upload it directly
  broadcastLog(sessionId, "info", "☁️ Uploading video poster to Cloudinary…");
  fs.writeFileSync(vidFilePath, posterResult.buffer);
  const upload = await cloudinary.uploader.upload(vidFilePath, {
    resource_type: "video",
    folder:        "manual_posts",
  });
  finalUrl = upload.secure_url;
  broadcastLog(sessionId, "success", "✅ Cloudinary upload complete");

} else {
  // PNG poster — run through videoService to produce MP4 (with live ad composite), then upload
  fs.writeFileSync(imgFilePath, posterResult.buffer);

  broadcastLog(sessionId, "info", "🎬 Converting image to video…");
  try {
    await videoService.convertImageToVideo(imgFilePath, vidFilePath, {
      adVideoInput: posterResult.liveAdVideoUrl || null,
      adH:          posterResult.adH            || null,
    });
    broadcastLog(sessionId, "success", "✅ Video conversion complete");
  } catch (videoErr) {
    broadcastLog(sessionId, "error", `❌ Video conversion failed: ${videoErr.message}`);
    throw videoErr;
  }

  broadcastLog(sessionId, "info", "☁️ Uploading to Cloudinary…");
  const upload = await cloudinary.uploader.upload(vidFilePath, {
    resource_type: "video",
    folder:        "manual_posts",
  });
  finalUrl = upload.secure_url;
  broadcastLog(sessionId, "success", "✅ Cloudinary upload complete");
}

    // ── Captions ─────────────────────────────────────────────────────────────
    const instaCaption = `${description}\nRead more 👉 link in bio\n\n${hashtags} #news #india #breakingnews`;
    const fbCaption    = `${description}\nRead more 👉 link in bio\n\n${hashtags}`;
    const ytCaption    = `${description}\n\n${hashtags} #Shorts`;

    // ── Platform posting ──────────────────────────────────────────────────────
    broadcastLog(sessionId, "info", "📱 Starting multi-platform posting…");

    const platforms = [
      { name: "Instagram", fn: () => postReelToInstagram(finalUrl, instaCaption) },
      { name: "Facebook",  fn: () => postReelToFacebook(finalUrl, fbCaption)    },
      { name: "YouTube",   fn: () => uploadShort(vidFilePath, finalTitle, ytCaption) },
    ];

    for (const platform of platforms) {
      broadcastLog(sessionId, "info", `⏳ Posting to ${platform.name}…`);
      try {
        await platform.fn();
        broadcastLog(sessionId, "success", `✅ ${platform.name} posted`);
      } catch (err) {
        broadcastLog(sessionId, "error", `❌ ${platform.name} failed: ${err.message}`);
        // Continue to next platform – don't abort the whole job
      }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    broadcastLog(sessionId, "info", "🧹 Cleaning up temporary files…");
    safeDelete(imgFilePath);
    safeDelete(vidFilePath);
    broadcastLog(sessionId, "success", "✅ Cleanup complete");

    broadcastLog(sessionId, "complete", "🎉 All done! Your post is live!");

  } catch (err) {
    safeDelete(imgFilePath);
    safeDelete(vidFilePath);
    console.error(`[${sessionId}] ❌ ERROR:`, err.message);
    broadcastLog(sessionId, "error", `❌ Fatal error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// POST /api/manual-post  (multipart/form-data)
// ─────────────────────────────────────────────
exports.manualPostNews = (req, res) => {
  const { title, description, imageUrl } = req.body;
  const uploadedFile = req.file;

  if (!title || !description) {
    return res.status(400).json({ error: "Title and description are required" });
  }

  if (!uploadedFile && !imageUrl) {
    return res.status(400).json({ error: "Provide an image file or imageUrl" });
  }

  // ── Respond immediately with the sessionId ────────────────────────────────
  // The client opens the SSE stream using this id; processPost() then
  // waits until that stream is ready before emitting any log entries.
  const sessionId = generateSessionId();

  res.json({
    message:   "Processing started",
    sessionId,
  });

  // Fire-and-forget – errors are surfaced via SSE
  processPost({ sessionId, title, description, imageUrl, uploadedFile });
};

// ─────────────────────────────────────────────
// POST /api/manual-post-json  (application/json)
// ─────────────────────────────────────────────
exports.manualPostNewsJson = (req, res) => {
  const { title, description, imageUrl } = req.body;

  if (!title || !description) {
    return res.status(400).json({ error: "Title and description are required" });
  }

  if (!imageUrl) {
    return res.status(400).json({ error: "imageUrl is required" });
  }

  const sessionId = generateSessionId();

  res.json({
    message:   "Processing started",
    sessionId,
  });

  processPost({ sessionId, title, description, imageUrl, uploadedFile: null });
};