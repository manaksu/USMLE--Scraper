const https = require("https");

function httpPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body) return resolve(req.body);
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
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
  if (!programName) return res.status(400).json({ error: "No program name provided" });

  try {
    const payload = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `Find the official hospital or medical center website for this residency program: "${programName}". Return ONLY JSON: {"website": "https://..."} or {"website": null}.`
      }]
    });

    const raw = await httpPost({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, payload);

    const data = JSON.parse(raw);
    if (data.error) throw new Error(data.error.message);
    const text = data.content.find(b => b.type === "text");
    if (!text) return res.json({ website: null });
    const m = text.text.match(/"website"\s*:\s*"(https?:\/\/[^"]+)"/);
    const url = m ? m[1] : (text.text.match(/https?:\/\/[^\s"'<>]+/) || [])[0] || null;
    return res.json({ website: url });
  } catch (e) {
    return res.status(500).json({ website: null, error: e.message });
  }
};
