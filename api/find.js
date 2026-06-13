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

function extractLink(text) {
  try {
    const clean = text.replace(/```[^`]*```/gs, "").trim();
    const parsed = JSON.parse(clean);
    return parsed.link || null;
  } catch {}
  const match = text.match(/"link"\s*:\s*"(https?:\/\/[^"]+)"/);
  if (match) return match[1];
  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/);
  return urlMatch ? urlMatch[0] : null;
}

async function callClaude(apiKey, messages, tools) {
  const body = { model: "claude-sonnet-4-6", max_tokens: 1000, messages };
  if (tools) body.tools = tools;

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

// Use Claude web search to find hospital website from program name
async function findWebsite(apiKey, programName) {
  const data = await callClaude(apiKey, [{
    role: "user",
    content: `Search for the official hospital or medical center website for this residency program: "${programName}". Return ONLY JSON: {"website": "https://..."} with the main hospital website URL, or {"website": null} if not found.`
  }], [{
    type: "web_search_20250305",
    name: "web_search"
  }]);

  // Find text content in response
  const textBlock = data.content.find(b => b.type === "text");
  if (!textBlock) return null;
  return extractLink(textBlock.text.replace(/website/g, 'link')) ||
    (() => {
      try {
        const m = textBlock.text.match(/"website"\s*:\s*"(https?:\/\/[^"]+)"/);
        return m ? m[1] : null;
      } catch { return null; }
    })();
}

async function askClaude(apiKey, links, prompt) {
  const payload = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [{ role: "user", content: prompt + links.join("\n") }]
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
  const { programName, url: directUrl } = body;
  if (!programName && !directUrl) return res.status(400).json({ error: "No program name or URL provided" });

  try {
    let websiteUrl = directUrl;

    // Step 1: Find website from program name if no URL given
    if (!websiteUrl) {
      websiteUrl = await findWebsite(apiKey, programName);
      if (!websiteUrl) return res.json({ website: null, fmLink: null, applyLink: null, error: `Could not find website for "${programName}"` });
    }

    // Step 2: Find FM Residency page
    const html = await httpGet(websiteUrl);
    const links = extractLinks(html, websiteUrl);
    if (links.length === 0) return res.json({ website: websiteUrl, fmLink: null, applyLink: null, error: "No links found on website." });

    const fmLink = await askClaude(apiKey, links,
      `From these links on ${websiteUrl}, find the ONE link for a Family Medicine Residency program page. ` +
      `It may say 'Family Medicine Residency', 'FM Residency', 'Residency Programs', 'Graduate Medical Education', or similar. ` +
      `Return ONLY JSON: {"link": "https://..."} or {"link": null} if not found.\n\n`
    );

    if (!fmLink) return res.json({ website: websiteUrl, fmLink: null, applyLink: null });

    // Step 3: Find Apply link
    const fmHtml = await httpGet(fmLink);
    const fmLinks = extractLinks(fmHtml, fmLink);
    const applyLink = fmLinks.length > 0 ? await askClaude(apiKey, fmLinks,
      `From these links on ${fmLink}, find the ONE link related to applying to the residency program. ` +
      `It may say 'How to Apply', 'To Apply', 'Apply', 'Apply Now', 'Application', or similar. ` +
      `Return ONLY JSON: {"link": "https://..."} or {"link": null} if not found.\n\n`
    ) : null;

    return res.json({ website: websiteUrl, fmLink, applyLink });

  } catch (e) {
    return res.status(500).json({ website: null, fmLink: null, applyLink: null, error: e.message });
  }
};
