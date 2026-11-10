"use strict";

const axios = require("axios");

const ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID   = process.env.INSTAGRAM_USER_ID;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Caption safety ───────────────────────────────────────────────────────────
function sanitizeCaption(caption) {
  if (!caption) return "";
  let safe = caption.slice(0, 2000);
  const tags = safe.match(/#[\w]+/g) || [];
  if (tags.length > 25) {
    const trimmed = tags.slice(0, 25).join(" ");
    safe = safe.replace(/#[\w]+/g, "") + "\n\n" + trimmed;
  }
  return safe;
}

// ─── Publish with retry ───────────────────────────────────────────────────────
/**
 * Attempts to publish a media container, retrying if Instagram says
 * "media not ready" (error_subcode 2207027).
 *
 * Instead of polling a status endpoint (which requires extra permissions
 * and returns 100/33 on many accounts), we simply retry the publish call
 * itself — Instagram tells us directly whether it's ready or not.
 *
 * @param {string} creationId
 * @param {object} [opts]
 * @param {number} [opts.initialDelayMs=30000]  - Wait before first attempt
 * @param {number} [opts.retryDelayMs=15000]    - Wait between retries
 * @param {number} [opts.maxAttempts=10]        - Max publish attempts
 */
async function publishWithRetry(creationId, opts = {}) {
  const {
    initialDelayMs = 30000,
    retryDelayMs   = 15000,
    maxAttempts    = 10,
  } = opts;

  console.log(`⏳ Waiting ${initialDelayMs / 1000}s for Instagram to process video…`);
  await sleep(initialDelayMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`📤 Publish attempt ${attempt}/${maxAttempts}…`);

      const publishRes = await axios.post(
        `https://graph.facebook.com/v23.0/${IG_USER_ID}/media_publish`,
        {
          creation_id:  creationId,
          access_token: ACCESS_TOKEN,
        }
      );

      console.log("✅ Reel posted:", publishRes.data);
      return publishRes.data;

    } catch (err) {
      const apiErr  = err.response?.data?.error;
      const subcode = apiErr?.error_subcode;
      const code    = apiErr?.code;

      // 2207027 = "media not ready" — safe to retry
      if (subcode === 2207027) {
        console.warn(
          `⚠️  Attempt ${attempt}/${maxAttempts}: media not ready yet, ` +
          `retrying in ${retryDelayMs / 1000}s…`
        );
        if (attempt < maxAttempts) await sleep(retryDelayMs);
        continue;
      }

      // Any other error is not transient — throw immediately
      throw new Error(
        `Publish failed with code ${code}/${subcode}: ${apiErr?.message || err.message}`
      );
    }
  }

  throw new Error(
    `Could not publish container ${creationId} after ${maxAttempts} attempts. ` +
    `Instagram may still be processing — try again later.`
  );
}

// ─── Post Reel ────────────────────────────────────────────────────────────────
async function postReelToInstagram(videoUrl, caption) {
  try {
    console.log("🚀 Starting Instagram Reel upload…");

    const safeCaption = sanitizeCaption(caption);

    // Step 1: Create media container
    const creationRes = await axios.post(
      `https://graph.facebook.com/v23.0/${IG_USER_ID}/media`,
      {
        media_type:    "REELS",
        video_url:     videoUrl,
        caption:       safeCaption,
        share_to_feed: true,
        access_token:  ACCESS_TOKEN,
      }
    );

    const creationId = creationRes.data.id;
    console.log("🎬 Container created:", creationId);

    // Step 2: Publish (retries internally if not ready)
    return await publishWithRetry(creationId);

  } catch (err) {
    console.error(
      "❌ Instagram Reel ERROR:",
      JSON.stringify(err.response?.data, null, 2) || err.message
    );
    throw err;
  }
}

// ─── Post Image ───────────────────────────────────────────────────────────────
async function postImageToInstagram(imageUrl, caption) {
  try {
    console.log("🚀 Starting Instagram Image upload…");
    console.log("🖼️  Image URL:", imageUrl);

    const safeCaption = sanitizeCaption(caption);

    // Step 1: Create media container
    const containerRes = await axios.post(
      `https://graph.facebook.com/v23.0/${IG_USER_ID}/media`,
      {
        image_url:    imageUrl,
        caption:      safeCaption,
        access_token: ACCESS_TOKEN,
      }
    );

    const creationId = containerRes.data.id;
    console.log("🖼️  Instagram image container created:", creationId);

    // Images are near-instant; a small buffer is enough
    await sleep(5000);

    const publishRes = await axios.post(
      `https://graph.facebook.com/v23.0/${IG_USER_ID}/media_publish`,
      {
        creation_id:  creationId,
        access_token: ACCESS_TOKEN,
      }
    );

    console.log("✅ Instagram Image posted:", publishRes.data);
    return publishRes.data;

  } catch (err) {
    console.error(
      "❌ Instagram Image ERROR:",
      err.response?.data || err.message
    );
    throw err;
  }
}

module.exports = { postReelToInstagram, postImageToInstagram };