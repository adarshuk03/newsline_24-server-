const ffmpeg        = require("fluent-ffmpeg");
const ffmpegStatic  = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const { loadImage } = require("@napi-rs/canvas");
const path          = require("path");
const fs            = require("fs");
const os            = require("os");

// ─────────────────────────────────────────────────────────────
// SAFE FFMPEG + FFPROBE LOADING
// ─────────────────────────────────────────────────────────────

try {
  const ffmpegPath = ffmpegStatic;
  console.log("✅ ffmpeg path:", ffmpegPath);
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    console.error("❌ ffmpeg binary missing:", ffmpegPath);
  } else {
    ffmpeg.setFfmpegPath(ffmpegPath);
    process.env.FFMPEG_PATH = ffmpegPath;
    console.log("✅ ffmpeg binary exists");
  }
} catch (err) {
  console.error("❌ Failed to load ffmpeg:", err);
}

try {
  const ffprobePath = ffprobeStatic.path;
  console.log("✅ ffprobe path:", ffprobePath);
  if (!ffprobePath || !fs.existsSync(ffprobePath)) {
    console.error("❌ ffprobe binary missing:", ffprobePath);
  } else {
    ffmpeg.setFfprobePath(ffprobePath);
    process.env.FFPROBE_PATH = ffprobePath;
    console.log("✅ ffprobe binary exists");
  }
} catch (err) {
  console.error("❌ Failed to load ffprobe:", err);
}

// ─────────────────────────────────────────────────────────────
// OUTPUT SETTINGS
// ─────────────────────────────────────────────────────────────

const OUT_W = 520;

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Guarantee a real Node.js Buffer regardless of input type.
 * Protects against native ArrayBuffer coming from fetch() or sharp.
 */
function toNodeBuffer(data) {
  if (Buffer.isBuffer(data))       return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data))    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError(`toNodeBuffer: unsupported type ${Object.prototype.toString.call(data)}`);
}

/**
 * Get image dimensions from a file path OR a Buffer/ArrayBuffer.
 */
async function getImageSize(imgInput) {
  if (typeof imgInput === "string") {
    const img = await loadImage(imgInput);
    return { width: img.width, height: img.height };
  }
  // Buffer / ArrayBuffer / TypedArray — normalise then load
  const buf = toNodeBuffer(imgInput);
  const img = await loadImage(buf);
  return { width: img.width, height: img.height };
}

/**
 * Silently remove temp files, ignoring errors.
 */
function cleanupFiles(...files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — IMAGE → VIDEO
// ─────────────────────────────────────────────────────────────

function renderImageClip(imgPath, vidPath, outH) {
  return new Promise((resolve, reject) => {
    ffmpeg(imgPath)
      .inputOptions(["-loop 1"])
      .outputOptions([
        "-c:v libx264",
        "-pix_fmt yuv420p",
        `-vf scale=${OUT_W}:${outH}`,
        "-t 7",
        "-r 30",
        "-preset ultrafast",
        "-crf 28",
        "-threads 1",
        "-x264-params sliced-threads=0:sync-lookahead=0",
        "-movflags +faststart",
        "-an",
      ])
      .output(vidPath)
      .on("start",  (cmd) => console.log("🎬 renderImageClip:", cmd))
      .on("end",    ()    => { console.log("✅ Image clip created"); resolve(); })
      .on("error",  (err) => { console.error("❌ Image clip error:", err.message); reject(err); })
      .run();
  });
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — STACK poster video on top of ad video
// Uses FFmpeg filter_complex vstack to produce a single MP4:
//   top    = 7-second poster clip (OUT_W × posterH)
//   bottom = ad video looped to 7 seconds (OUT_W × adH_scaled)
// ─────────────────────────────────────────────────────────────

function stackVideos(posterVidPath, adVidPath, outPath, outW, posterH, adH) {
  return new Promise((resolve, reject) => {
    // Build the ffmpeg args explicitly so -stream_loop is guaranteed to appear
    // immediately before the ad input (input 1).  fluent-ffmpeg's .inputOption()
    // ordering is ambiguous when chaining multiple inputs, so we use spawn.
    const args = [
      "-y",
      // input 0 — poster clip (already 7 s)
      "-i", posterVidPath,
      // input 1 — ad video, looped infinitely so trim can always pull 7 s
      "-stream_loop", "-1",
      "-i", adVidPath,
      // filter: scale both, fps-normalise ad, trim ad to 7 s, vstack
      "-filter_complex",
      [
        `[0:v]scale=${outW}:${posterH},setsar=1[top]`,
        `[1:v]fps=30,scale=${outW}:${adH},setsar=1,trim=duration=7,setpts=PTS-STARTPTS[bot]`,
        `[top][bot]vstack=inputs=2[out]`,
      ].join(";"),
      "-map", "[out]",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-t", "7",
      "-r", "30",
      "-preset", "ultrafast",
      "-crf", "28",
      "-threads", "1",
      "-x264-params", "sliced-threads=0:sync-lookahead=0",
      "-movflags", "+faststart",
      "-an",
      outPath,
    ];

    // Resolve the ffmpeg binary path the same way fluent-ffmpeg does
    const ffmpegPath = (() => {
      try { return require("ffmpeg-static"); } catch { return "ffmpeg"; }
    })();

    console.log("🎬 stackVideos:", ffmpegPath, args.join(" "));

    const proc = require("child_process").spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log("✅ Composited video created:", outPath);
        resolve();
      } else {
        const msg = stderr.slice(-800); // last 800 chars of ffmpeg stderr
        console.error("❌ stackVideos ffmpeg exited", code, msg);
        reject(new Error(`stackVideos ffmpeg exited ${code}: ${msg}`));
      }
    });

    proc.on("error", (err) => {
      console.error("❌ stackVideos spawn error:", err.message);
      reject(err);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────────────────────

/**
 * Convert an image (file path OR Buffer/ArrayBuffer) to an MP4 video.
 * Optionally composites a live ad video below the poster using FFmpeg vstack.
 *
 * @param {string|Buffer|ArrayBuffer} imgInput    - image file path or raw bytes
 * @param {string}                    vidPath     - output .mp4 path
 * @param {object}                    [opts]      - optional compositing options
 * @param {string}                    [opts.adVideoInput] - URL or local path of the ad video
 * @param {number}                    [opts.adH]          - pixel height of the ad strip at output scale
 * @returns {Promise<string>}                     - resolves with vidPath
 */
async function convertImageToVideo(imgInput, vidPath, opts = {}) {
  console.log("🚀 Starting video generation...");

  let tmpImgPath  = null; // set only when we write a temp file for Buffer input
  let tmpAdPath   = null; // set only when we download a remote ad video
  let tmpPosterVid = null; // intermediate poster-only video before compositing

  try {
    // ── Resolve a real file path for ffmpeg ────────────────
    let imgPath;

    if (typeof imgInput === "string") {
      if (!fs.existsSync(imgInput)) {
        throw new Error(`Image not found: ${imgInput}`);
      }
      imgPath = imgInput;
    } else {
      // Buffer / ArrayBuffer — write to a temp PNG for ffmpeg
      const buf  = toNodeBuffer(imgInput);
      tmpImgPath = path.join(os.tmpdir(), `poster_${Date.now()}.png`);
      fs.writeFileSync(tmpImgPath, buf);
      imgPath    = tmpImgPath;
      console.log("📝 Wrote temp image for ffmpeg:", tmpImgPath);
    }

    // ── Measure poster dimensions ───────────────────────────
    const { width, height } = await getImageSize(imgPath);
    const rawH  = (OUT_W * height) / width;
    const OUT_H = Math.ceil(rawH / 2) * 2; // must be even for yuv420p

    console.log(`📐 Poster: ${width}x${height} → ${OUT_W}x${OUT_H}`);

    const { adVideoInput } = opts;

    if (!adVideoInput) {
      // ── No ad video — simple image → video ──────────────
      await renderImageClip(imgPath, vidPath, OUT_H);
      console.log("🎉 Final video created:", vidPath);
      return vidPath;
    }

    // ── Ad video compositing ─────────────────────────────
    // Step 1: render the poster image as a 7-second clip
    tmpPosterVid = path.join(os.tmpdir(), `poster_clip_${Date.now()}.mp4`);
    await renderImageClip(imgPath, tmpPosterVid, OUT_H);
    console.log("✅ Poster clip created:", tmpPosterVid);

    // Step 2: resolve the ad video path (download if URL)
    let adPath;
    if (/^https?:\/\//i.test(adVideoInput)) {
      console.log("⬇️  Downloading ad video:", adVideoInput);
      const vidBuf = await (async () => {
        const res = await fetch(adVideoInput);
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ad video`);
        return toNodeBuffer(await res.arrayBuffer());
      })();
      tmpAdPath = path.join(os.tmpdir(), `ad_vid_${Date.now()}.mp4`);
      fs.writeFileSync(tmpAdPath, vidBuf);
      adPath = tmpAdPath;
      console.log("✅ Ad video downloaded:", adPath);
    } else {
      adPath = adVideoInput;
      if (!fs.existsSync(adPath)) {
        throw new Error(`Ad video not found: ${adPath}`);
      }
    }

    // Step 3: compute the ad strip height at output scale using ffprobe
    // (loadImage cannot read MP4 — use ffprobe to get video dimensions)
    const adH_scaled = await new Promise((resolve) => {
      ffmpeg.ffprobe(adPath, (err, meta) => {
        if (err || !meta) {
          console.warn("[stackVideos] ffprobe failed — using default adH:", err?.message);
          return resolve(Math.ceil((OUT_W * 292 / 1080) / 2) * 2); // safe fallback
        }
        const vs = meta.streams.find((s) => s.codec_type === "video");
        if (!vs || !vs.width || !vs.height) {
          return resolve(Math.ceil((OUT_W * 292 / 1080) / 2) * 2);
        }
        const rawAdH = (OUT_W * vs.height) / vs.width;
        resolve(Math.ceil(rawAdH / 2) * 2);
      });
    });
    console.log(`📐 Ad strip at output scale: ${OUT_W}x${adH_scaled}`);

    // Step 4: FFmpeg vstack — poster clip on top, looped ad video on bottom
    await stackVideos(tmpPosterVid, adPath, vidPath, OUT_W, OUT_H, adH_scaled);

    console.log("🎉 Final composited video created:", vidPath);
    return vidPath;

  } catch (err) {
    console.error("❌ convertImageToVideo ERROR:", err.message);
    throw err;

  } finally {
    // Always clean up temp files — even on error
    cleanupFiles(tmpImgPath, tmpAdPath, tmpPosterVid);
  }
}

module.exports = { convertImageToVideo, stackVideos, toNodeBuffer };