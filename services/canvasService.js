const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path  = require("path");
const fs    = require("fs");

// ── Fonts ─────────────────────────────────────────────────────
const BASE_FONT_CANDIDATES = [
  path.join(__dirname, "../fonts/Poppins-Bold.ttf"),
  path.join(__dirname, "../fonts/Poppins-Bold.ttf"),
];
const baseFont = BASE_FONT_CANDIDATES.find((f) => fs.existsSync(f));
if (baseFont) {
  GlobalFonts.registerFromPath(baseFont, "Malayalam");
  GlobalFonts.registerFromPath(baseFont, "English");
} else {
  console.error("❌ no base font found in server/fonts");
}

// Optional HEAVY font for the title (thick look of the reference poster).
// Drop ONE of these into server/fonts/ (first one found is used):
const HEAVY_CANDIDATES = [
  "AnekMalayalam_SemiCondensed-ExtraBold.ttf",
  "AnekMalayalam-ExtraBold.ttf",
  "AnekMalayalam_Condensed-ExtraBold.ttf",
  "Manjari-Bold.ttf",
  "NotoSansMalayalam-Black.ttf",
].map((f) => path.join(__dirname, "../fonts", f));

let hasHeavy = false;
for (const p of HEAVY_CANDIDATES) {
  try {
    if (fs.existsSync(p)) {
      GlobalFonts.registerFromPath(p, "MalayalamHeavy");
      hasHeavy = true;
      console.log("[Fonts] heavy headline font:", path.basename(p));
      break;
    }
  } catch (e) {
    console.warn("[Fonts] could not load", p, e.message);
  }
}

const HEAD_FONT = hasHeavy ? "MalayalamHeavy, Malayalam, English" : "Malayalam, English";
const SUM_FONT  = hasHeavy ? "MalayalamHeavy, Malayalam, English" : "Malayalam, English";

// Poster size. Taller poster = more room for the photo.
//   1350 = 4:5   |   1620 = 2:3 (default)   |   1920 = 9:16
const W = 1080;
const H = 1620;

// ═══════════════════════════════════════════════════════════════
// DESIGN CONSTANTS  (layout copied from the reference image)
//
//   top        TITLE   – centred, bold. Red lines, LAST line black
//   middle     PHOTO   – full width, melting into WHITE at the bottom
//                        (several images → collage: 1 big left, 2 stacked right)
//   bottom     SUMMARY – first line white text on a RED box,
//                        remaining lines black text on white
//   footer     brand logo / name on the left + dashed line to the right
//   background plain white
// ═══════════════════════════════════════════════════════════════

const WHITE = "#ffffff";
const BLACK = "#0b0b0b";
const RED   = "#cc0a14";

// Title
const TITLE_PAD_TOP    = 34;
const TITLE_PAD_BOTTOM = 26;
const TITLE_MAX_W      = Math.round(W * 0.93);
const TITLE_MAX        = 92;
const TITLE_MIN        = 38;
const TITLE_LH         = 1.22;
const TITLE_MAX_LINES  = 4;
const TITLE_MAX_H      = Math.round(H * 0.27);   // title block never taller than this

// Photo
const PHOTO_MIN_H     = Math.round(H * 0.28);    // photo is never smaller than this
const PHOTO_OVERLAP   = 30;                      // photo runs this far behind the summary
const PHOTO_FADE_FRAC = 0.22;                    // fade-to-white = 22% of photo height
const PHOTO_FADE_MAX  = 220;                     // ...but never longer than this (px)
const PHOTO_GAP       = 4;                       // white gap between collage images
const PHOTO_FOCUS_Y   = 0.2;                     // 0 = keep top of photo, 1 = keep bottom

// Summary
const SUM_MAX_W     = Math.round(W * 0.95);
const SUM_MAX       = 88;
const SUM_MIN       = 52;
const SUM_LH        = 1.24;
const SUM_MAX_LINES = 6;
const BOX_PAD_X     = 16;                        // red box padding left/right

// Footer
const FOOTER_H      = 100;                       // space reserved at the bottom
const FOOTER_PAD_X  = 28;
const BRAND_NAME    = process.env.BRAND_NAME || "NEWSLINE24";

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function toNodeBuffer(data) {
  if (Buffer.isBuffer(data))       return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data))    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError(`toNodeBuffer: unsupported type ${Object.prototype.toString.call(data)}`);
}

async function canvasToBuffer(canvas, mime = "image/png") {
  const result = canvas.toBuffer(mime);
  return Buffer.isBuffer(result) ? result : toNodeBuffer(await result);
}

// ═══════════════════════════════════════════════════════════════
// TEXT CLEANING  –  what goes in the TITLE and what goes in the SUMMARY
//
//   newsItem.title                  → top title
//   newsItem.summary                → bottom summary
//        (fallbacks: subtitle, description, summaryLines, subTitleLines)
//   newsItem.title = "title | summary"  also works when no summary is given
//   newsItem.titleLines / summaryLines  force the line breaks
//   newsItem.uppercase = true       upper-case everything (English posts)
// ═══════════════════════════════════════════════════════════════

function cleanText(s, upper) {
  const t = String(s ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return upper ? t.toUpperCase() : t;
}

const wordsOf = (s) => String(s).split(" ").filter(Boolean);

function joinLines(v) {
  return Array.isArray(v)
    ? v.map((l) => (typeof l === "string" ? l : l && l.text)).filter(Boolean).join(" ")
    : String(v ?? "");
}

function linesOf(v, c) {
  if (!Array.isArray(v)) return null;
  const out = v.map((l) => c(typeof l === "string" ? l : l && l.text)).filter(Boolean);
  return out.length ? out : null;
}

// → { head: {text, lines|null} | null, sub: {text, lines|null} | null }
function buildCopy(newsItem) {
  const up = newsItem.uppercase === true;
  const c  = (s) => cleanText(s, up);

  const mk = (text, lines) => {
    const t = c(text);
    return t ? { text: t, lines: lines && lines.length ? lines : null } : null;
  };

  let titleRaw = joinLines(newsItem.titleLines) || String(newsItem.title || "");
  let subRaw   =
    joinLines(newsItem.summaryLines) ||
    String(newsItem.summary || "") ||
    joinLines(newsItem.subTitleLines) ||
    String(newsItem.subtitle || "") ||
    String(newsItem.description || "");

  let titleLines = linesOf(newsItem.titleLines, c);
  let subLines   = linesOf(newsItem.summaryLines || newsItem.subTitleLines, c);

  // "title | summary"
  if (!c(subRaw) && titleRaw.includes("|")) {
    const parts = titleRaw.split("|").map(c).filter(Boolean);
    if (parts.length >= 2) {
      titleRaw   = parts.slice(0, -1).join(" ");
      subRaw     = parts[parts.length - 1];
      titleLines = null;
    }
  }

  const head = mk(titleRaw, titleLines);
  const sub  = mk(subRaw, subLines);

  // only a summary was given → show it as the title
  if (!head && sub) return { head: mk(subRaw, subLines), sub: null };
  return { head, sub };
}

// ═══════════════════════════════════════════════════════════════
// LINE WRAPPING + FITTING
// ═══════════════════════════════════════════════════════════════

function wrapTokens(ctx, words, maxW) {
  const space = ctx.measureText(" ").width;
  const lines = [];
  let cur = [];
  let curW = 0;
  for (const w of words) {
    const ww = ctx.measureText(w.t).width;
    const add = cur.length ? space + ww : ww;
    if (cur.length && curW + add > maxW) {
      lines.push({ words: cur, width: curW });
      cur = [{ ...w, w: ww }];
      curW = ww;
    } else {
      cur.push({ ...w, w: ww });
      curW += add;
    }
  }
  if (cur.length) lines.push({ words: cur, width: curW });
  return lines;
}

// Same number of lines as greedy wrapping, but with even line lengths
function balancedWrap(ctx, words, maxW) {
  const first = wrapTokens(ctx, words, maxW);
  const n = first.length;
  if (n < 2) return first;

  let lo = maxW * 0.45, hi = maxW;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (wrapTokens(ctx, words, mid).length <= n) hi = mid; else lo = mid;
  }
  return wrapTokens(ctx, words, hi);
}

// Lays one block out at one font size.
// Fixed lines (from the caller) are kept; otherwise it wraps by itself.
function layoutBlock(ctx, block, size, font, maxW, maxLines) {
  ctx.font = `${size}px ${font}`;
  let lines;
  if (block.lines) {
    lines = block.lines.map((t) => ({ t, w: ctx.measureText(t).width }));
  } else {
    const toks = wordsOf(block.text).map((t) => ({ t }));
    lines = balancedWrap(ctx, toks, maxW).map((l) => ({
      t: l.words.map((w) => w.t).join(" "),
      w: l.width,
    }));
  }
  const ok = lines.length <= maxLines && lines.every((l) => l.w <= maxW + 1);
  return { lines, ok };
}

// Biggest font size where the block fits the width, the line count AND the height
function fitBlock(ctx, block, font, o) {
  for (let size = o.max; size >= o.min; size -= 2) {
    const r  = layoutBlock(ctx, block, size, font, o.maxW, o.maxLines);
    const lh = Math.round(size * o.lh);
    const total = r.lines.length * lh;
    if (r.ok && total <= o.maxH) return { size, lh, lines: r.lines, total };
  }
  return null;
}

function fitWithFallback(ctx, block, font, o) {
  let res = fitBlock(ctx, block, font, o);
  if (!res && block.lines) res = fitBlock(ctx, { text: block.text, lines: null }, font, o);
  if (res) return res;

  // nothing fits (a very long text): smallest size, any number of lines
  const r  = layoutBlock(ctx, { text: block.text, lines: null }, o.min, font, o.maxW, 99);
  const lh = Math.round(o.min * o.lh);
  return { size: o.min, lh, lines: r.lines, total: r.lines.length * lh };
}

// ═══════════════════════════════════════════════════════════════
// TEXT DRAWING
// ═══════════════════════════════════════════════════════════════

function strokeFill(ctx, text, x, y, fill, strokeColor, strokeW) {
  ctx.save();
  ctx.lineJoin   = "round";
  ctx.miterLimit = 2;
  if (strokeW > 0.01) {
    ctx.lineWidth   = strokeW;
    ctx.strokeStyle = strokeColor;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// TITLE: red lines, the last line(s) black
function drawTitle(ctx, L, top, blackCount) {
  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font         = `${L.size}px ${HEAD_FONT}`;

  const thick = hasHeavy ? 0 : L.size * 0.03;     // thicken the normal font a little
  const n     = L.lines.length;

  L.lines.forEach((ln, i) => {
    const color = i >= n - blackCount ? BLACK : RED;
    const base  = top + i * L.lh + L.lh / 2 + L.size * 0.33;
    strokeFill(ctx, ln.t, W / 2, base, color, color, thick);
  });

  ctx.restore();
}

// SUMMARY: first line(s) white on a red box, the rest black on white
function drawSummary(ctx, L, top, highlightCount) {
  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font         = `${L.size}px ${SUM_FONT}`;

  const thick = hasHeavy ? 0 : L.size * 0.012;

  L.lines.forEach((ln, i) => {
    const cy   = top + i * L.lh + L.lh / 2;
    const base = cy + L.size * 0.33;

    if (i < highlightCount) {
      const bw = Math.min(W - 24, ln.w + BOX_PAD_X * 2);
      const bh = L.lh * 0.96;
      ctx.fillStyle = RED;
      ctx.fillRect(Math.round((W - bw) / 2), Math.round(cy - bh / 2), Math.round(bw), Math.round(bh));
      strokeFill(ctx, ln.t, W / 2, base, WHITE, WHITE, thick);
    } else {
      strokeFill(ctx, ln.t, W / 2, base, BLACK, BLACK, thick);
    }
  });

  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// PHOTO  –  full width under the title, fading into WHITE at the bottom
//   newsItem.image   : one photo (url / path / buffer)
//   newsItem.images  : up to 3 photos → collage
//                      2 = side by side, 3 = 1 big left + 2 stacked right
//   newsItem.showPhoto = false → no photo
// ═══════════════════════════════════════════════════════════════

function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width  * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y - Math.max(0, dh - h) * PHOTO_FOCUS_Y;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

async function loadAll(sources) {
  const out = [];
  for (const s of sources) {
    try {
      out.push(await loadImage(s));
    } catch (e) {
      console.warn("[Poster] photo failed:", e.message);
    }
  }
  return out;
}

async function drawPhoto(ctx, sources, top, photoH) {
  const imgs = await loadAll(sources.slice(0, 3));
  if (!imgs.length) return false;

  const g  = PHOTO_GAP;
  const hw = Math.floor((W - g) / 2);
  const hh = Math.floor((photoH - g) / 2);

  if (imgs.length === 1) {
    drawCover(ctx, imgs[0], 0, top, W, photoH);
  } else if (imgs.length === 2) {
    drawCover(ctx, imgs[0], 0,       top, hw,          photoH);
    drawCover(ctx, imgs[1], hw + g,  top, W - hw - g,  photoH);
  } else {
    drawCover(ctx, imgs[0], 0,       top,          hw,          photoH);
    drawCover(ctx, imgs[1], hw + g,  top,          W - hw - g,  hh);
    drawCover(ctx, imgs[2], hw + g,  top + hh + g, W - hw - g,  photoH - hh - g);
  }

  // fade to white at the bottom
  const fadeLen   = Math.min(PHOTO_FADE_MAX, Math.max(120, Math.round(photoH * PHOTO_FADE_FRAC)));
  const fadeStart = top + photoH - fadeLen;
  const fade = ctx.createLinearGradient(0, fadeStart, 0, top + photoH);
  fade.addColorStop(0.00, "rgba(255,255,255,0)");
  fade.addColorStop(0.30, "rgba(255,255,255,0.18)");
  fade.addColorStop(0.55, "rgba(255,255,255,0.50)");
  fade.addColorStop(0.80, "rgba(255,255,255,0.85)");
  fade.addColorStop(1.00, "rgba(255,255,255,1)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, fadeStart, W, top + photoH - fadeStart + 1);

  return true;
}

// ═══════════════════════════════════════════════════════════════
// FOOTER  –  brand logo / name on the left + dashed line to the right
//   newsItem.logo       : logo image (url / path / buffer)  – used if given
//   newsItem.brandName  : text brand (default: NEWSLINE24, or env BRAND_NAME)
// ═══════════════════════════════════════════════════════════════

async function drawFooter(ctx, newsItem) {
  const cy = H - Math.round(FOOTER_H * 0.56);
  let   endX = FOOTER_PAD_X;

  let logo = null;
  if (newsItem.logo) {
    try { logo = await loadImage(newsItem.logo); }
    catch (e) { console.warn("[Poster] logo failed:", e.message); }
  }

  if (logo) {
    const lh = 56;
    const lw = Math.min(320, Math.round((logo.width / logo.height) * lh));
    const h2 = Math.round((logo.height / logo.width) * lw);
    ctx.drawImage(logo, FOOTER_PAD_X, cy - h2 / 2, lw, h2);
    endX = FOOTER_PAD_X + lw;
  } else {
    const name  = cleanText(newsItem.brandName || BRAND_NAME, true);
    if (name) {
      let first, rest, joiner = " ";
      const parts = name.split(" ");
      const m = parts.length === 1 && name.match(/^(\D+)(\d+)$/);
      if (m) {                       // "NEWSLINE24" → NEWSLINE (red) + 24 (black)
        first = m[1]; rest = m[2]; joiner = "";
      } else {
        first = parts[0];
        rest  = parts.slice(1).join(" ");
      }
      const size  = 46;

      ctx.save();
      ctx.textAlign    = "left";
      ctx.textBaseline = "alphabetic";
      ctx.font         = `${size}px English, Malayalam`;
      const base = cy + size * 0.33;

      let x = FOOTER_PAD_X;
      strokeFill(ctx, first, x, base, RED, RED, size * 0.03);
      x += ctx.measureText(first).width;
      if (rest) {
        if (joiner) x += ctx.measureText(joiner).width;
        strokeFill(ctx, rest, x, base, BLACK, BLACK, size * 0.03);
        x += ctx.measureText(rest).width;
      }
      ctx.restore();
      endX = x;
    }
  }

  // dashed line
  ctx.save();
  ctx.strokeStyle = "#555555";
  ctx.lineWidth   = 2;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(endX + 18, cy);
  ctx.lineTo(W - FOOTER_PAD_X, cy);
  ctx.stroke();
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// MAIN POSTER DRAW
//
//   newsItem options:
//     title                 top title (red lines, last line black)
//     summary               bottom summary (first line white on red box)
//     titleLines            force the title line breaks
//     summaryLines          force the summary line breaks
//     titleBlackLines       how many LAST title lines are black (default 1)
//     summaryHighlightLines how many FIRST summary lines get the red box (default 1)
//     uppercase   true      upper-case all text
//     showPhoto   false     no photo
//     image / images        photo(s): url / path / buffer (images = collage, max 3)
//     logo / brandName      footer brand
// ═══════════════════════════════════════════════════════════════

async function createNewsPoster(newsItem) {

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  // ── 1. White background ─────────────────────────────────────
  ctx.fillStyle = WHITE;
  ctx.fillRect(0, 0, W, H);

  // ── 2. Measure: title (top) and summary (bottom) ────────────
  const copy = buildCopy(newsItem);

  let titleL = null;
  let titleBottom = 0;
  if (copy.head) {
    titleL = fitWithFallback(ctx, copy.head, HEAD_FONT, {
      max: TITLE_MAX, min: TITLE_MIN, lh: TITLE_LH,
      maxW: TITLE_MAX_W, maxLines: TITLE_MAX_LINES, maxH: TITLE_MAX_H,
    });
    titleBottom = TITLE_PAD_TOP + titleL.total + TITLE_PAD_BOTTOM;
  }

  const contentBottom = H - FOOTER_H;
  let sumL   = null;
  let sumTop = contentBottom;
  if (copy.sub) {
    const availH = contentBottom - titleBottom - PHOTO_MIN_H;
    sumL = fitWithFallback(ctx, copy.sub, SUM_FONT, {
      max: SUM_MAX, min: SUM_MIN, lh: SUM_LH,
      maxW: SUM_MAX_W, maxLines: SUM_MAX_LINES, maxH: Math.max(availH, SUM_MIN * SUM_LH),
    });
    sumTop = contentBottom - sumL.total;
  }

  // ── 3. Photo(s) between the title and the summary ───────────
  const photoTop = titleBottom;
  const photoEnd = sumL ? sumTop + PHOTO_OVERLAP : contentBottom;
  const photoH   = Math.max(100, photoEnd - photoTop);

  const sources = [];
  if (Array.isArray(newsItem.images)) sources.push(...newsItem.images.filter(Boolean));
  else if (newsItem.image) sources.push(newsItem.image);
  if (!sources.length && newsItem.image) sources.push(newsItem.image);

  if (newsItem.showPhoto !== false && sources.length) {
    await drawPhoto(ctx, sources, photoTop, photoH);
  }

  // ── 4. Title, summary, footer ───────────────────────────────
  if (titleL) {
    const blackCount = titleL.lines.length > 1
      ? Math.min(Number.isInteger(newsItem.titleBlackLines) ? newsItem.titleBlackLines : 1, titleL.lines.length - 1)
      : 0;
    drawTitle(ctx, titleL, TITLE_PAD_TOP, blackCount);
  }

  if (sumL) {
    const hl = Number.isInteger(newsItem.summaryHighlightLines) ? newsItem.summaryHighlightLines : 1;
    drawSummary(ctx, sumL, sumTop, hl);
  }

  await drawFooter(ctx, newsItem);

  // ── 5. Reset ────────────────────────────────────────────────
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  const buffer = await canvasToBuffer(canvas, "image/png");
  // no ad strip any more: liveAdVideoUrl is always null, adH is 0
  return { type: "image", buffer, liveAdVideoUrl: null, adH: 0 };
}

module.exports = { createNewsPoster, toNodeBuffer };
