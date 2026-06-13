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

async function claudeWithSearch(apiKey, prompt) {
  const payload = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }]
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
  return data.content.find(b => b.type === "text")?.text || "";
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
    // Step 1: Search specifically for this residency program
    const searchText = await claudeWithSearch(apiKey,
      `Search for the EXACT Family Medicine Residency program named "${programName}".
      This is a specific residency training program, NOT just the hospital with a similar name.
      Search for: "${programName} family medicine residency program official site"
      Find the official website of THIS specific program.
      Important: "${programName}" is the exact program name — do not substitute a different institution.
      Return ONLY JSON: {"website": "https://...", "confidence": "high/low", "reason": "why you chose this"} or {"website": null, "reason": "why not found"}`
    );

    // Extract JSON
    let website = null, confidence = "low", reason = "";
    try {
      const clean = searchText.replace(/```[^`]*```/gs, "").trim();
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        website = parsed.website || null;
        confidence = parsed.confidence || "low";
        reason = parsed.reason || "";
      }
    } catch {}

    // Step 2: If low confidence, do a second targeted search to verify
    if (website && confidence === "low") {
      const verifyText = await claudeWithSearch(apiKey,
        `I'm looking for the residency program named exactly "${programName}".
        I found this website: ${website}
        Search for "${programName}" and confirm if ${website} is the correct official site for THIS program specifically.
        If it's wrong, find the correct one.
        Return ONLY JSON: {"website": "https://...", "confirmed": true/false}`
      );
      try {
        const m = verifyText.match(/\{[\s\S]*\}/);
        if (m) {
          const v = JSON.parse(m[0]);
          if (v.website) website = v.website;
        }
      } catch {}
    }

    return res.json({ website, reason });

  } catch (e) {
    return res.status(500).json({ website: null, error: e.message });
  }
};
