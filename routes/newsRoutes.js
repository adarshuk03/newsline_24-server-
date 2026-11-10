const express = require("express");
const {
  postToInstagram,
  postToFacebook,
  postToYoutube,
} = require("../controller/postNewsController");
const { manualPostNews, manualPostNewsJson, streamPostLogs } = require("../controller/manualPostController");
const {
  uploadAdBanner,
  getCurrentAdBanner,
  listAdBanners,
  deleteAdBanner,
} = require("../controller/adBannerController");
const {
  getNewsList,
  getPostStatus,
  postNewsItem,
} = require("../controller/newsListController");
const multer = require("multer");
const { protect } = require("../middleware/authMiddleware");
const { login, logout } = require("../controller/authController");

const router = express.Router();

// ✅ MEMORY storage (IMPORTANT for Vercel)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ── Platform-based auto news posting routes ───────────────────────────────────
router.get("/post-instagram", postToInstagram);
router.get("/post-facebook",  postToFacebook);
router.get("/post-youtube",   postToYoutube);

// ── Manual post routes ────────────────────────────────────────────────────────
router.post("/manual-post",      protect, upload.single("image"), manualPostNews);
router.post("/manual-post-json", protect, manualPostNewsJson);
router.get("/manual-post/stream", protect, streamPostLogs);

// ── Ad Banner routes ──────────────────────────────────────────────────────────
router.post("/ad-banner/upload",  protect, upload.single("adBanner"), uploadAdBanner);
router.get("/ad-banner/current",  getCurrentAdBanner);
router.get("/ad-banner/list",     protect, listAdBanners);
router.delete("/ad-banner/:slot", protect, deleteAdBanner);

// ── News List & Per-Item Posting routes ──────────────────────────────────────
router.get("/news/list",        getNewsList);
router.get("/news/post-status", getPostStatus);
router.post("/news/post-item",  protect, postNewsItem);

// ── Auth routes ───────────────────────────────────────────────────────────────
router.post("/auth/login",  login);
router.post("/auth/logout", logout);


// ── Health check ──────────────────────────────────────────────────────────────
router.get("/test", (req, res) => res.send("✅ Route working"));

module.exports = router;
