"use strict";

/**
 * News source: Currents API  (https://currentsapi.services)
 *
 *   GET /v1/latest-news?country=IN&category=general&language=en&apiKey=...
 *
 * Every item is normalised to the same shape the rest of the app already uses:
 *   { id, title, summary, image, link, author, channel, icon, readableTime, published }
 */

const axios = require("axios");

const API_URL  = process.env.CURRENTS_API_URL  || "https://api.currentsapi.services/v1/latest-news";
const COUNTRY  = process.env.CURRENTS_COUNTRY  || "IN";
const CATEGORY = process.env.CURRENTS_CATEGORY || "general";
const LANGUAGE = process.env.CURRENTS_LANGUAGE || "en";

// The free plan has a daily request cap, so a short in-memory cache protects it
// (the dashboard + the cron routes would otherwise hit the API on every call).
const CACHE_MS = Number(process.env.NEWS_CACHE_SECONDS || 120) * 1000;
let cache = { at: 0, items: [] };

const hasImage = (url) => /^https?:\/\//i.test(url || "");

// "www.ndtvprofit.com" → "ndtvprofit.com"
function hostOf(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Currents sends "2026-11-10 02:12:47 +0000" – convert to a readable IST string.
function toReadableIst(published = "") {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(published);
  const date = new Date(m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : published);
  if (isNaN(date)) return published;
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalise(raw) {
  const host = hostOf(raw.url);
  return {
    id:           String(raw.id),
    title:        (raw.title || "").replace(/\s+/g, " ").trim(),
    summary:      (raw.description || "").replace(/\s+/g, " ").trim(),
    image:        hasImage(raw.image) ? raw.image : "",
    link:         raw.url || "",
    author:       raw.author || "",
    channel:      host || "News",
    icon:         host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : "",
    readableTime: toReadableIst(raw.published),
    published:    raw.published || "",
  };
}

/** Latest news, newest first. Items without a photo are dropped (the poster needs one). */
async function fetchLatestNews({ force = false } = {}) {
  if (!force && cache.items.length && Date.now() - cache.at < CACHE_MS) {
    return cache.items;
  }

  const apiKey = process.env.CURRENTS_API_KEY;
  if (!apiKey) throw new Error("CURRENTS_API_KEY is not set in .env");

  try {
    const { data } = await axios.get(API_URL, {
      params:  { country: COUNTRY, category: CATEGORY, language: LANGUAGE, apiKey },
      timeout: 15000,
    });

    if (data?.status !== "ok" || !Array.isArray(data.news)) {
      throw new Error(data?.msg || "Unexpected response from Currents API");
    }

    const seen = new Set();
    const all = data.news
      .map(normalise)
      .filter((n) => n.title && !seen.has(n.id) && seen.add(n.id))
      .sort((a, b) => new Date(b.published) - new Date(a.published));

    const withImage = all.filter((n) => n.image);
    cache = { at: Date.now(), items: withImage.length ? withImage : all };
    return cache.items;
  } catch (err) {
    // On a failure (rate limit, network) keep serving the last good result.
    if (cache.items.length) {
      console.warn("⚠️  Currents API failed, serving cached news:", err.message);
      return cache.items;
    }
    throw new Error(`Currents API error: ${err.response?.data?.msg || err.message}`);
  }
}

module.exports = { fetchLatestNews };
