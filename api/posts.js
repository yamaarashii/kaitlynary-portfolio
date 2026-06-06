import { XMLParser } from "fast-xml-parser";

// Your Substack feed. Override with an env var on Vercel if your URL differs.
const FEED_URL =
  process.env.SUBSTACK_FEED_URL || "https://kaitlynway.substack.com/feed";

// ---- helpers -------------------------------------------------------------

// A field may come back as a string, or an object (e.g. when attributes exist).
function pickText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return v["#text"] || v.__cdata || "";
  return "";
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Strip HTML tags and collapse whitespace.
function stripHtml(html) {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function makeExcerpt(html, words = 32) {
  const text = stripHtml(html);
  const parts = text.split(" ");
  return parts.length <= words ? text : parts.slice(0, words).join(" ") + "…";
}

// First <img src="..."> inside the post HTML.
function firstImage(html) {
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

// Substack sometimes exposes the cover via <enclosure url="..." type="image/...">
function enclosureImage(item) {
  const enc = item.enclosure;
  if (enc && enc["@_url"] && String(enc["@_type"] || "").startsWith("image")) {
    return enc["@_url"];
  }
  return null;
}

// ---- core parsing (exported so we can unit-test it without the network) ---

export function parseFeed(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const data = parser.parse(xml);
  const items = toArray(data?.rss?.channel?.item);

  return items.map((it) => {
    const content =
      pickText(it["content:encoded"]) || pickText(it.description) || "";
    return {
      title: pickText(it.title),
      link: pickText(it.link),
      pubDate: it.pubDate || null,
      excerpt: makeExcerpt(content),
      coverImage: firstImage(content) || enclosureImage(it) || null,
      categories: toArray(it.category).map(pickText).filter(Boolean),
    };
  });
}

// ---- Vercel serverless handler -------------------------------------------

export default async function handler(req, res) {
  try {
    const r = await fetch(FEED_URL, {
      headers: { "User-Agent": "KaitlynaryPortfolio/1.0 (+https://vercel.app)" },
    });
    if (!r.ok) throw new Error(`Feed responded ${r.status}`);
    const xml = await r.text();
    const posts = parseFeed(xml);

    // Cache at Vercel's edge ~10 min, serve stale while revalidating.
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    res.status(200).json({ error: false, posts });
  } catch (err) {
    // Friendly, non-breaking response so the UI can show an empty state.
    res.status(200).json({ error: true, message: "Could not load posts.", posts: [] });
  }
}
