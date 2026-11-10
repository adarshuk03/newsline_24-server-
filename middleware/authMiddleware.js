"use strict";

const jwt = require("jsonwebtoken");

// ─────────────────────────────────────────────
// Middleware: protect any route with a JWT
//
// Accepts the token from:
//   1. Authorization: Bearer <token>   (standard REST)
//   2. ?token=<token>                  (EventSource / SSE – can't set headers)
// ─────────────────────────────────────────────
exports.protect = (req, res, next) => {
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    console.error("❌ JWT_SECRET is not set in environment");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  // Extract token
  let token = null;

  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (req.query.token) {
    // Fallback for SSE connections
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: "No token provided. Please log in." });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.admin = decoded;   // { username, iat, exp }
    next();
  } catch (err) {
    const message =
      err.name === "TokenExpiredError"
        ? "Session expired. Please log in again."
        : "Invalid token. Please log in.";

    return res.status(401).json({ error: message });
  }
};