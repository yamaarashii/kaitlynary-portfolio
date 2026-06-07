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

// Decode HTML entities: numeric hex, numeric decimal, and common named ones.
function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // keep &amp; last so it doesn't double-decode
}

// Strip HTML tags, decode entities, collapse whitespace.
function stripHtml(html) {
  const noTags = String(html).replace(/<[^>]*>/g, " ");
  return decodeEntities(noTags).replace(/\s+/g, " ").trim();
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

// Posts to hide from the portfolio. Add a title here (case-insensitive) to exclude it.
const EXCLUDE = ["unpublished thoughts"];

function isExcluded(post) {
  const hay = `${post.title} ${post.link}`.toLowerCase();
  return EXCLUDE.some((term) => hay.includes(term.toLowerCase()));
}

export function parseFeed(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const data = parser.parse(xml);
  const items = toArray(data?.rss?.channel?.item);

  return items
    .map((it) => {
      const body = pickText(it["content:encoded"]) || "";
      const subtitle = pickText(it.description) || "";
      // Prefer the post's subtitle for the card; fall back to the body only if there's no subtitle.
      const excerptSource = subtitle.trim() ? subtitle : body;
      return {
        title: decodeEntities(pickText(it.title)),
        link: pickText(it.link),
        pubDate: it.pubDate || null,
        excerpt: makeExcerpt(excerptSource),
        coverImage: firstImage(body) || enclosureImage(it) || null,
      };
    })
    .filter((post) => !isExcluded(post));
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
