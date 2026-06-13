const https = require("https");
const http = require("http");

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/120.0.0.0", "Accept": "text/html" },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve).catch(reject);
      let data = ""; res.on("data", c => data += c); res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timed out")); });
  });
}

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

// Extract links from HTML — but FILTER to only relevant-looking ones to cut token cost
function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const all = new Set();
  const regex = /href=["']([^"'#>]+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const href = match[1].trim();
      if (/^(mailto|tel|javascript):/i.test(href)) continue;
      const full = href.startsWith("http") ? href : new URL(href, base.origin).href;
      all.add(full);
    } catch {}
  }
  return [...all];
}

// Score links so we only send the most relevant ones to Claude
function scoreLinks(links, baseUrl) {
  const base = new URL(baseUrl).hostname;
  const FM_KEYWORDS = /family.?medicine|fm.residen|residency|gme|graduate.?medical|medical.?education|training|careers|education|physician|clinical/i;
  const SKIP = /facebook|twitter|linkedin|youtube|instagram|google|cdn|font|jquery|css|\.png|\.jpg|\.gif|\.svg|\.pdf|privacy|cookie|terms|login|logout|search|#/i;

  return links
    .filter(l => !SKIP.test(l))
    .map(l => {
      let score = 0;
      if (l.includes(base)) score += 2;          // same domain preferred
      if (FM_KEYWORDS.test(l)) score += 3;        // FM/residency keywords in URL
      return { l, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 60)                                  // max 60 links sent to Claude (~3k tokens)
    .map(x => x.l);
}

function extractLink(text) {
  const m = text.match(/"link"\s*:\s*"(https?:\/\/[^"]+)"/);
  if (m) return m[1];
  const m2 = text.match(/https?:\/\/[^\s"'<>\]]+/);
  return m2 ? m2[0].replace(/[.,;]+$/, '') : null;
}

async function claudeAsk(apiKey, prompt, links) {
  // Trim prompt tokens — send max 60 filtered links
  const payload = JSON.stringify({
    model: "claude-haiku-4-5-20251001",   // Haiku for all link classification
    max_tokens: 100,
    messages: [{ role: "user", content: prompt + "\n\n" + links.join("\n") }]
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
    const allLinks = extractLinks(html, website);
    const scored = scoreLinks(allLinks, website);

    if (!scored.length) return res.json({ fmLink: null, applyLink: null });

    // Step 1: Find FM link from scored links
    let fmLink = null;
    const t1 = await claudeAsk(apiKey,
      `Links from ${website}. Find ONE Family Medicine Residency page link.\nReturn ONLY JSON: {"link":"https://..."} or {"link":null}`,
      scored
    );
    fmLink = extractLink(t1);

    // Step 2: Fallback — find gateway pages if FM not found directly
    if (!fmLink) {
      const t2 = await claudeAsk(apiKey,
        `Links from ${website}. Find up to 3 links leading to Careers, GME, Medical Education, or Residency sections.\nReturn ONLY JSON: {"links":["https://..."]}`,
        scored
      );
      let gateways = [];
      try {
        const m = t2.match(/"links"\s*:\s*\[([^\]]+)\]/);
        if (m) gateways = m[1].match(/https?:\/\/[^\s"',\]]+/g) || [];
      } catch {}

      for (const g of gateways.slice(0, 3)) {
        try {
          const gHtml = await httpGet(g);
          const gScored = scoreLinks(extractLinks(gHtml, g), g);
          if (gScored.length) {
            const t3 = await claudeAsk(apiKey,
              `Links from ${g}. Find ONE Family Medicine Residency page link.\nReturn ONLY JSON: {"link":"https://..."} or {"link":null}`,
              gScored
            );
            fmLink = extractLink(t3);
            if (fmLink) break;
          }
        } catch {}
      }
    }

    if (!fmLink) return res.json({ fmLink: null, applyLink: null });

    // Step 3: Find Apply link on FM page
    const fmHtml = await httpGet(fmLink);
    const fmScored = scoreLinks(extractLinks(fmHtml, fmLink), fmLink);
    let applyLink = null;
    if (fmScored.length) {
      const t4 = await claudeAsk(apiKey,
        `Links from ${fmLink}. Find ONE "How to Apply" or "Apply" link for the residency.\nReturn ONLY JSON: {"link":"https://..."} or {"link":null}`,
        fmScored
      );
      applyLink = extractLink(t4);
    }

    return res.json({ fmLink, applyLink });

  } catch (e) {
    return res.status(500).json({ fmLink: null, applyLink: null, error: e.message });
  }
};
