const https = require("https");
const http = require("http");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html"
      },
      timeout: 15000
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
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
      if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
      const full = href.startsWith("http") ? href : new URL(href, base.origin).href;
      links.add(full);
    } catch {}
  }
  return [...links].slice(0, 300);
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).end();

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "No URL provided" });

  try {
    const html = await fetchUrl(url);
    const links = extractLinks(html, url);

    if (links.length === 0) {
      return res.json({ link: null, error: "No links found on this page." });
    }

    const msg = await client.messages.create({
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

    const raw = msg.content[0].text.replace(/```[^`]*```/gs, "").trim();
    const parsed = JSON.parse(raw);
    return res.json({ link: parsed.link || null });

  } catch (e) {
    return res.status(500).json({ link: null, error: e.message });
  }
};
