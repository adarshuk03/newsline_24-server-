"use strict";

const newsService = require("../services/newsServices");
const { PLATFORMS, isPosted, postNewsItem } = require("../services/postService");

// ─── GET /api/news/list  (?refresh=1 bypasses the short cache) ───────────────
exports.getNewsList = async (req, res) => {
  try {
    const news = await newsService.fetchLatestNews({ force: req.query.refresh === "1" });
    return res.json({ news, total: news.length });
  } catch (err) {
    console.error("❌ getNewsList error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ─── GET /api/news/post-status?ids=abc,def ───────────────────────────────────
exports.getPostStatus = async (req, res) => {
  try {
    const ids = (req.query.ids || "").split(",").filter(Boolean);

    const entries = await Promise.all(
      ids.map(async (id) => {
        const [instagram, facebook, youtube] = await Promise.all(
          PLATFORMS.map((p) => isPosted(p, id))
        );
        return [id, { instagram, facebook, youtube }];
      })
    );

    return res.json({ statuses: Object.fromEntries(entries) });
  } catch (err) {
    console.error("❌ getPostStatus error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ─── POST /api/news/post-item ────────────────────────────────────────────────
// Body: { newsId, platform, title, summary, image, channel }
exports.postNewsItem = async (req, res) => {
  const { newsId, platform, title, summary, image, channel } = req.body;

  if (!newsId || !platform || !title) {
    return res.status(400).json({ error: "newsId, platform and title are required." });
  }
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `Invalid platform. Must be one of: ${PLATFORMS.join(", ")}.` });
  }
  if (await isPosted(platform, newsId)) {
    return res.status(409).json({ error: `Already posted to ${platform}.`, posted: true });
  }

  try {
    console.log(`🚀 Posting [${platform}] | ${channel} | ${title.slice(0, 60)}`);
    // the cached list knows the article link (used as Referer when downloading the photo)
    const known = (await newsService.fetchLatestNews().catch(() => [])).find((n) => n.id === newsId);
    const media = await postNewsItem(platform, { id: newsId, title, summary, image, channel, link: known?.link || "" });
    return res.json({ success: true, platform, newsId, videoUrl: media.videoUrl });
  } catch (err) {
    console.error(`❌ postNewsItem [${platform}] error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
};
