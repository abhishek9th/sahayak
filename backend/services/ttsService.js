// Bhashini (when BHASHINI_API_KEY is set) is tried first, then the free voices below.
// ============================================================================
// Cloud text-to-speech so the chatbot can SPEAK in a user's own language even
// when their phone/PC has no voice installed for it. No API key, no cost.
//
//   1. Microsoft Edge neural voices (the free "Read aloud" service) — natural
//      voices for en, hi, bn, ta, te, mr, gu, kn, ml, ur.
//   2. Google Translate's free TTS — used for Punjabi (no Microsoft voice) and as
//      a fallback if Microsoft is unreachable.
//   Odia (or) has no free voice from either → 'UNSUPPORTED_LANGUAGE'; the
//   caller falls back to the device voice / shows text only.
//
// HONEST CAVEAT: both are the free public endpoints those products use, not
// contractual APIs — they could change or throttle. The service degrades
// gracefully (browser voice → text) and results are cached to keep calls low.
// ============================================================================
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { bhashiniEnabled, bhashiniSupportsTts, bhashiniSynthesize } from './bhashiniService.js';

const EDGE_VOICES = {
  en: 'en-IN-NeerjaNeural',
  hi: 'hi-IN-SwaraNeural',
  bn: 'bn-IN-TanishaaNeural',
  ta: 'ta-IN-PallaviNeural',
  te: 'te-IN-ShrutiNeural',
  mr: 'mr-IN-AarohiNeural',
  gu: 'gu-IN-DhwaniNeural',
  kn: 'kn-IN-SapnaNeural',
  ml: 'ml-IN-SobhanaNeural',
  ur: 'ur-IN-GulNeural',
};
const GOOGLE_LANGS = new Set(['en', 'hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'ur', 'pa']);

export const TTS_LANGUAGES = [...new Set([...Object.keys(EDGE_VOICES), ...GOOGLE_LANGS])];
// Env is read at call time (dotenv loads after imports); Bhashini adds a second Punjabi voice.
export const ttsSupports = (lang) => TTS_LANGUAGES.includes(lang) || (bhashiniEnabled() && bhashiniSupportsTts(lang));

const MAX_CHARS = 600;
const CACHE_MAX = 300;
const cache = new Map(); // `${lang}:${text}` -> { audio, contentType } (insertion-ordered → simple LRU)

function cacheGet(k) {
  if (!cache.has(k)) return null;
  const v = cache.get(k); cache.delete(k); cache.set(k, v); return v;
}
function cacheSet(k, v) {
  cache.set(k, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Remove things that sound bad when read aloud (markdown marks, URLs, emoji-ish symbols).
export function cleanForSpeech(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#`>~|\[\]{}]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);

async function edgeSynth(text, lang) {
  const tts = new MsEdgeTTS();
  try {
    await withTimeout(tts.setMetadata(EDGE_VOICES[lang], OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3), 10000, 'edge connect');
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    await withTimeout((async () => { for await (const c of audioStream) chunks.push(c); })(), 20000, 'edge synth');
    const buf = Buffer.concat(chunks);
    if (buf.length < 200) throw new Error('edge returned no audio');
    return buf;
  } finally {
    try { tts.close?.(); } catch { /* ignore */ }
  }
}

// Google's endpoint takes ~200 characters per request; split on sentence/space boundaries.
function splitForGoogle(text, max = 180) {
  const parts = []; let rest = text;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('।', max), rest.lastIndexOf('.', max), rest.lastIndexOf('?', max), rest.lastIndexOf('!', max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < 1) cut = max;
    parts.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function googleSynth(text, lang) {
  const bufs = [];
  for (const part of splitForGoogle(text)) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(part)}`;
    const res = await withTimeout(fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }), 12000, 'google tts');
    if (!res.ok || !(res.headers.get('content-type') || '').includes('audio')) throw new Error(`google tts ${res.status}`);
    bufs.push(Buffer.from(await res.arrayBuffer()));
  }
  const buf = Buffer.concat(bufs); // concatenated MP3 frames play back-to-back
  if (buf.length < 200) throw new Error('google returned no audio');
  return buf;
}

// Returns { audio: Buffer, contentType, provider } or throws an Error with .code.
export async function synthesize(rawText, lang) {
  if (!ttsSupports(lang)) { const e = new Error(`No free voice for "${lang}"`); e.code = 'UNSUPPORTED_LANGUAGE'; throw e; }
  const text = cleanForSpeech(rawText).slice(0, MAX_CHARS);
  if (!text) { const e = new Error('Nothing to speak'); e.code = 'EMPTY_TEXT'; throw e; }

  const key = `${lang}:${text}`;
  const hit = cacheGet(key);
  if (hit) return { audio: hit.audio, contentType: hit.contentType, provider: 'cache' };

  const order = [];
  if (bhashiniEnabled() && bhashiniSupportsTts(lang)) order.push(['bhashini', bhashiniSynthesize]);
  if (EDGE_VOICES[lang] && !process.env.TTS_DISABLE_EDGE) order.push(['edge', edgeSynth]);
  if (GOOGLE_LANGS.has(lang)) order.push(['google', googleSynth]);

  let lastErr;
  for (const [name, fn] of order) {
    try {
      const audio = await fn(text, lang);
      const contentType = name === 'bhashini' ? 'audio/wav' : 'audio/mpeg';
      cacheSet(key, { audio, contentType });
      return { audio, contentType, provider: name };
    } catch (err) { lastErr = err; console.warn(`tts ${name} failed (${lang}):`, err.message); }
  }
  const e = new Error(lastErr?.message || 'Speech synthesis unavailable'); e.code = 'TTS_FAILED'; throw e;
}

// Tiny per-IP limiter (this endpoint is public so signed-out visitors can hear the chatbot).
const hits = new Map();
export function allowRequest(ip, limit = 60, windowMs = 60_000) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) { hits.set(ip, { n: 1, reset: now + windowMs }); return true; }
  h.n += 1;
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  return h.n <= limit;
}
