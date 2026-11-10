const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path  = require("path");
const sharp = require("sharp");
const fs    = require("fs");
const os    = require("os");

// fluent-ffmpeg + ffmpeg-static for frame extraction
let ffmpeg;
try {
  ffmpeg = require("fluent-ffmpeg");
  const ffmpegPath  = require("ffmpeg-static");
  const ffprobePath = require("ffprobe-static").path;

  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    ffmpeg.setFfmpegPath(ffmpegPath);
  } else {
    console.error("❌ ffmpeg binary missing:", ffmpegPath);
  }

  if (ffprobePath && fs.existsSync(ffprobePath)) {
    ffmpeg.setFfprobePath(ffprobePath);
  } else {
    console.error("❌ ffprobe binary missing:", ffprobePath);
  }
} catch (err) {
  console.error("[Video] fluent-ffmpeg setup failed:", err.message);
  ffmpeg = null;
}

// ── Fonts ─────────────────────────────────────────────────────
GlobalFonts.registerFromPath(
  path.join(__dirname, "../fonts/LondrinaSolid-Regular.ttf"),
  "Malayalam"
);
GlobalFonts.registerFromPath(
  path.join(__dirname, "../fonts/LondrinaSolid-Regular.ttf"),
  "English"
);

// Optional serif (used for the small "NEWSLINE" label)
const SERIF_CANDIDATES = [
  path.join(__dirname, "../fonts/Serif-Bold.ttf"),
  path.join(__dirname, "../fonts/PlayfairDisplay-Bold.ttf"),
  path.join(__dirname, "../fonts/DejaVuSerif-Bold.ttf"),
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
];
let hasSerif = false;
for (const p of SERIF_CANDIDATES) {
  try {
    if (fs.existsSync(p)) {
      GlobalFonts.registerFromPath(p, "Headline");
      hasSerif = true;
      break;
    }
  } catch (e) {
    console.warn("[Fonts] could not load", p, e.message);
  }
}

// Optional condensed bold sans for the headline (the look in your reference).
// Drop ONE of these into server/fonts/ :  Anton-Regular.ttf  |  Oswald-Bold.ttf  |  BebasNeue-Regular.ttf
const CONDENSED_CANDIDATES = [
  path.join(__dirname, "../fonts/Anton-Regular.ttf"),
  path.join(__dirname, "../fonts/Oswald-Bold.ttf"),
  path.join(__dirname, "../fonts/BebasNeue-Regular.ttf"),
];
let hasCondensed = false;
for (const p of CONDENSED_CANDIDATES) {
  try {
    if (fs.existsSync(p)) {
      GlobalFonts.registerFromPath(p, "Condensed");
      hasCondensed = true;
      break;
    }
  } catch (e) {
    console.warn("[Fonts] could not load", p, e.message);
  }
}

const SERIF_CHAIN = hasSerif ? "Headline, Malayalam, English" : "Malayalam, English";
const HEAD_FONT   = hasCondensed ? "Condensed, Malayalam, English" : SERIF_CHAIN;
const BRAND_FONT  = SERIF_CHAIN;

// ── Asset video path ─────────────────────────────────────────
const FALLBACK_VIDEO_PATH =
  process.env.FALLBACK_VIDEO ||
  path.join(__dirname, "../assets/ad_fallback.mp4");

const W            = 1080;
const H            = 1350;          // 4:5 poster
const DEFAULT_AD_H = 180;
const MAX_AD_H     = 320;

const DEFAULT_CHANNEL = "Newsline";

// Layout
const PAD           = 54;
const HEAD_BOTTOM   = 70;                    // gap under the last headline line
const HEAD_MAX_H    = Math.round(H * 0.36);
const HEAD_START    = 80;
const HEAD_MIN      = 40;
const HEAD_LH       = 1.24;                  // line pitch (leaves a small gap between bars)
const BAR_PAD_X     = 14;                    // highlight bar side padding
const BAR_COLOR     = "#ffe600";             // marker yellow
const BAR_TEXT      = "#000000";

const BRAND_SIZE    = 30;
const BRAND_GAP     = 64;                    // distance from divider line up/down to headline

const BG_COLOR      = "#080c16";
const PHOTO_FADE    = 70;

const MALAYALAM_BOLD_W = 0.055;

function fillTextBold(ctx, text, x, y, fontSize, extraWidth = 0) {
  const lineWidth = fontSize * MALAYALAM_BOLD_W + extraWidth;
  ctx.save();
  ctx.lineJoin    = "round";
  ctx.miterLimit  = 2;
  ctx.lineWidth   = lineWidth;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function computeAdHeight(adImg) {
  if (!adImg) return DEFAULT_AD_H;
  const naturalH = Math.round((adImg.height / adImg.width) * W);
  return Math.min(MAX_AD_H, Math.max(DEFAULT_AD_H, naturalH));
}

function toNodeBuffer(data) {
  if (Buffer.isBuffer(data))       return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data))    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError(`toNodeBuffer: unsupported type ${Object.prototype.toString.call(data)}`);
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return toNodeBuffer(await res.arrayBuffer());
}

async function fetchAsJpegBuffer(url) {
  const raw = await fetchBuffer(url);
  return toNodeBuffer(await sharp(raw).jpeg().toBuffer());
}

async function canvasToBuffer(canvas, mime = "image/png") {
  const result = canvas.toBuffer(mime);
  return Buffer.isBuffer(result) ? result : toNodeBuffer(await result);
}

// ═══════════════════════════════════════════════════════════════
// VIDEO FRAME EXTRACTION
// ═══════════════════════════════════════════════════════════════

function extractVideoFrame(videoPath, atSecond = 1) {
  return new Promise((resolve) => {
    if (!ffmpeg) {
      console.warn("[Video] fluent-ffmpeg not available — skipping frame extract");
      return resolve(null);
    }

    if (!fs.existsSync(videoPath)) {
      console.warn("[Video] File not found:", videoPath);
      return resolve(null);
    }

    try {
      const stat = fs.statSync(videoPath);
      if (stat.size === 0) {
        console.warn("[Video] File is zero bytes:", videoPath);
        return resolve(null);
      }
    } catch (e) {
      console.warn("[Video] Could not stat file:", videoPath, e.message);
      return resolve(null);
    }

    const tmpFile = path.join(os.tmpdir(), `ad_frame_${Date.now()}.png`);
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      console.error("[Video] Frame extraction timed out:", videoPath);
      fs.unlink(tmpFile, () => {});
      finish(null);
    }, 15000);

    ffmpeg(videoPath)
      .on("error", (err) => {
        clearTimeout(timer);
        console.error("[Video] Frame extraction failed:", err.message);
        fs.unlink(tmpFile, () => {});
        finish(null);
      })
      .on("end", async () => {
        clearTimeout(timer);
        try {
          if (!fs.existsSync(tmpFile)) {
            console.error("[Video] Expected frame file was never written:", tmpFile);
            return finish(null);
          }
          const raw     = fs.readFileSync(tmpFile);
          const jpegBuf = toNodeBuffer(await sharp(raw).jpeg().toBuffer());
          fs.unlink(tmpFile, () => {});
          finish(jpegBuf);
        } catch (e) {
          console.error("[Video] Sharp conversion failed:", e.message);
          fs.unlink(tmpFile, () => {});
          finish(null);
        }
      })
      .screenshots({
        timestamps: [atSecond],
        filename:   path.basename(tmpFile),
        folder:     path.dirname(tmpFile),
        size:       `${W}x?`,
      });
  });
}

// ═══════════════════════════════════════════════════════════════
// AD STRIP (unchanged)
// ═══════════════════════════════════════════════════════════════

function drawAdStrip(ctx, adImg, yOffset, adH) {

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, yOffset, W, adH);

  if (adImg) {
    const scale = Math.max(W / adImg.width, adH / adImg.height);
    const drawW = adImg.width  * scale;
    const drawH = adImg.height * scale;
    const drawX = (W - drawW) / 2;
    const drawY = yOffset + (adH - drawH) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, yOffset, W, adH);
    ctx.clip();
    ctx.drawImage(adImg, drawX, drawY, drawW, drawH);
    ctx.restore();

    const lineGrad = ctx.createLinearGradient(0, 0, W, 0);
    lineGrad.addColorStop(0,   "rgba(255,180,0,0)");
    lineGrad.addColorStop(0.2, "rgba(255,180,0,0.8)");
    lineGrad.addColorStop(0.8, "rgba(255,180,0,0.8)");
    lineGrad.addColorStop(1,   "rgba(255,180,0,0)");
    ctx.fillStyle = lineGrad;
    ctx.fillRect(0, yOffset, W, 3);

    return;
  }

  const bg = ctx.createLinearGradient(0, yOffset, 0, yOffset + adH);
  bg.addColorStop(0, "#0d1b4b");
  bg.addColorStop(1, "#091230");
  ctx.fillStyle = bg;
  ctx.fillRect(0, yOffset, W, adH);

  const lineGrad = ctx.createLinearGradient(0, 0, W, 0);
  lineGrad.addColorStop(0,   "rgba(255,180,0,0)");
  lineGrad.addColorStop(0.2, "rgba(255,180,0,1)");
  lineGrad.addColorStop(0.8, "rgba(255,180,0,1)");
  lineGrad.addColorStop(1,   "rgba(255,180,0,0)");

  ctx.fillStyle = lineGrad;
  ctx.fillRect(0, yOffset, W, 3);

  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle   = "#ffffff";
  for (let x = 40; x < W; x += 60) {
    for (let y = yOffset + 20; y < yOffset + adH - 20; y += 40) {
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  ctx.save();
  ctx.font         = "bold 52px English";
  ctx.fillStyle    = "rgba(255,200,60,0.22)";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("📢", W / 2, yOffset + adH / 2 - 8);
  ctx.restore();

  const line1    = "ADVERTISE WITH US";
  const line2    = "Send us a message";
  const LINE_GAP = 58;
  const midY     = yOffset + adH / 2;

  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor  = "rgba(0,0,0,0.8)";
  ctx.shadowBlur   = 14;

  ctx.font      = "42px Malayalam, English";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  fillTextBold(ctx, line1, W / 2, midY - LINE_GAP / 2, 42);

  const goldGrad = ctx.createLinearGradient(0, midY, 0, midY + 50);
  goldGrad.addColorStop(0, "#ffe566");
  goldGrad.addColorStop(1, "#ffaa00");

  ctx.font      = "44px Malayalam, English";
  ctx.fillStyle = goldGrad;
  fillTextBold(ctx, line2, W / 2, midY + LINE_GAP / 2, 44);

  ctx.restore();

  ctx.fillStyle = lineGrad;
  ctx.fillRect(0, yOffset + adH - 3, W, 3);
}

// ═══════════════════════════════════════════════════════════════
// BACKGROUND
// ═══════════════════════════════════════════════════════════════

function drawBackground(ctx) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, W, H);
}

// ═══════════════════════════════════════════════════════════════
// PHOTO
//   Portrait-ish photo  → full-bleed, top-aligned (like the reference);
//                         only the part hidden under the headline is cut.
//   Landscape photo     → shown in FULL (fit to width), centred in the free
//                         space above the headline, edges faded into the
//                         dark background. Never cropped, never blurred.
// ═══════════════════════════════════════════════════════════════

async function drawPhoto(ctx, src, areaBottom) {
  try {
    const img = await loadImage(src);
    const portrait = img.width / img.height < 0.95;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    if (portrait) {
      const scale = Math.max(W / img.width, (H * 0.72) / img.height);
      const dw = img.width  * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (W - dw) / 2, 0, dw, dh);
    } else {
      const areaH = Math.max(100, areaBottom);
      const scale = Math.min(W / img.width, areaH / img.height);
      const dw = img.width  * scale;
      const dh = img.height * scale;
      const dx = (W - dw) / 2;
      const dy = (areaH - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);

      const fade = Math.min(PHOTO_FADE, dh / 3);
      const gTop = ctx.createLinearGradient(0, dy, 0, dy + fade);
      gTop.addColorStop(0, BG_COLOR);
      gTop.addColorStop(1, "rgba(8,12,22,0)");
      ctx.fillStyle = gTop;
      ctx.fillRect(dx, dy, dw, fade);

      const gBot = ctx.createLinearGradient(0, dy + dh - fade, 0, dy + dh);
      gBot.addColorStop(0, "rgba(8,12,22,0)");
      gBot.addColorStop(1, BG_COLOR);
      ctx.fillStyle = gBot;
      ctx.fillRect(dx, dy + dh - fade, dw, fade);
    }

    ctx.restore();
    return true;
  } catch (e) {
    console.warn("[Poster] main photo failed:", e.message);
    return false;
  }
}

function drawFallbackBackground(ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#14305f");
  g.addColorStop(1, BG_COLOR);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// Dark gradient rising from the bottom so the headline is always readable
function drawBottomFade(ctx, fromY) {
  const g = ctx.createLinearGradient(0, fromY, 0, H);
  g.addColorStop(0,    "rgba(0,0,0,0)");
  g.addColorStop(0.35, "rgba(0,0,0,0.7)");
  g.addColorStop(1,    "rgba(0,0,0,0.96)");
  ctx.fillStyle = g;
  ctx.fillRect(0, fromY, W, H - fromY);
}

// ═══════════════════════════════════════════════════════════════
// DIVIDER + CHANNEL LABEL  (thin line, small spaced serif text in the middle)
// ═══════════════════════════════════════════════════════════════

function drawDividerLabel(ctx, label, y) {
  const text = String(label || "").toUpperCase();

  ctx.save();
  ctx.font         = `${BRAND_SIZE}px ${BRAND_FONT}`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  try { ctx.letterSpacing = "5px"; } catch { /* older canvas builds */ }

  const tw   = ctx.measureText(text).width;
  const gap  = 26;
  const left = W / 2 - tw / 2 - gap;
  const right = W / 2 + tw / 2 + gap;

  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(left, y);
  ctx.moveTo(right, y);
  ctx.lineTo(W - PAD, y);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fillText(text, W / 2, y + 1);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// HEADLINE — centred, uppercase, with yellow "marker" bars on important words
//
//   How to mark important words (any of these, they can be combined):
//     1. In the title text:         "Better roads lead to **more accidents**"
//     2. newsItem.highlight array:  ["more accidents", "BJP MP"]  (or one string)
// ═══════════════════════════════════════════════════════════════

function normWord(w) {
  return String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// ── AUTO HIGHLIGHT ──────────────────────────────────────────────
// Picks the most "important" stretch of the headline by itself.
//   • Only the quoted statement is considered (the "...": SPEAKER NAME part is left plain)
//   • Words are scored: numbers > long/rare words > normal words > filler words (0)
//   • The best consecutive window (about 40% of the words) gets the yellow bar
// Turn off per poster with  newsItem.autoHighlight = false
const STOP_WORDS = new Set((
  "a an the and or but if of to in on at by for with from as is are was were be been being " +
  "it its this that these those when while than then so such not no do does did has have had " +
  "will would can could may might shall should into over under about after before more most"
).split(" "));

function autoHighlight(words) {
  if (words.length < 4) return;

  // Eligible range: up to the closing quote mark (if the title is a quote), else everything
  let end = words.length - 1;
  for (let i = 1; i < words.length; i++) {
    if (/[”"]$|[”"][:,;.]?$/.test(words[i].t)) { end = i; break; }
  }
  const n = end + 1;
  if (n < 4) return;

  const weight = words.slice(0, n).map((w) => {
    const nw = normWord(w.t);
    if (!nw) return 0;
    if (/\d/.test(nw)) return 3;                     // numbers / figures
    if (STOP_WORDS.has(nw.toLowerCase())) return 0;  // filler
    if (nw.length >= 7) return 2;                    // long, meaningful words
    return 1;
  });

  const len = Math.max(3, Math.min(8, Math.round(n * 0.4)));
  if (len >= n) return;

  let best = 0, bestScore = -1;
  for (let i = 0; i + len <= n; i++) {
    let s = 0;
    for (let k = 0; k < len; k++) s += weight[i + k];
    // never start or end the bar on a filler word
    if (weight[i] === 0 || weight[i + len - 1] === 0) s -= 2;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  for (let k = 0; k < len; k++) words[best + k].hl = true;
}

function parseHeadline(title, highlight, auto = true) {
  const words = [];
  const parts = String(title || "").replace(/\s+/g, " ").split("**");
  parts.forEach((part, i) => {
    const on = i % 2 === 1;
    part.split(" ").filter(Boolean).forEach((w) => words.push({ t: w.toUpperCase(), hl: on }));
  });

  const phrases = Array.isArray(highlight) ? highlight : highlight ? [highlight] : [];
  for (const phrase of phrases) {
    const pw = String(phrase).split(/\s+/).filter(Boolean).map(normWord);
    if (!pw.length) continue;
    for (let i = 0; i + pw.length <= words.length; i++) {
      if (pw.every((p, k) => normWord(words[i + k].t) === p)) {
        for (let k = 0; k < pw.length; k++) words[i + k].hl = true;
      }
    }
  }

  // Nothing marked by hand (no **..** and no highlight[]) → choose automatically
  if (auto && !words.some((w) => w.hl)) autoHighlight(words);

  return words;
}

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

function layoutHeadline(ctx, words, maxW, maxH) {
  for (let size = HEAD_START; size >= HEAD_MIN; size -= 2) {
    ctx.font = `${size}px ${HEAD_FONT}`;
    const lines = wrapTokens(ctx, words, maxW);
    if (lines.length * Math.round(size * HEAD_LH) <= maxH) return { size, lines };
  }
  const size = HEAD_MIN;
  ctx.font = `${size}px ${HEAD_FONT}`;
  const maxLines = Math.max(1, Math.floor(maxH / Math.round(size * HEAD_LH)));
  return { size, lines: wrapTokens(ctx, words, maxW).slice(0, maxLines) };
}

function drawHeadlineLines(ctx, layout, top) {
  const { size, lines } = layout;
  const lineH = Math.round(size * HEAD_LH);

  ctx.save();
  ctx.font         = `${size}px ${HEAD_FONT}`;
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";
  const space = ctx.measureText(" ").width;

  lines.forEach((ln, i) => {
    const cy     = top + i * lineH + lineH / 2;   // visual centre of this line
    const base   = cy + size * 0.33;              // baseline so caps sit centred
    let x        = (W - ln.width) / 2;

    // 1) yellow bars behind runs of highlighted words
    let k = 0;
    let cx = x;
    while (k < ln.words.length) {
      if (ln.words[k].hl) {
        const startX = cx;
        let runW = 0;
        let j = k;
        while (j < ln.words.length && ln.words[j].hl) {
          runW += ln.words[j].w + (j > k ? space : 0);
          j++;
        }
        ctx.fillStyle = BAR_COLOR;
        ctx.fillRect(startX - BAR_PAD_X, cy - size * 0.56, runW + BAR_PAD_X * 2, size * 1.12);
        // advance cursor over the run
        for (let m = k; m < j; m++) cx += ln.words[m].w + space;
        k = j;
      } else {
        cx += ln.words[k].w + space;
        k++;
      }
    }

    // 2) the words themselves (black on yellow, white otherwise)
    ln.words.forEach((w) => {
      if (w.hl) {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur  = 0;
        ctx.fillStyle   = BAR_TEXT;
      } else {
        ctx.shadowColor   = "rgba(0,0,0,0.55)";
        ctx.shadowBlur    = 8;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle     = "#ffffff";
      }
      ctx.fillText(w.t, x, base);
      x += w.w + space;
    });
  });

  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// MAIN POSTER DRAW
//
// LAYOUT (4:5):
//   1. Photo (full-bleed for portrait photos, fully shown for landscape)
//   2. Dark gradient from the bottom
//   3. Thin divider with small "NEWSLINE" label
//   4. Centred uppercase headline, important words on yellow bars
//   5. Ad strip (unchanged pipeline), appended below the poster
//
//   newsItem options:
//     title         headline (use **word** to mark important words)
//     highlight     string | string[]  phrases to mark as important (optional –
//                   if nothing is marked, the code highlights the key part itself)
//     autoHighlight false to turn the automatic highlight off
//     channelName   label on the divider (default "Newsline")
//     showChannel   false to hide the divider + label
// ═══════════════════════════════════════════════════════════════

async function createNewsPoster(newsItem) {

  // ── Ad pipeline (unchanged) ─────────────────────────────────
  const hasAdUrl  = Boolean(newsItem.adBannerUrl);
  const isVideoAd = newsItem.adResourceType === "video";
  let   adImg     = null;
  let   actualAdH = DEFAULT_AD_H;
  let   liveAdVideoUrl = null;

  if (hasAdUrl && !isVideoAd) {
    try {
      console.log("[Ad] Loading image banner:", newsItem.adBannerUrl);
      const jpegBuf = await fetchAsJpegBuffer(newsItem.adBannerUrl);
      adImg         = await loadImage(jpegBuf);
      actualAdH     = computeAdHeight(adImg);
      console.log(`[Ad] Image banner loaded: ${adImg.width}x${adImg.height}px, strip: ${actualAdH}px`);
    } catch (err) {
      console.error("[Ad] Image banner load failed:", err.message);
    }
  }

  if (!adImg && hasAdUrl && isVideoAd) {
    let tmpVidPath = null;
    try {
      console.log("[Ad] Probing video banner dimensions:", newsItem.adBannerUrl);
      tmpVidPath     = path.join(os.tmpdir(), `ad_video_${Date.now()}.mp4`);
      const vidBuf   = await fetchBuffer(newsItem.adBannerUrl);
      fs.writeFileSync(tmpVidPath, vidBuf);

      const frameBuf = await extractVideoFrame(tmpVidPath, 1);
      if (frameBuf) {
        const probeImg = await loadImage(frameBuf);
        actualAdH      = computeAdHeight(probeImg);
        console.log(`[Ad] Video banner probed: ${probeImg.width}x${probeImg.height}px, strip: ${actualAdH}px`);
      } else {
        console.warn("[Ad] Video banner probe returned null — using default height");
      }
      liveAdVideoUrl = newsItem.adBannerUrl;
    } catch (err) {
      console.error("[Ad] Video banner probe failed:", err.message);
      liveAdVideoUrl = newsItem.adBannerUrl;
    } finally {
      if (tmpVidPath) {
        try { fs.unlinkSync(tmpVidPath); } catch { /* ignore */ }
      }
    }
  }

  if (!adImg && !liveAdVideoUrl) {
    console.log("[Ad] Using local video fallback (live composite):", FALLBACK_VIDEO_PATH);
    try {
      const frameBuf = await extractVideoFrame(FALLBACK_VIDEO_PATH, 1);
      if (frameBuf) {
        const probeImg = await loadImage(frameBuf);
        actualAdH      = computeAdHeight(probeImg);
        console.log(`[Ad] Local fallback probed: ${probeImg.width}x${probeImg.height}px, strip: ${actualAdH}px`);
      } else {
        console.warn("[Ad] Local fallback probe returned null — using default height");
        actualAdH = DEFAULT_AD_H;
      }
      liveAdVideoUrl = FALLBACK_VIDEO_PATH;
    } catch (err) {
      console.error("[Ad] Local fallback error:", err.message);
      actualAdH = DEFAULT_AD_H;
    }
  }

  const canvasH = liveAdVideoUrl ? H : H + actualAdH;
  console.log(`[Canvas] poster=${H}px  adStrip=${actualAdH}px  liveVideoAd=${!!liveAdVideoUrl}  canvasH=${canvasH}px`);

  const canvas = createCanvas(W, canvasH);
  const ctx    = canvas.getContext("2d");

  // ── 1. Background ───────────────────────────────────────────
  drawBackground(ctx);

  // ── 2. Headline layout first (we need its height) ───────────
  const showChannel = newsItem.showChannel !== false;
  const words       = parseHeadline(newsItem.title, newsItem.highlight, newsItem.autoHighlight !== false);
  const headLayout  = layoutHeadline(ctx, words, W - PAD * 2 - BAR_PAD_X * 2, HEAD_MAX_H);
  const headLineH   = Math.round(headLayout.size * HEAD_LH);
  const headTotalH  = headLayout.lines.length * headLineH;
  const headTop     = H - HEAD_BOTTOM - headTotalH;
  const dividerY    = headTop - BRAND_GAP;

  // ── 3. Photo ────────────────────────────────────────────────
  const photoBottom = (showChannel ? dividerY : headTop) - 24;
  const hasPhoto    = await drawPhoto(ctx, newsItem.image, photoBottom);
  if (!hasPhoto) drawFallbackBackground(ctx);

  // ── 4. Gradient, divider + label, headline ──────────────────
  drawBottomFade(ctx, Math.max(H * 0.35, (showChannel ? dividerY : headTop) - 320));
  if (showChannel) drawDividerLabel(ctx, newsItem.channelName || DEFAULT_CHANNEL, dividerY);
  drawHeadlineLines(ctx, headLayout, headTop);

  // ── 5. Reset ────────────────────────────────────────────────
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  // ── 6. Ad strip ─────────────────────────────────────────────
  if (!liveAdVideoUrl) {
    drawAdStrip(ctx, adImg, H, actualAdH);
  }

  const buffer = await canvasToBuffer(canvas, "image/png");
  return { type: "image", buffer, liveAdVideoUrl, adH: actualAdH };
}

module.exports = { createNewsPoster, toNodeBuffer };
