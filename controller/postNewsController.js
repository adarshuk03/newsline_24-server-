"use strict";

/**
 * Auto-post routes (hit by cron):
 *   GET /api/post-instagram → AI picks the most viral fresh story, posts 1 reel
 *   GET /api/post-facebook  → posts the 2 newest fresh stories
 *   GET /api/post-youtube   → posts the 2 newest fresh stories
 *
 * "Fresh" = not yet posted to that platform (tracked in Redis).
 */

const newsService = require("../services/newsServices");
const aiService   = require("../services/aiService");
const { isPosted, postNewsItem } = require("../services/postService");

const CANDIDATES = 10; // how many of the latest stories are considered

function makeAutoPoster(platform, { count, aiPick = false }) {
  return async (req, res) => {
    console.log(`🕒 ${platform.toUpperCase()} POST HIT:`, new Date().toISOString());

    try {
      const latest = (await newsService.fetchLatestNews()).slice(0, CANDIDATES);
      const flags  = await Promise.all(latest.map((n) => isPosted(platform, n.id)));
      const fresh  = latest.filter((_, i) => !flags[i]);

      if (!fresh.length) {
        return res.json({ message: "⏭️ Skipped — nothing new to post", platform, results: [] });
      }

      const chosen = aiPick
        ? [fresh[await aiService.pickMostViralIndex(fresh)]]
        : fresh.slice(0, count);

      const settled = await Promise.allSettled(chosen.map((item) => postNewsItem(platform, item)));

      const results = settled.map((r, i) => {
        const ok = r.status === "fulfilled";
        console.log(ok ? `✅ ${platform} posted: ${chosen[i].title}` : `❌ ${platform} failed: ${r.reason?.message}`);
        return {
          source:       chosen[i].channel,
          title:        chosen[i].title,
          videoUrl:     ok ? r.value.videoUrl : null,
          adBannerUsed: ok ? r.value.adBannerUsed : null,
          status:       r.status,
          error:        ok ? null : r.reason?.message ?? null,
        };
      });

      return res.json({ message: `✅ ${platform} posting complete`, platform, results });
    } catch (err) {
      console.error(`❌ ${platform} auto-post error:`, err.message);
      return res.status(500).json({ error: "Failed", details: err.message });
    }
  };
}

exports.postToInstagram = makeAutoPoster("instagram", { count: 1, aiPick: true });
exports.postToFacebook  = makeAutoPoster("facebook",  { count: 2 });
exports.postToYoutube   = makeAutoPoster("youtube",   { count: 2 });
