const fs   = require("fs");
const path = require("path");

/** Temp directory — /tmp on Vercel, ../temp locally */
const TMP = process.env.VERCEL ? "/tmp" : path.join(__dirname, "../temp");

if (!fs.existsSync(TMP)) {
  fs.mkdirSync(TMP, { recursive: true });
}

/** Silently delete one or more file paths */
function safeDelete(...filePaths) {
  for (const fp of filePaths) {
    try {
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (e) {
      console.warn(`⚠️ Could not delete ${fp}:`, e.message);
    }
  }
}

module.exports = { TMP, safeDelete };
