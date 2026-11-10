"use strict";

const jwt = require("jsonwebtoken");

// ─────────────────────────────────────────────
// POST /api/auth/login
// Body: { username, password }
// ─────────────────────────────────────────────
exports.login = (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const validUser = process.env.ADMIN_USERNAME;
  const validPass = process.env.ADMIN_PASSWORD;
  const jwtSecret = process.env.JWT_SECRET;

  if (!validUser || !validPass || !jwtSecret) {
    console.error("❌ Missing ADMIN_USERNAME, ADMIN_PASSWORD or JWT_SECRET in environment");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  if (username !== validUser || password !== validPass) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { username },
    jwtSecret,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );

  return res.json({
    message: "Login successful",
    token,
  });
};

// ─────────────────────────────────────────────
// POST /api/auth/logout  (optional – client
// just drops the token, but good to have)
// ─────────────────────────────────────────────
exports.logout = (_req, res) => {
  return res.json({ message: "Logged out" });
};