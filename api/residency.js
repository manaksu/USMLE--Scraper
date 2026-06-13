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
    req.on("timeout", () => { req.destroy(); reject(new Error("Timed out")); });
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

function extractLink(text) {
  try { const p = JSON.parse(text.replace(/```[^`]*```/gs,"").trim()); return p.link||null; } catch {}
  const m1 = text.match(/"link"\s*:\s*"(https?:\/\/[^"]+)"/); if (m1) return m1[1];
  const m2 = text.match(/https?:\/\/[^\s"'<>]+/); return m2 ? m2[0] : null;
}

async function claudeAsk(apiKey, prompt) {
  const payload = JSON.stringify({
    model: "claude-sonnet-4-6", max_tokens: 300,
    messages: [{ role: "user", content: prompt }]
  });
  const raw = await httpPost({
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(payload) }
  }, payload);
  const data = JSON.parse(raw);
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
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
  const { website } = body;
  if (!website) return res.status(400).json({ error: "No website provided" });

  try {
    const html = await httpGet(website);
    const links = extractLinks(html, website);

    // Find FM link directly
    let fmLink = null;
    if (links.length > 0) {
      const t = await claudeAsk(apiKey,
        `From these links on ${website}, find the ONE link for a Family Medicine Residency page.\n` +
        `Labels: 'Family Medicine Residency', 'FM Residency', 'Residency Programs', 'GME', 'Medical Education', 'Graduate Medical Education'.\n` +
        `Return ONLY JSON: {"link":"https://..."} or {"link":null}\n\n` + links.join("\n"));
      fmLink = extractLink(t);
    }

    // Fallback: check gateway pages (Careers, GME, Education)
    if (!fmLink && links.length > 0) {
      const gt = await claudeAsk(apiKey,
        `From these links on ${website}, find up to 4 links that might lead to residency/training info.\n` +
        `Look for: 'Careers', 'GME', 'Medical Education', 'Education & Research', 'Graduate Medical Education', 'Training', 'Academic Affairs'.\n` +
        `Return ONLY JSON: {"links":["https://..."]}\n\n` + links.join("\n"));
      let gateways = [];
      try { gateways = JSON.parse(gt.replace(/```[^`]*```/gs,"").trim()).links || []; } catch {}

      for (const g of gateways.slice(0,4)) {
        try {
          const gHtml = await httpGet(g);
          const gLinks = extractLinks(gHtml, g);
          if (gLinks.length > 0) {
            const t2 = await claudeAsk(apiKey,
              `From these links on ${g}, find the ONE link for a Family Medicine Residency page.\n` +
              `Labels: 'Family Medicine Residency', 'FM Residency', 'Residency Programs', 'GME', 'Medical Education'.\n` +
              `Return ONLY JSON: {"link":"https://..."} or {"link":null}\n\n` + gLinks.join("\n"));
            fmLink = extractLink(t2);
            if (fmLink) break;
          }
        } catch {}
      }
    }

    if (!fmLink) return res.json({ fmLink: null, applyLink: null });

    // Find Apply link
    const fmHtml = await httpGet(fmLink);
    const fmLinks = extractLinks(fmHtml, fmLink);
    let applyLink = null;
    if (fmLinks.length > 0) {
      const at = await claudeAsk(apiKey,
        `From these links on ${fmLink}, find the ONE apply link.\n` +
        `Labels: 'How to Apply', 'Apply Now', 'Apply', 'To Apply', 'Application'.\n` +
        `Return ONLY JSON: {"link":"https://..."} or {"link":null}\n\n` + fmLinks.join("\n"));
      applyLink = extractLink(at);
    }

    return res.json({ fmLink, applyLink });
  } catch (e) {
    return res.status(500).json({ fmLink: null, applyLink: null, error: e.message });
  }
};
