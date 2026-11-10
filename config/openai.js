require("dotenv").config();
const OpenAI = require("openai");

// Groq exposes an OpenAI-compatible API
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

module.exports = openai;
