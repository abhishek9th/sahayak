import express from 'express';

// Latest headlines about government schemes in India, from the public Google News RSS search feed.
// Headlines, publishers and links are passed through exactly as published — nothing is written or summarised
// by us — and the app shows the publisher name with every item. Cached for 30 minutes per language.
const router = express.Router();

const CACHE_MS = 30 * 60_000;
const cache = new Map();

const QUERY = '(government scheme OR yojana OR scholarship OR subsidy) India';
const FEEDS = {
  en: { hl: 'en-IN', gl: 'IN', ceid: 'IN:en', q: QUERY },
  hi: { hl: 'hi', gl: 'IN', ceid: 'IN:hi', q: 'सरकारी योजना' },
};

const decode = (s = '') =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
const tag = (block, name) => decode((block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1]);

export function parseFeed(xml, limit = 8) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const source = tag(block, 'source');
    let title = tag(block, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)); // Google appends the publisher
    const link = tag(block, 'link');
    const date = Date.parse(tag(block, 'pubDate'));
    if (title && /^https?:\/\//.test(link)) items.push({ title, link, source: source || null, publishedAt: Number.isNaN(date) ? null : new Date(date).toISOString() });
    if (items.length >= limit) break;
  }
  return items;
}

router.get('/', async (req, res) => {
  const lang = req.query.lang === 'hi' ? 'hi' : 'en';
  // ?within=1d asks Google News for the last day only (used by the bell); the default is the usual mixed feed.
  const day = req.query.within === '1d';
  const key = day ? `${lang}:1d` : lang;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return res.json({ items: hit.items, cached: true });
  try {
    const f = FEEDS[lang];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(day ? `${f.q} when:1d` : f.q)}&hl=${f.hl}&gl=${f.gl}&ceid=${f.ceid}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'SchemeSahayak/1.0' } });
    if (!r.ok) throw new Error(`news ${r.status}`);
    const items = parseFeed(await r.text(), day ? 20 : 8);
    cache.set(key, { at: Date.now(), items });
    res.json({ items });
  } catch (err) {
    console.error('news error:', err.message);
    // Serve stale headlines rather than nothing if the feed is briefly down.
    if (hit) return res.json({ items: hit.items, stale: true });
    res.status(502).json({ error: 'News is unavailable right now.', code: 'NEWS_UNAVAILABLE' });
  }
});

export default router;
