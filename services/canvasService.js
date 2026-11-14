const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path = require("path");
const fs   = require("fs");

// ═══════════════════════════════════════════════════════════════
// FONTS
//   Required : server/fonts/Poppins-Bold.ttf
//   Optional : server/fonts/Poppins-Regular.ttf (summary text)
//   Optional : a heavy headline font (thicker title, Malayalam posters)
// ═══════════════════════════════════════════════════════════════
const fontPath = (f) => path.join(__dirname, "../fonts", f);
const firstExisting = (list) => list.map(fontPath).find((p) => fs.existsSync(p));

const boldFont = firstExisting(["Poppins-Bold.ttf"]);
if (boldFont) {
  GlobalFonts.registerFromPath(boldFont, "Malayalam");
  GlobalFonts.registerFromPath(boldFont, "English");
} else {
  console.error("❌ Poppins-Bold.ttf not found in server/fonts");
}

const regularFont = firstExisting([
  "Poppins-Regular.ttf",
  "Poppins-Medium.ttf",
  "NotoSansMalayalam-Regular.ttf",
]);
if (regularFont) GlobalFonts.registerFromPath(regularFont, "BodyReg");
else if (boldFont) GlobalFonts.registerFromPath(boldFont, "BodyReg");

const heavyFont = firstExisting([
  "AnekMalayalam_SemiCondensed-ExtraBold.ttf",
  "AnekMalayalam-ExtraBold.ttf",
  "AnekMalayalam_Condensed-ExtraBold.ttf",
  "Manjari-Bold.ttf",
  "NotoSansMalayalam-Black.ttf",
]);
const hasHeavy = !!heavyFont;
if (hasHeavy) {
  GlobalFonts.registerFromPath(heavyFont, "MalayalamHeavy");
  console.log("[Fonts] heavy headline font:", path.basename(heavyFont));
}

const HEAD_FONT = hasHeavy ? "MalayalamHeavy, Malayalam, English" : "Malayalam, English";
const BOLD_FONT = "Malayalam, English";
const BODY_FONT = "BodyReg, Malayalam, English";

// ═══════════════════════════════════════════════════════════════
// DESIGN  (copied from the reference, 960×1200 → ×1.125)
//
//   frame        red border around the whole poster
//   background   full photo, fading into BLACK at the bottom
//   top-right    logo box (white, red border)
//   middle       round inset photo with white ring (2nd image)
//   badge        "BREAKING" (red) + "NEWS" (blue), slanted, white outline
//   bottom       black area – yellow centred title, LAST word white
//                (optional small white summary under it)
// ═══════════════════════════════════════════════════════════════
const W = 1080;
const H = 1350;                         // 4:5 – same ratio as the reference

const RED    = "#e8141c";
const BLUE   = "#0d4b8c";
const YELLOW = "#fff200";
const WHITE  = "#ffffff";
const BLACK  = "#000000";

const BORDER = 16;                      // red frame thickness

// defaults – change here or pass them in newsItem
const CHANNEL_NAME = process.env.BRAND_NAME || "NEWSLINE24";
const TAG_LEFT     = "BREAKING";
const TAG_RIGHT    = "NEWS";

// logo box (top-right)
const LOGO_X = 892, LOGO_Y = 50, LOGO_W = 153, LOGO_H = 151, LOGO_BORDER = 7;

// round inset photo
const CIRCLE_CX = 540, CIRCLE_CY = 671, CIRCLE_R = 183, CIRCLE_RING = 6;

// breaking-news badge
const BADGE_H     = 52;
const BADGE_SIZE  = 40;
const BADGE_SLANT = 0.2;                // italic / parallelogram lean

// text zone: badge + title + summary are stacked UPWARDS from the bottom,
// so the summary is always fully visible
const TEXT_PAD_X     = 44;              // left/right space for the text
const BOTTOM_PAD     = 38;              // space under the last line (inside frame)
const ZONE_TOP_FREE  = Math.round(H * 0.50);   // highest the badge may go
const BADGE_GAP      = 24;              // badge -> title
const TITLE_SUM_GAP  = 22;              // title -> summary

// title (BIG – shrinks only when the text is long)
const TITLE_MAX       = 82;
const TITLE_MIN       = 36;
const TITLE_LH        = 1.26;
const TITLE_MAX_LINES = 4;
const TITLE_MAX_W     = W - TEXT_PAD_X * 2;

// summary (optional, also big – shrinks together with the title if needed)
const SUM_MAX       = 42;
const SUM_MIN       = 24;
const SUM_LH        = 1.4;
const SUM_MAX_LINES = 5;
const SUM_MAX_W     = W - TEXT_PAD_X * 2;

// photo
const PHOTO_FOCUS_X = 0.5;
const PHOTO_FOCUS_Y = 0.3;
const PHOTO_MAX_H   = Math.round(H * 0.62);   // very tall photos are cropped to this height
const PHOTO_FADE_MAX = 200;                    // length of the fade-to-black (px)

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

async function tryLoad(src, label) {
  if (!src) return null;
  try { return await loadImage(src); }
  catch (e) { console.warn(`[Poster] ${label} failed:`, e.message); return null; }
}

function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width  * scale;
  const dh = img.height * scale;
  const dx = x - Math.max(0, dw - w) * PHOTO_FOCUS_X;
  const dy = y - Math.max(0, dh - h) * PHOTO_FOCUS_Y;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// COPY
//   newsItem.title / headline      the headline (Title Case as given)
//   newsItem.titleLines            force the line breaks
//   newsItem.titleWhiteWords       how many LAST words are white (default 1)
//   newsItem.uppercase = true      UPPER-CASE the headline
//   newsItem.summary               optional small white text under the title
//   ("title | summary" also works)
// ═══════════════════════════════════════════════════════════════
function buildCopy(newsItem) {
  const up = newsItem.uppercase === true;
  const cT = (s) => cleanText(s, up);
  const cS = (s) => cleanText(s, false);

  let titleRaw = joinLines(newsItem.titleLines) || String(newsItem.title || newsItem.headline || "");
  let subRaw   = String(newsItem.summary || newsItem.subtitle || newsItem.description || "");
  let lines    = linesOf(newsItem.titleLines, cT);

  if (!cS(subRaw) && titleRaw.includes("|")) {
    const parts = titleRaw.split("|").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      titleRaw = parts.slice(0, -1).join(" ");
      subRaw   = parts[parts.length - 1];
      lines    = null;
    }
  }

  let title = null;
  const text = cT(titleRaw);
  if (text) {
    const whiteN = Number.isInteger(newsItem.titleWhiteWords) ? newsItem.titleWhiteWords : 1;
    const words  = wordsOf(text).map((t) => ({ t, white: false }));
    for (let i = Math.max(0, words.length - whiteN); i < words.length; i++) words[i].white = true;

    // forced line breaks only when they contain exactly the same words
    let counts = null;
    if (lines) {
      const c = lines.map((l) => wordsOf(l).length);
      if (c.reduce((a, b) => a + b, 0) === words.length) counts = c;
    }
    title = { words, counts };
  }

  const sub = cS(subRaw);
  return { title, sub: sub || null };
}

// ═══════════════════════════════════════════════════════════════
// TITLE LAYOUT  –  words keep their colour, lines are centred
// ═══════════════════════════════════════════════════════════════
const mkLine = (ws, space) => ({
  words: ws,
  w: ws.reduce((a, b) => a + b.w, 0) + space * Math.max(0, ws.length - 1),
});

function wrapMeasured(meas, maxW, space) {
  const lines = [];
  let cur = [];
  let curW = 0;
  for (const w of meas) {
    const add = cur.length ? space + w.w : w.w;
    if (cur.length && curW + add > maxW) {
      lines.push(mkLine(cur, space));
      cur = [w];
      curW = w.w;
    } else {
      cur.push(w);
      curW += add;
    }
  }
  if (cur.length) lines.push(mkLine(cur, space));
  return lines;
}

// same number of lines as greedy wrapping, but with even line lengths
function balancedMeasured(meas, maxW, space) {
  const first = wrapMeasured(meas, maxW, space);
  const n = first.length;
  if (n < 2) return first;
  let lo = maxW * 0.45, hi = maxW;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (wrapMeasured(meas, mid, space).length <= n) hi = mid; else lo = mid;
  }
  return wrapMeasured(meas, hi, space);
}

function layoutTitle(ctx, block, size, maxW, useCounts) {
  ctx.font = `${size}px ${HEAD_FONT}`;
  const space = ctx.measureText(" ").width;
  const meas  = block.words.map((w) => ({ ...w, w: ctx.measureText(w.t).width }));

  let lines;
  if (useCounts && block.counts) {
    let i = 0;
    lines = block.counts.map((c) => {
      const ws = meas.slice(i, i + c);
      i += c;
      return mkLine(ws, space);
    });
  } else {
    lines = balancedMeasured(meas, maxW, space);
  }
  return { lines, space };
}

function fitTitle(ctx, block, maxSize = TITLE_MAX) {
  for (const useCounts of block.counts ? [true, false] : [false]) {
    for (let size = maxSize; size >= TITLE_MIN; size -= 2) {
      const r  = layoutTitle(ctx, block, size, TITLE_MAX_W, useCounts);
      const lh = Math.round(size * TITLE_LH);
      const total = r.lines.length * lh;
      if (r.lines.length <= TITLE_MAX_LINES &&
          r.lines.every((l) => l.w <= TITLE_MAX_W + 1)) {
        return { size, lh, lines: r.lines, space: r.space, total };
      }
    }
  }
  const r  = layoutTitle(ctx, block, TITLE_MIN, TITLE_MAX_W, false);
  const lh = Math.round(TITLE_MIN * TITLE_LH);
  return { size: TITLE_MIN, lh, lines: r.lines, space: r.space, total: r.lines.length * lh };
}

function drawTitle(ctx, L, top) {
  ctx.save();
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font         = `${L.size}px ${HEAD_FONT}`;
  ctx.lineJoin     = "round";
  const thick = hasHeavy ? 0 : L.size * 0.02;

  L.lines.forEach((ln, i) => {
    const base = top + i * L.lh + L.lh / 2 + L.size * 0.34;
    let x = (W - ln.w) / 2;
    ln.words.forEach((w) => {
      const color = w.white ? WHITE : YELLOW;
      if (thick > 0.01) {
        ctx.lineWidth   = thick;
        ctx.strokeStyle = color;
        ctx.strokeText(w.t, x, base);
      }
      ctx.fillStyle = color;
      ctx.fillText(w.t, x, base);
      x += w.w + L.space;
    });
  });
  ctx.restore();
}

// summary (white, centred) – fitted first, drawn later
function fitSummary(ctx, text, maxSize = SUM_MAX) {
  const build = (size) => {
    ctx.font = `${size}px ${BODY_FONT}`;
    const space = ctx.measureText(" ").width;
    const meas  = wordsOf(text).map((t) => ({ t, w: ctx.measureText(t).width }));
    const lines = balancedMeasured(meas, SUM_MAX_W, space);
    const lh    = Math.round(size * SUM_LH);
    return { size, lh, lines, total: lines.length * lh };
  };
  for (let size = maxSize; size >= SUM_MIN; size -= 2) {
    const r = build(size);
    if (r.lines.length <= SUM_MAX_LINES && r.lines.every((l) => l.w <= SUM_MAX_W + 1)) return r;
  }
  return build(SUM_MIN);
}

function drawSummary(ctx, L, top) {
  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font         = `${L.size}px ${BODY_FONT}`;
  ctx.fillStyle    = "rgba(255,255,255,0.95)";
  L.lines.forEach((ln, i) => {
    const t = ln.words.map((w) => w.t).join(" ");
    ctx.fillText(t, W / 2, top + i * L.lh + L.lh / 2 + L.size * 0.34);
  });
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// BACKGROUND  –  photo inside the frame, fading to black
//   newsItem.image / images[0]  : main photo (url / path / buffer)
//   newsItem.showPhoto = false  : no photo
// ═══════════════════════════════════════════════════════════════
function pickMainImage(newsItem) {
  if (Array.isArray(newsItem.images) && newsItem.images.filter(Boolean).length) {
    return newsItem.images.filter(Boolean)[0];
  }
  return newsItem.image || null;
}

// The photo is scaled to the FULL inner width of the poster (nothing is cut
// off on the left/right); its height follows the photo's own ratio and the
// bottom of it fades into black.
function drawBackground(ctx, photo, photoH) {
  const innerW = W - BORDER * 2;

  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, W, H);

  if (photo) {
    drawCover(ctx, photo, BORDER, BORDER, innerW, photoH);
  } else {
    const g = ctx.createLinearGradient(0, BORDER, 0, BORDER + photoH);
    g.addColorStop(0, "#1c3a6e");
    g.addColorStop(1, "#0a1220");
    ctx.fillStyle = g;
    ctx.fillRect(BORDER, BORDER, innerW, photoH);
  }

  // fade into black at the bottom of the photo
  const photoBottom = BORDER + photoH;
  const fadeLen = Math.min(PHOTO_FADE_MAX, Math.round(photoH * 0.40));
  const y0 = photoBottom - fadeLen;
  const fade = ctx.createLinearGradient(0, y0, 0, photoBottom);
  fade.addColorStop(0.00, "rgba(0,0,0,0)");
  fade.addColorStop(0.50, "rgba(0,0,0,0.60)");
  fade.addColorStop(1.00, "rgba(0,0,0,1)");
  ctx.fillStyle = fade;
  ctx.fillRect(BORDER, y0, innerW, photoBottom - y0 + 1);
}

// ═══════════════════════════════════════════════════════════════
// ROUND INSET PHOTO  (newsItem.insetImage, or images[1])
// ═══════════════════════════════════════════════════════════════
async function drawCircle(ctx, newsItem, cy) {
  const src =
    newsItem.insetImage ||
    (Array.isArray(newsItem.images) ? newsItem.images.filter(Boolean)[1] : null);
  const img = await tryLoad(src, "inset photo");
  if (!img) return;

  // white ring + soft shadow
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur  = 24;
  ctx.fillStyle   = WHITE;
  ctx.beginPath();
  ctx.arc(CIRCLE_CX, cy, CIRCLE_R + CIRCLE_RING, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(CIRCLE_CX, cy, CIRCLE_R, 0, Math.PI * 2);
  ctx.clip();
  drawCover(ctx, img, CIRCLE_CX - CIRCLE_R, cy - CIRCLE_R, CIRCLE_R * 2, CIRCLE_R * 2);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// LOGO BOX (top-right)  –  white box, red border,
//   small brand text on top + big red letters (NEWSLINE / 24)
//   newsItem.logo : logo image (url / path / buffer) – used if given
//   newsItem.brandName
// ═══════════════════════════════════════════════════════════════
async function drawLogo(ctx, newsItem) {
  const logo = await tryLoad(newsItem.logo, "logo");

  // red outer box
  ctx.fillStyle = RED;
  ctx.fillRect(LOGO_X, LOGO_Y, LOGO_W, LOGO_H);
  // white inner box
  const ix = LOGO_X + LOGO_BORDER, iy = LOGO_Y + LOGO_BORDER;
  const iw = LOGO_W - LOGO_BORDER * 2, ih = LOGO_H - LOGO_BORDER * 2;
  ctx.fillStyle = WHITE;
  ctx.fillRect(ix, iy, iw, ih);

  if (logo) {
    const s = Math.min((iw - 12) / logo.width, (ih - 12) / logo.height);
    const lw = logo.width * s, lh = logo.height * s;
    ctx.drawImage(logo, ix + (iw - lw) / 2, iy + (ih - lh) / 2, lw, lh);
    return;
  }

  const name = cleanText(newsItem.brandName || CHANNEL_NAME, true);
  if (!name) return;

  // "NEWSLINE24" → small "NEWSLINE", big "24"
  let small = name, big = name[0];
  const m = name.match(/^(\D+?)\s*(\d+)$/);
  if (m) { small = m[1].trim(); big = m[2]; }

  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";

  // small text (fit to width)
  let ss = 24;
  ctx.font = `${ss}px ${BOLD_FONT}`;
  while (ctx.measureText(small).width > iw - 14 && ss > 12) {
    ss -= 1;
    ctx.font = `${ss}px ${BOLD_FONT}`;
  }
  ctx.fillStyle = "#1a1a1a";
  ctx.fillText(small, LOGO_X + LOGO_W / 2, iy + 14 + ss * 0.8);

  // big letters (fit to width)
  let bs = 100;
  ctx.font = `${bs}px ${BOLD_FONT}`;
  while (ctx.measureText(big).width > iw - 16 && bs > 30) {
    bs -= 2;
    ctx.font = `${bs}px ${BOLD_FONT}`;
  }
  const by = iy + ih - 20;
  const grad = ctx.createLinearGradient(0, by - bs * 0.75, 0, by);
  grad.addColorStop(0, "#f2272f");
  grad.addColorStop(1, "#8c0a10");
  ctx.fillStyle = grad;
  ctx.fillText(big, LOGO_X + LOGO_W / 2, by);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// BREAKING NEWS BADGE  –  slanted red + blue boxes, white italic text
//   newsItem.tagLeft  (default "BREAKING")
//   newsItem.tagRight (default "NEWS")
// ═══════════════════════════════════════════════════════════════
function skewText(ctx, text, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.transform(1, 0, -BADGE_SLANT, 1, 0, 0);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawBadge(ctx, newsItem, y0) {
  const left  = cleanText(newsItem.tagLeft  || TAG_LEFT,  true);
  const right = cleanText(newsItem.tagRight || TAG_RIGHT, true);

  ctx.save();
  ctx.font         = `${BADGE_SIZE}px ${BOLD_FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign    = "left";

  const padX = 26;
  const lw = Math.round(ctx.measureText(left).width  + padX * 2);
  const rw = Math.round(ctx.measureText(right).width + padX * 2);
  const total = lw + rw;
  const x0 = Math.round((W - total) / 2);
  const h  = BADGE_H;
  const sl = Math.round(h * BADGE_SLANT);     // horizontal lean of the edges

  // white outline
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  ctx.moveTo(x0 + sl - 3,         y0 - 3);
  ctx.lineTo(x0 + total + sl + 3, y0 - 3);
  ctx.lineTo(x0 + total - sl + 3, y0 + h + 3);
  ctx.lineTo(x0 - sl - 3,         y0 + h + 3);
  ctx.closePath();
  ctx.fill();

  // red part
  ctx.fillStyle = RED;
  ctx.beginPath();
  ctx.moveTo(x0 + sl,      y0);
  ctx.lineTo(x0 + lw + sl, y0);
  ctx.lineTo(x0 + lw - sl, y0 + h);
  ctx.lineTo(x0 - sl,      y0 + h);
  ctx.closePath();
  ctx.fill();

  // blue part
  ctx.fillStyle = BLUE;
  ctx.beginPath();
  ctx.moveTo(x0 + lw + sl,    y0);
  ctx.lineTo(x0 + total + sl, y0);
  ctx.lineTo(x0 + total - sl, y0 + h);
  ctx.lineTo(x0 + lw - sl,    y0 + h);
  ctx.closePath();
  ctx.fill();

  // texts
  const base = y0 + h / 2 + BADGE_SIZE * 0.34;
  ctx.fillStyle = WHITE;
  skewText(ctx, left,  x0 + padX, base);
  skewText(ctx, right, x0 + lw + padX, base);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// RED FRAME  (drawn last, on top of everything)
// ═══════════════════════════════════════════════════════════════
function drawFrame(ctx) {
  ctx.fillStyle = RED;
  ctx.fillRect(0, 0, W, BORDER);                 // top
  ctx.fillRect(0, H - BORDER, W, BORDER);        // bottom
  ctx.fillRect(0, 0, BORDER, H);                 // left
  ctx.fillRect(W - BORDER, 0, BORDER, H);        // right
}

// ═══════════════════════════════════════════════════════════════
// MAIN POSTER DRAW
//
//   newsItem options:
//     title / headline     yellow headline (last word white)
//     titleLines           force the headline line breaks
//     titleWhiteWords      how many LAST words are white (default 1, 0 = none)
//     uppercase true       UPPER-CASE the headline
//     summary              optional small white text under the headline
//     image / images       main photo (url / path / buffer)
//     insetImage           round photo in the middle (or images[1])
//     showPhoto false      no main photo
//     tagLeft / tagRight   badge texts (default BREAKING / NEWS)
//     brandName / logo     top-right logo box (default NEWSLINE24)
// ═══════════════════════════════════════════════════════════════
async function createNewsPoster(newsItem) {
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  const copy = buildCopy(newsItem);

  // 1. PHOTO – full width of the poster, height follows the photo's ratio
  const photo = newsItem.showPhoto !== false
    ? await tryLoad(pickMainImage(newsItem), "photo")
    : null;
  const innerW = W - BORDER * 2;
  let photoH = photo ? Math.round((innerW * photo.height) / photo.width) : Math.round(H * 0.5);
  photoH = Math.min(photoH, PHOTO_MAX_H);
  const photoBottom = BORDER + photoH;

  // 2. LAYOUT – badge + title + summary live in the black area under the photo.
  //    Title and summary start BIG and shrink together only if they do not fit.
  const bottom  = H - BORDER - BOTTOM_PAD;
  const zoneTop = photoBottom - 40;                 // badge may touch the fade
  const zoneH   = bottom - zoneTop;

  let titleL = null, sumL = null, total = 0;
  for (let k = 1; k >= 0.25; k -= 0.04) {
    titleL = copy.title
      ? fitTitle(ctx, copy.title, Math.max(TITLE_MIN, Math.round(TITLE_MAX * k)))
      : null;
    sumL = copy.sub
      ? fitSummary(ctx, copy.sub, Math.max(SUM_MIN, Math.round(SUM_MAX * k)))
      : null;
    total =
      BADGE_H + BADGE_GAP +
      (titleL ? titleL.total : 0) +
      (titleL && sumL ? TITLE_SUM_GAP : 0) +
      (sumL ? sumL.total : 0);
    if (total <= zoneH) break;
  }

  // short text → centre the block in the black area instead of leaving a gap
  const shift = Math.max(0, Math.round((zoneH - total) * 0.5));
  const end   = bottom - shift;

  const sumTop      = end - (sumL ? sumL.total : 0);
  const titleBottom = sumL ? sumTop - TITLE_SUM_GAP : end;
  const titleTop    = titleBottom - (titleL ? titleL.total : 0);
  const badgeY      = titleTop - BADGE_GAP - BADGE_H;

  // 3. draw
  drawBackground(ctx, photo, photoH);

  // round inset photo sits on the main photo
  const circleCy = Math.round(BORDER + photoH * 0.52);
  await drawCircle(ctx, newsItem, circleCy);

  await drawLogo(ctx, newsItem);
  drawBadge(ctx, newsItem, badgeY);

  if (titleL) drawTitle(ctx, titleL, titleTop);
  if (sumL)   drawSummary(ctx, sumL, sumTop);

  drawFrame(ctx);

  // 4. reset
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  const buffer = await canvasToBuffer(canvas, "image/png");
  return { type: "image", buffer, liveAdVideoUrl: null, adH: 0 };
}

module.exports = { createNewsPoster, toNodeBuffer };
