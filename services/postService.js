"use strict";

/**
 * One shared pipeline for every way a news item gets posted
 * (dashboard buttons + the cron routes):
 *
 *   news item → hashtags → ad banner → poster (PNG/MP4)
 *             → reel video → Cloudinary → Instagram / Facebook / YouTube
 *             → "already posted" flag in Redis
 */

const path  = require("path");
const fs    = require("fs");
const axios = require("axios");
const sharp = require("sharp");

const aiService     = require("./aiService");
const canvasService = require("./canvasService");
const videoService  = require("./videoService");
const cloudinary    = require("../config/cloudinary");
const redis         = require("../config/redis");

const { postReelToInstagram } = require("./instagramService");
const { postReelToFacebook }  = require("./facebookService");
const { uploadShort }         = require("./youtubeShorts");
const { getNextAdBannerUrl }  = require("../controller/adBannerController");
const { TMP, safeDelete }     = require("../utils/fileUtils");

const PLATFORMS  = ["instagram", "facebook", "youtube"];
const POSTED_TTL = 60 * 60 * 24 * 30; // remember posted items for 30 days

// ─────────────────────────────────────────────
// "Already posted" tracking  (key: posted:<platform>:<newsId>)
// ─────────────────────────────────────────────
const postedKey = (platform, id) => `posted:${platform}:${id}`;

async function isPosted(platform, id) {
  try {
    return !!(await redis.get(postedKey(platform, id)));
  } catch (err) {
    console.warn("⚠️  Redis read failed:", err.message);
    return false;
  }
}

async function markPosted(platform, id) {
  try {
    await redis.set(postedKey(platform, id), "1", { ex: POSTED_TTL });
  } catch (err) {
    console.warn("⚠️  Redis write failed:", err.message);
  }
}

// ─────────────────────────────────────────────
// Photo → data URI.
// News CDNs often answer 403 to bare server requests (hot-link protection), so we
// try several header combinations, then a public image proxy as a last resort.
// Returns "" if nothing works – the poster is then drawn without a photo.
// ─────────────────────────────────────────────
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const originOf = (u) => { try { return new URL(u).origin; } catch { return ""; } };
const stripQuery = (u) => u.split("?")[0];

async function downloadImage(url, headers) {
  const { data, headers: h } = await axios.get(url, {
    responseType: "arraybuffer",
    timeout:      15000,
    maxRedirects: 5,
    headers: {
      "User-Agent":      BROWSER_UA,
      Accept:            "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest":  "image",
      "Sec-Fetch-Mode":  "no-cors",
      ...headers,
    },
  });
  const buf = Buffer.from(data);
  if (!buf.length || !String(h["content-type"] || "").startsWith("image/")) {
    throw new Error(`not an image (${h["content-type"]})`);
  }
  return buf;
}

async function imageForCanvas(imageUrl, articleUrl) {
  if (!imageUrl) return "";

  const articleOrigin = originOf(articleUrl);
  const attempts = [
    // 1 — as if the browser loaded it from the article page
    () => downloadImage(imageUrl, articleOrigin ? { Referer: `${articleOrigin}/`, "Sec-Fetch-Site": "cross-site" } : {}),
    // 2 — no Referer at all
    () => downloadImage(imageUrl, {}),
    // 3 — original (uncropped) image without the resize query string
    () => downloadImage(stripQuery(imageUrl), articleOrigin ? { Referer: `${articleOrigin}/` } : {}),
    // 4 — last resort: public image proxy that fetches it for us
    () => downloadImage(`https://images.weserv.nl/?url=${encodeURIComponent(imageUrl)}&w=1600&output=jpg`, {}),
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      const raw = await attempts[i]();
      // normalise to JPEG so the canvas can always decode it
      const jpeg = await sharp(raw).jpeg({ quality: 90 }).toBuffer().catch(() => raw);
      console.log(`🖼️  Image downloaded (attempt ${i + 1})`);
      return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    } catch (err) {
      console.warn(`⚠️  Image attempt ${i + 1} failed: ${err.message}`);
    }
  }
  console.warn("⚠️  Could not download the news image – poster will have no photo");
  return "";
}

// ─────────────────────────────────────────────
// Build poster video and upload it to Cloudinary
// ─────────────────────────────────────────────
async function buildPosterVideo(item) {
  const stamp   = `${String(item.id).slice(0, 8)}-${Date.now()}`;
  const imgFile = path.join(TMP, `poster-${stamp}.png`);
  const vidFile = path.join(TMP, `poster-${stamp}.mp4`);

  try {
    const [hashtags, adBanner, image] = await Promise.all([
      aiService.generateHashtags(`${item.title} ${item.summary || ""}`),
      getNextAdBannerUrl(), // { url, resourceType } | null
      imageForCanvas(item.image, item.link),
    ]);

    const poster = await canvasService.createNewsPoster({
      title:          item.title,
      summary:        item.summary || "",
      image,
      adBannerUrl:    adBanner?.url || null,
      adResourceType: adBanner?.resourceType || null,
    });
    // poster = { type: "image" | "video", buffer, liveAdVideoUrl, adH }

    if (poster.type === "video") {
      // ffmpeg already produced the MP4 inside canvasService
      fs.writeFileSync(vidFile, poster.buffer);
    } else {
      fs.writeFileSync(imgFile, poster.buffer);
      await videoService.convertImageToVideo(imgFile, vidFile, {
        adVideoInput: poster.liveAdVideoUrl || null,
        adH:          poster.adH || null,
      });
    }

    const upload = await cloudinary.uploader.upload(vidFile, {
      resource_type: "video",
      folder:        "news_posters",
    });
    console.log(`🔗 Cloudinary: ${upload.secure_url}`);

    return {
      videoUrl:     upload.secure_url,
      title:        item.title,
      summary:      item.summary || "",
      hashtags,
      source:       item.channel || "",
      adBannerUsed: adBanner?.url ? adBanner.url.split("/").pop() : "none",
    };
  } finally {
    safeDelete(imgFile, vidFile);
  }
}

// ─────────────────────────────────────────────
// Captions
// ─────────────────────────────────────────────
function buildCaptions({ summary, hashtags, source }) {
  const more = "Read more 👉 link in bio";
  const src  = source ? `\nSource: ${source}` : "";
  return {
    instagram: `${summary}\n${more}${src}\n\n${hashtags} #news #india #breakingnews`,
    facebook:  `${summary}\n${more}${src}\n\n${hashtags}`,
    youtube:   `${summary}${src}\n\n${hashtags} #Shorts`,
  };
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Create the poster for `item` and publish it to `platform`.
 * @param {"instagram"|"facebook"|"youtube"} platform
 * @param {{id:string,title:string,summary?:string,image?:string,channel?:string}} item
 */
async function postNewsItem(platform, item) {
  const media    = await buildPosterVideo(item);
  const captions = buildCaptions(media);

  if (platform === "instagram") await postReelToInstagram(media.videoUrl, captions.instagram);
  if (platform === "facebook")  await postReelToFacebook(media.videoUrl, captions.facebook);
  if (platform === "youtube") {
    const ytTitle = `${media.title.replace(/\s+/g, " ").trim().slice(0, 90)} 🔥 #Shorts`;
    await uploadShort(media.videoUrl, ytTitle, captions.youtube);
  }

  await markPosted(platform, item.id);
  return media;
}

module.exports = { PLATFORMS, isPosted, postNewsItem, imageForCanvas };
