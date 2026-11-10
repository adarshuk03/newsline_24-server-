require("dotenv").config();
const express = require("express");
const cors = require("cors");

const newsRoutes = require("./routes/newsRoutes");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api", newsRoutes);

// Root test route
app.get("/", (req, res) => {
  res.json({ message: "✅ Server is running on Vercel" });
});

module.exports = app;