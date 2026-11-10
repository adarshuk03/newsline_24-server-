"use strict";

const openai = require("../config/openai");

const MODEL = "openai/gpt-oss-120b"; // Groq

/** Pull the first {...} block out of a model reply and parse it. */
function parseJsonObject(text = "") {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in AI reply");
  return JSON.parse(m[0]);
}

/**
 * Instagram hashtags (English).
 */
exports.generateHashtags = async (topic) => {
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: "You generate Instagram hashtags for news posts." },
        {
          role: "user",
          content: `
Generate 15-20 Instagram hashtags based on this topic.

Rules:
- English hashtags only
- Include:
  • 2 news-related
  • 2 if any specified names
  • 2 topic-specific
  • 2 India/location hashtags
- Avoid spam (#followforfollow etc)
- Output ONLY hashtags in one line

Topic: ${topic}
          `.trim(),
        },
      ],
    });
    return res.choices[0].message.content.trim();
  } catch (err) {
    console.error("❌ Groq hashtag error:", err.message);
    return "#news #india #breakingnews #latestnews #trending";
  }
};

/**
 * From a list of news items, return the index with the highest viral potential.
 * Falls back to 0 if the AI answer is unusable.
 */
exports.pickMostViralIndex = async (items) => {
  if (items.length <= 1) return 0;

  const list = items
    .map((n, i) => `Index ${i}:\nSource: ${n.channel}\nTitle: ${n.title}\nSummary: ${(n.summary || "").slice(0, 200)}`)
    .join("\n\n");

  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `You are a viral social media expert specializing in Indian news for Instagram Reels.
Pick the single news item that will get the HIGHEST reach and engagement.

Prioritize:
- Breaking news or shocking revelations
- Stories affecting many people (politics, economy, disasters, crimes)
- Emotional or human interest stories
- Trending topics or controversial events
- Celebrity / film / sports news

Respond with ONLY the index number (e.g., 4) — nothing else.`,
        },
        { role: "user", content: `Pick the best index:\n\n${list}\n\nRespond with ONLY the index number.` },
      ],
    });

    const idx = parseInt(res.choices[0].message.content.trim(), 10);
    return Number.isInteger(idx) && idx >= 0 && idx < items.length ? idx : 0;
  } catch (err) {
    console.warn("⚠️  AI selection failed, using newest item:", err.message);
    return 0;
  }
};
