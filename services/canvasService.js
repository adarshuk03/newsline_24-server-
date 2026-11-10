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
  path.join(__dirname, "../fonts/AnekMalayalam-Bold.ttf"),
  "Malayalam"
);
GlobalFonts.registerFromPath(
  path.join(__dirname, "../fonts/DejaVuSans-Bold.ttf"),
  "English"
);

// Optional serif for the newspaper look (brand name + headline).
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

const HEAD_FONT = hasSerif ? "Headline, Malayalam, English" : "Malayalam, English";

// ── Asset video path ─────────────────────────────────────────
const FALLBACK_VIDEO_PATH =
  process.env.FALLBACK_VIDEO ||
  path.join(__dirname, "../assets/ad_fallback.mp4");

const W            = 1080;
const H            = 1350;          // 4:5 poster
const DEFAULT_AD_H = 180;
const MAX_AD_H     = 320;

const DEFAULT_CHANNEL = "Newsline 24";

// Layout
const PAD           = 60;
const BRAND_TOP     = 58;
const BRAND_SIZE    = 66;
const HEAD_BOTTOM   = 84;
const HEAD_MAX_H    = Math.round(H * 0.34);
const HEAD_START    = 80;
const HEAD_MIN      = 44;
const HEAD_LH       = 1.17;

// Photo area (the photo is shown in full, never cropped)
const BG_COLOR      = "#080c16";   // plain dark background (no blur)
const PHOTO_GAP     = 28;          // space between brand / headline and the photo
const PHOTO_FADE    = 70;          // soft edge fade (px) at photo top & bottom

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
// BACKGROUND — plain dark colour (no blur)
// ═══════════════════════════════════════════════════════════════

function drawBackground(ctx) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, W, H);
}

// ═══════════════════════════════════════════════════════════════
// PHOTO — the WHOLE image is shown (contain-fit, never cropped).
//   It is placed in the free space between the brand and the headline,
//   centred vertically, with a soft fade on its top/bottom edges so it
//   blends into the dark background.
// ═══════════════════════════════════════════════════════════════

async function drawPhoto(ctx, src, areaTop, areaBottom) {
  try {
    const img    = await loadImage(src);
    const areaH  = Math.max(100, areaBottom - areaTop);
    const scale  = Math.min(W / img.width, areaH / img.height);
    const dw     = img.width  * scale;
    const dh     = img.height * scale;
    const dx     = (W - dw) / 2;
    const dy     = areaTop + (areaH - dh) / 2;

    ctx.drawImage(img, dx, dy, dw, dh);

    // Soft fade on the top and bottom edges of the photo
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

    return true;
  } catch (e) {
    console.warn("[Poster] main photo failed:", e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// BRAND — channel name, top-left
// ═══════════════════════════════════════════════════════════════

function drawBrand(ctx, name) {
  let size = BRAND_SIZE;
  ctx.font = `${size}px ${HEAD_FONT}`;
  const maxW = W * 0.62;
  while (ctx.measureText(name).width > maxW && size > 30) {
    size -= 2;
    ctx.font = `${size}px ${HEAD_FONT}`;
  }

  ctx.save();
  ctx.textAlign     = "left";
  ctx.textBaseline  = "top";
  ctx.fillStyle     = "#ffffff";
  ctx.shadowColor   = "rgba(0,0,0,0.55)";
  ctx.shadowBlur    = 14;
  ctx.shadowOffsetY = 2;
  ctx.fillText(name, PAD, BRAND_TOP);
  ctx.restore();

  return size; // used to place the photo below the brand
}

// ═══════════════════════════════════════════════════════════════
// HEADLINE — white, left-aligned, anchored to the bottom
// ═══════════════════════════════════════════════════════════════

function wrapWords(ctx, text, maxW) {
  const lines = [];
  let cur = "";
  for (const word of text.split(" ").filter(Boolean)) {
    const test = cur ? cur + " " + word : word;
    if (cur && ctx.measureText(test).width > maxW) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function layoutHeadline(ctx, text, maxW, maxH) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();

  for (let size = HEAD_START; size >= HEAD_MIN; size -= 2) {
    ctx.font = `${size}px ${HEAD_FONT}`;
    const lines = wrapWords(ctx, clean, maxW);
    if (lines.length * Math.round(size * HEAD_LH) <= maxH) return { size, lines };
  }

  const size = HEAD_MIN;
  ctx.font = `${size}px ${HEAD_FONT}`;
  const maxLines = Math.max(1, Math.floor(maxH / Math.round(size * HEAD_LH)));
  const lines = wrapWords(ctx, clean, maxW).slice(0, maxLines);
  let last = lines[lines.length - 1] || "";
  while (last.length > 1 && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
  lines[lines.length - 1] = last.replace(/[\s,;:.\-–]+$/, "") + "…";
  return { size, lines };
}

// Draws a laid-out headline; returns nothing. `top` is the y of the first line.
function drawHeadlineLines(ctx, layout, top) {
  const { size, lines } = layout;
  const lineH = Math.round(size * HEAD_LH);

  ctx.save();
  ctx.font          = `${size}px ${HEAD_FONT}`;
  ctx.fillStyle     = "#ffffff";
  ctx.textAlign     = "left";
  ctx.textBaseline  = "top";
  ctx.shadowColor   = "rgba(0,0,0,0.5)";
  ctx.shadowBlur    = 10;
  ctx.shadowOffsetY = 2;
  lines.forEach((ln, i) => ctx.fillText(ln, PAD, top + i * lineH));
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// MAIN POSTER DRAW
//
// LAYOUT (4:5):
//   1. Plain dark background
//   2. Channel name, top-left
//   3. FULL news photo (not cropped), centred between brand and headline
//   4. White headline, bottom-left
//   5. Ad strip (unchanged pipeline), appended below the poster
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

  // ── 1. Background (plain dark, no blur) ─────────────────────
  drawBackground(ctx);

  // ── 2. Lay out the headline first so we know the free space ─
  const headLayout = layoutHeadline(ctx, newsItem.title, W - PAD * 2, HEAD_MAX_H);
  const headLineH  = Math.round(headLayout.size * HEAD_LH);
  const headTotalH = headLayout.lines.length * headLineH;
  const headTop    = H - HEAD_BOTTOM - headTotalH;

  // ── 3. Brand (top-left) ─────────────────────────────────────
  const showChannel = newsItem.showChannel !== false;
  let brandBottom = 0;
  if (showChannel) {
    const usedSize = drawBrand(ctx, newsItem.channelName || DEFAULT_CHANNEL);
    brandBottom = BRAND_TOP + usedSize;
  }

  // ── 4. Photo — full image, centred in the free space ────────
  const areaTop    = (showChannel ? brandBottom : 0) + PHOTO_GAP;
  const areaBottom = headTop - PHOTO_GAP;
  const hasPhoto   = await drawPhoto(ctx, newsItem.image, areaTop, areaBottom);

  if (!hasPhoto) {
    // Photo failed → simple gradient so the poster still looks finished
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#14305f");
    g.addColorStop(1, BG_COLOR);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (showChannel) drawBrand(ctx, newsItem.channelName || DEFAULT_CHANNEL);
  }

  // ── 5. Headline (bottom-left) ───────────────────────────────
  drawHeadlineLines(ctx, headLayout, headTop);

  // ── 6. Reset ────────────────────────────────────────────────
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  // ── 7. Ad strip ─────────────────────────────────────────────
  if (!liveAdVideoUrl) {
    drawAdStrip(ctx, adImg, H, actualAdH);
  }

  const buffer = await canvasToBuffer(canvas, "image/png");
  return { type: "image", buffer, liveAdVideoUrl, adH: actualAdH };
}

module.exports = { createNewsPoster, toNodeBuffer };