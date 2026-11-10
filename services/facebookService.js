const axios = require("axios");

const PAGE_ID           = process.env.FB_PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkVideoStatus(videoId) {
  const res = await axios.get(`https://graph.facebook.com/v25.0/${videoId}`, {
    params: { fields: "status,permalink_url", access_token: PAGE_ACCESS_TOKEN },
  });
  return res.data;
}

/**
 * Post a video as a Facebook Reel using the 3-phase upload flow.
 * @param {string} videoUrl  Public Cloudinary URL
 * @param {string} caption
 */
async function postReelToFacebook(videoUrl, caption) {
  console.log("📤 Starting Facebook Reel upload...");

  // Phase 1 — Start
  const startRes = await axios.post(
    `https://graph.facebook.com/v25.0/${PAGE_ID}/video_reels`,
    { upload_phase: "start", access_token: PAGE_ACCESS_TOKEN }
  );

  const { upload_url: uploadUrl, video_id: videoId } = startRes.data;
  console.log("✅ Upload URL received");

  // Phase 2 — Download + upload video bytes
  const videoRes    = await axios.get(videoUrl, { responseType: "arraybuffer" });
  const videoBuffer = Buffer.from(videoRes.data);
  const videoSize   = videoBuffer.length;

  await axios.post(uploadUrl, videoBuffer, {
    headers: {
      Authorization:    `OAuth ${PAGE_ACCESS_TOKEN}`,
      offset:           "0",
      file_size:        String(videoSize),
      "Content-Type":   "application/octet-stream",
      "Content-Length": String(videoSize),
    },
    maxBodyLength:   Infinity,
    maxContentLength: Infinity,
  });

  console.log("✅ Video bytes uploaded");

  // Phase 3 — Finish + publish
  const finishRes = await axios.post(
    `https://graph.facebook.com/v25.0/${PAGE_ID}/video_reels`,
    {
      upload_phase: "finish",
      video_id:     videoId,
      description:  caption,
      published:    true,
      video_state:  "PUBLISHED",
      privacy:      { value: "EVERYONE" },
      access_token: PAGE_ACCESS_TOKEN,
    }
  );

  console.log("✅ Facebook Reel submitted:", finishRes.data);

  // Poll until fully published
  let publishingStatus = "not_started";
  let data;

  while (publishingStatus !== "complete") {
    await sleep(8000);
    data = await checkVideoStatus(videoId);

    const { status } = data;
    console.log("📊 Video status:", status.video_status);
    console.log("Uploading:", status.uploading_phase?.status);
    console.log("Processing:", status.processing_phase?.status);
    console.log("Publishing:", status.publishing_phase?.status);

    publishingStatus = status.publishing_phase?.status;
  }

  console.log("🎉 Reel fully published!");

  const reelUrl = data.permalink_url.startsWith("http")
    ? data.permalink_url
    : `https://www.facebook.com${data.permalink_url}`;

  console.log("🔗 Reel URL:", reelUrl);

  return { postId: finishRes.data.post_id, videoId, reelUrl };
}

module.exports = { postReelToFacebook };