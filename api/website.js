const https = require("https");

function httpPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ""; res.on("data", c => data += c); res.on("end", () => resolve(data));
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body) return resolve(req.body);
    let raw = ""; req.on("data", c => raw += c);
    req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

function extractUrl(text) {
  // Try JSON first
  try {
    const m = text.match(/"website"\s*:\s*"(https?:\/\/[^"]+)"/);
    if (m) return m[1];
  } catch {}
  // Fallback: first URL in text
  const m = text.match(/https?:\/\/[^\s"',\)>\]]+/);
  return m ? m[0].replace(/[.,;]+$/, '') : null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const body = await parseBody(req);
  const { programName } = body;
  if (!programName) return res.status(400).json({ error: "No program name" });

  try {
    const payload = JSON.stringify({
      model: "claude-haiku-4-5-20251001",   // cheapest model — simple lookup task
      max_tokens: 150,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `Find the official website for this exact GME residency program: "${programName} family medicine residency". Return ONLY JSON: {"website":"https://..."} or {"website":null}`
      }]
    });

    const raw = await httpPost({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: {
        "Content-Type": "application/json", "x-api-key": apiKey,
        "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(payload)
      }
    }, payload);

    const data = JSON.parse(raw);
    if (data.error) throw new Error(data.error.message);
    const text = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    return res.json({ website: extractUrl(text) || null });

  } catch (e) {
    return res.status(500).json({ website: null, error: e.message });
  }
};
