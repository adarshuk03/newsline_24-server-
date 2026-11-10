"use strict";

const fs = require("fs");
const { google } = require("googleapis");

require("dotenv").config();

// 🔑 Replace with your credentials
const CLIENT_ID = process.env.YT_CLIENT_ID;
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET;
const REDIRECT_URI = process.env.YT_REDIRECT_URI;
const REFRESH_TOKEN = process.env.YT_REFRESH_TOKEN;

// OAuth setup
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);


oauth2Client.setCredentials({
  refresh_token: REFRESH_TOKEN,
});

const youtube = google.youtube({
  version: "v3",
  auth: oauth2Client,
});

// ✅ Upload Shorts
async function uploadShort(videoPath, title, description) {
  try {
    console.log("🚀 Uploading YouTube Short...");

    // 🔥 VERY IMPORTANT FIX
    const accessToken = await oauth2Client.getAccessToken();
    console.log("🔑 Access Token:", accessToken?.token);

    const response = await youtube.videos.insert({
      part: "snippet,status",
      requestBody: {
        snippet: {
          title: title,
          description: description,
          tags: ["shorts", "viral"],
          categoryId: "22",
        },
        status: {
          privacyStatus: "public",
        },
      },
      media: {
        body: fs.createReadStream(videoPath),
      },
    });

    console.log("✅ Uploaded:", response.data);
    return response.data;

  } catch (err) {
    console.error("❌ YouTube ERROR:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = { uploadShort };