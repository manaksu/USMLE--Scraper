const https = require("https");
const http = require("http");

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml"
      },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timed out fetching page")); });
  });
}

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

function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Set();
  const regex = /href=["']([^"'#>]+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const href = match[1].trim();
      if (/^(mailto|tel|javascript):/i.test(href)) continue;
      const full = href.startsWith("http") ? href : new URL(href, base.origin).href;
      links.add(full);
    } catch {}
  }
  return [...links].slice(0, 300);
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body) return resolve(req.body);
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

async function askClaude(apiKey, links, url) {
  const payload = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [{
      role: "user",
      content:
        `From these links on ${url}, find the ONE link for a Family Medicine Residency program page. ` +
        `It may say 'Family Medicine Residency', 'FM Residency', 'Residency Programs', 'Graduate Medical Education', or similar. ` +
        `Return ONLY JSON: {"link": "https://..."} or {"link": null} if not found.\n\n` +
        links.join("\n")
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
  const text = data.content[0].text.replace(/```[^`]*```/gs, "").trim();
  return JSON.parse(text).link || null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Vercel environment variables" });

  const body = await parseBody(req);
  const { url } = body;
  if (!url) return res.status(400).json({ error: "No URL provided" });

  try {
    const html = await httpGet(url);
    const links = extractLinks(html, url);
    if (links.length === 0) return res.json({ link: null, error: "No links found on this page." });

    const link = await askClaude(apiKey, links, url);
    return res.json({ link });
  } catch (e) {
    return res.status(500).json({ link: null, error: e.message });
  }
};
