import fetch from "node-fetch";
import * as cheerio from "cheerio";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "No URL provided" });

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" },
      timeout: 15000,
    });

    const html = await response.text();
    const $ = cheerio.load(html);
    const hrefs = [];
    $("a[href]").each((_, el) => {
      let href = $(el).attr("href");
      if (href && !href.startsWith("#") && !href.startsWith("mailto:")) {
        if (href.startsWith("/")) href = new URL(href, url).href;
        if (href.startsWith("http")) hrefs.push(href);
      }
    });

    const unique = [...new Set(hrefs)].slice(0, 300);

    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [{
        role: "user",
        content:
          `From these links on ${url}, find the ONE link for a Family Medicine Residency program page. ` +
          `It may say 'Family Medicine Residency', 'FM Residency', 'Residency Programs', 'Graduate Medical Education', or similar. ` +
          `Return ONLY JSON: {"link": "https://..."} or {"link": null} if not found.\n\n` +
          unique.join("\n"),
      }],
    });

    const raw = msg.content[0].text.replace(/```[^`]*```/gs, "").trim();
    const { link } = JSON.parse(raw);
    res.json({ link: link || null });

  } catch (e) {
    res.status(500).json({ link: null, error: e.message });
  }
}
