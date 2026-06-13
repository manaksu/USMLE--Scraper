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
  try {
    const clean = text.replace(/```[^`]*```/gs, "").trim();
    const parsed = JSON.parse(clean);
    return parsed.link || null;
  } catch {}
  const m1 = text.match(/"link"\s*:\s*"(https?:\/\/[^"]+)"/);
  if (m1) return m1[1];
  const m2 = text.match(/https?:\/\/[^\s"'<>]+/);
  return m2 ? m2[0] : null;
}

async function claudePost(apiKey, body) {
  const payload = JSON.stringify(body);
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
  return data;
}

// Find website from program name using web search
async function findWebsite(apiKey, programName) {
  const data = await claudePost(apiKey, {
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{
      role: "user",
      content: `Find the official hospital or medical center website for: "${programName}". Return ONLY JSON: {"website": "https://..."} or {"website": null}.`
    }]
  });
  const text = data.content.find(b => b.type === "text");
  if (!text) return null;
  const m = text.text.match(/"website"\s*:\s*"(https?:\/\/[^"]+)"/);
  return m ? m[1] : extractLink(text.text);
}

// Ask Claude to find FM residency link from a list of links
async function findFmLink(apiKey, links, sourceUrl) {
  const data = await claudePost(apiKey, {
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [{
      role: "user",
      content:
        `From these links on ${sourceUrl}, find the ONE link most likely leading to a Family Medicine Residency program page.\n` +
        `It could be labeled: 'Family Medicine Residency', 'FM Residency', 'Residency Programs', 'Graduate Medical Education', 'GME', 'Medical Education', 'Careers', 'Medical Training', or similar.\n` +
        `Return ONLY JSON: {"link": "https://..."} or {"link": null} if not found.\n\n` +
        links.join("\n")
    }]
  });
  return extractLink(data.content[0].text);
}

// Find intermediate pages that might contain FM residency links (GME, Careers, Education)
async function findGatewayLinks(apiKey, links, sourceUrl) {
  const data = await claudePost(apiKey, {
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [{
      role: "user",
      content:
        `From these links on ${sourceUrl}, find up to 4 links that might lead to a page containing residency or medical training programs.\n` +
        `Look for: 'Careers', 'Medical Education', 'Graduate Medical Education', 'GME', 'Training Programs', 'Education & Research', 'For Physicians', 'Academic Affairs', 'Medical Staff', or similar.\n` +
        `Return ONLY JSON: {"links": ["https://...", "https://..."]} — empty array if none found.\n\n` +
        links.join("\n")
    }]
  });
  try {
    const text = data.content[0].text.replace(/```[^`]*```/gs, "").trim();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.links) ? parsed.links : [];
  } catch {
    const matches = [...data.content[0].text.matchAll(/https?:\/\/[^\s"'<>]+/g)];
    return matches.map(m => m[0]).slice(0, 4);
  }
}

// Find apply link from FM residency page
async function findApplyLink(apiKey, links, sourceUrl) {
  const data = await claudePost(apiKey, {
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [{
      role: "user",
      content:
        `From these links on ${sourceUrl}, find the ONE link for applying to the residency program.\n` +
        `Look for: 'How to Apply', 'Apply Now', 'Apply', 'To Apply', 'Application', 'Application Process'.\n` +
        `Return ONLY JSON: {"link": "https://..."} or {"link": null}.\n\n` +
        links.join("\n")
    }]
  });
  return extractLink(data.content[0].text);
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
    // Step 1: Find hospital website
    const website = await findWebsite(apiKey, programName);
    if (!website) return res.json({ website: null, fmLink: null, applyLink: null, error: `Could not find website for "${programName}"` });

    // Step 2: Scrape main page, look for FM link directly
    const html = await httpGet(website);
    const links = extractLinks(html, website);

    let fmLink = links.length > 0 ? await findFmLink(apiKey, links, website) : null;

    // Step 3: If not found, dig into gateway pages (Careers, GME, Education, etc.)
    if (!fmLink && links.length > 0) {
      const gatewayLinks = await findGatewayLinks(apiKey, links, website);

      for (const gLink of gatewayLinks) {
        try {
          const gHtml = await httpGet(gLink);
          const gLinks = extractLinks(gHtml, gLink);
          if (gLinks.length > 0) {
            fmLink = await findFmLink(apiKey, gLinks, gLink);
            if (fmLink) break;
          }
        } catch {}
      }
    }

    if (!fmLink) return res.json({ website, fmLink: null, applyLink: null });

    // Step 4: Find Apply link on FM page
    const fmHtml = await httpGet(fmLink);
    const fmLinks = extractLinks(fmHtml, fmLink);
    const applyLink = fmLinks.length > 0 ? await findApplyLink(apiKey, fmLinks, fmLink) : null;

    return res.json({ website, fmLink, applyLink });

  } catch (e) {
    return res.status(500).json({ website: null, fmLink: null, applyLink: null, error: e.message });
  }
};
