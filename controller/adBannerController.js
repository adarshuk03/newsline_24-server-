"use strict";

const cloudinary = require("../config/cloudinary");
const redis      = require("../config/redis");

// ─── Constants ────────────────────────────────────────────────────────────────
const REDIS_KEY_PREFIX = "ad-banner:";
const REDIS_COUNT_KEY  = "ad-banner-count";
const REDIS_INDEX_KEY  = "ad-banner-index";

// ─── Helper: detect real mimetype from buffer magic bytes ─────────────────────
// Detects both image and video formats from magic bytes.
// Browser-reported Content-Type is based on file extension and cannot be trusted.
function detectMimeType(buffer) {
  const b = buffer;

  // ── Images ──
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF)
    return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47)
    return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46)
    return "image/webp";

  // ── Videos ──
  // MP4 / MOV / M4V: ftyp box at offset 4 (bytes 4–7 = "ftyp")
  if (
    b.length > 11 &&
    b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  ) {
    // brand at bytes 8–11 distinguishes MP4 vs MOV
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "qt  ") return "video/quicktime"; // MOV
    return "video/mp4";                             // mp42, isom, avc1, etc.
  }
  // WebM / MKV: starts with EBML header 0x1A 0x45 0xDF 0xA3
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3)
    return "video/webm";

  // Default to JPEG for unrecognised content
  return "image/jpeg";
}

// ─── Helper: is this mimetype a video? ───────────────────────────────────────
function isVideoMime(mime) {
  return mime.startsWith("video/");
}

// ─── Helper: get total count ──────────────────────────────────────────────────
async function getBannerCount() {
  const raw = await redis.get(REDIS_COUNT_KEY);
  return raw ? parseInt(raw, 10) : 0;
}

// ─── POST /api/ad-banner/upload ───────────────────────────────────────────────
exports.uploadAdBanner = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided." });
    }

    // Detect real format from magic bytes — ignore browser-reported mimetype
    const realMime    = detectMimeType(req.file.buffer);
    const isVideo     = isVideoMime(realMime);
    const resourceType = isVideo ? "video" : "image";

    console.log(
      `[Ad Upload] Browser mime: ${req.file.mimetype} | ` +
      `Detected mime: ${realMime} | Resource type: ${resourceType}`
    );

    const b64     = req.file.buffer.toString("base64");
    const dataUri = `data:${realMime};base64,${b64}`;

    const uploadResult = await cloudinary.uploader.upload(dataUri, {
      resource_type: resourceType,
      folder:        "ad_banners",
      overwrite:     false,
    });

    const { width, height, secure_url, duration } = uploadResult;

    const count = await getBannerCount();
    const slot  = count;

    // Store URL + type so the list/current endpoints can expose it
    await redis.set(`${REDIS_KEY_PREFIX}${slot}`, secure_url);
    await redis.set(`${REDIS_KEY_PREFIX}${slot}:type`, resourceType);
    await redis.set(REDIS_COUNT_KEY, String(count + 1));

    console.log(
      `${isVideo ? "🎬" : "🖼️ "} Ad banner saved to slot ${slot}: ` +
      `${secure_url} (${width}x${height}${duration ? ` ${duration.toFixed(1)}s` : ""})`
    );

    return res.json({
      message:      `✅ Ad banner uploaded successfully.`,
      slot,
      url:          secure_url,
      resourceType,
      dimensions:   { width, height },
      ...(duration != null && { duration }),
    });

  } catch (err) {
    console.error("❌ uploadAdBanner error:", err.message);
    return res.status(500).json({ error: "Upload failed.", details: err.message });
  }
};


// ─── GET /api/ad-banner/current ───────────────────────────────────────────────
exports.getCurrentAdBanner = async (req, res) => {
  try {
    const count = await getBannerCount();

    if (count === 0) {
      return res.json({ url: null, message: "No ad banners uploaded yet." });
    }

    const rawIdx = await redis.get(REDIS_INDEX_KEY);
    const idx    = rawIdx ? parseInt(rawIdx, 10) % count : 0;
    const url    = await redis.get(`${REDIS_KEY_PREFIX}${idx}`);
    const type   = await redis.get(`${REDIS_KEY_PREFIX}${idx}:type`) || "image";

    return res.json({ url, slot: idx, total: count, resourceType: type });
  } catch (err) {
    console.error("❌ getCurrentAdBanner error:", err.message);
    return res.status(500).json({ error: "Failed to get banner.", details: err.message });
  }
};


// ─── GET /api/ad-banner/list ──────────────────────────────────────────────────
exports.listAdBanners = async (req, res) => {
  try {
    const count = await getBannerCount();

    if (count === 0) {
      return res.json({ banners: [], total: 0 });
    }

    const banners = [];
    for (let i = 0; i < count; i++) {
      const url  = await redis.get(`${REDIS_KEY_PREFIX}${i}`);
      const type = await redis.get(`${REDIS_KEY_PREFIX}${i}:type`) || "image";
      if (url) banners.push({ slot: i, url, resourceType: type });
    }

    return res.json({ banners, total: banners.length });
  } catch (err) {
    console.error("❌ listAdBanners error:", err.message);
    return res.status(500).json({ error: "Failed to list banners.", details: err.message });
  }
};


// ─── DELETE /api/ad-banner/:slot ─────────────────────────────────────────────
exports.deleteAdBanner = async (req, res) => {
  try {
    const slot  = parseInt(req.params.slot, 10);
    const count = await getBannerCount();

    if (isNaN(slot) || slot < 0 || slot >= count) {
      return res.status(400).json({ error: `Invalid slot. Must be 0–${count - 1}.` });
    }

    // Shift all slots down, including the :type keys
    for (let i = slot; i < count - 1; i++) {
      const nextUrl  = await redis.get(`${REDIS_KEY_PREFIX}${i + 1}`);
      const nextType = await redis.get(`${REDIS_KEY_PREFIX}${i + 1}:type`) || "image";
      await redis.set(`${REDIS_KEY_PREFIX}${i}`, nextUrl);
      await redis.set(`${REDIS_KEY_PREFIX}${i}:type`, nextType);
    }

    // Remove the last slot (now a duplicate after shifting)
    await redis.del(`${REDIS_KEY_PREFIX}${count - 1}`);
    await redis.del(`${REDIS_KEY_PREFIX}${count - 1}:type`);
    await redis.set(REDIS_COUNT_KEY, String(count - 1));

    const newCount = count - 1;
    if (newCount === 0) {
      await redis.del(REDIS_INDEX_KEY);
    } else {
      const rawIdx = await redis.get(REDIS_INDEX_KEY);
      const idx    = rawIdx ? parseInt(rawIdx, 10) : 0;
      if (idx >= newCount) {
        await redis.set(REDIS_INDEX_KEY, "0");
      }
    }

    return res.json({ message: `✅ Banner slot ${slot} deleted.`, remaining: newCount });
  } catch (err) {
    console.error("❌ deleteAdBanner error:", err.message);
    return res.status(500).json({ error: "Delete failed.", details: err.message });
  }
};


// ─── Shared helper: round-robin URL for poster generation ────────────────────
exports.getNextAdBannerUrl = async function () {
  const count = await getBannerCount();

  if (count === 0) {
    console.warn("⚠️  No ad banners in Redis.");
    return null;
  }

  const rawIdx     = await redis.get(REDIS_INDEX_KEY);
  const currentIdx = rawIdx ? parseInt(rawIdx, 10) : 0;
  const safeIdx    = currentIdx % count;
  const nextIdx    = (safeIdx + 1) % count;

  await redis.set(REDIS_INDEX_KEY, String(nextIdx));

  const url  = await redis.get(`${REDIS_KEY_PREFIX}${safeIdx}`);
  const type = await redis.get(`${REDIS_KEY_PREFIX}${safeIdx}:type`) || "image";

  console.log(`${type === "video" ? "🎬" : "🖼️ "} Ad Banner [${safeIdx + 1}/${count}]: ${url}`);
  if (!url) return null;

  // Return both url and resourceType so callers can route image vs video correctly
  return { url, resourceType: type };
};