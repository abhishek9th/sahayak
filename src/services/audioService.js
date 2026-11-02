/**
 * Text-to-Speech (TTS) and Speech-to-Text (STT) Service
 *
 * Covers all 12 languages SchemeSahayak's UI supports (src/data/translations.js /
 * translationService.js LANG_NAMES) — not just Hindi/English — for both
 * reading pages aloud and the chatbot's voice replies.
 */

let synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
let currentUtterance = null;
let utteranceQueue = [];

// 2-letter app language code -> BCP-47 locale tag for speechSynthesis/SpeechRecognition.
const LANG_LOCALE = {
  en: 'en-IN',
  hi: 'hi-IN',
  pa: 'pa-IN',
  bn: 'bn-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  mr: 'mr-IN',
  gu: 'gu-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  or: 'or-IN',
  ur: 'ur-IN',
};

function localeFor(langCode) {
  return LANG_LOCALE[langCode] || (langCode?.includes('-') ? langCode : `${langCode}-IN`);
}

// Not every OS/browser ships a voice for every Indian language. If the exact
// locale has no installed voice, fall back to any voice sharing the language
// prefix, then to Hindi (broadly available), rather than silently speaking
// with the wrong voice's default language.
function resolveVoice(locale) {
  if (!synth) return null;
  const voices = synth.getVoices();
  if (!voices.length) return null;
  const langPrefix = locale.split('-')[0];
  return (
    voices.find((v) => v.lang === locale) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith(langPrefix)) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith('hi')) ||
    null
  );
}

// Split text into chunks for long texts
function splitTextIntoChunks(text, maxLength = 200) {
  if (text.length <= maxLength) {
    return [text];
  }
  
  const chunks = [];
  let currentChunk = '';
  
  // Split by sentences (periods, exclamation, question marks)
  const sentences = text.split(/(?<=[।!?])\s+/);
  
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length <= maxLength) {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = sentence;
    }
  }
  
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

// ---------------------------------------------------------------------------
// Cloud voice. When the device has no installed voice for the chosen language,
// the server (/api/tts — Bhashini when configured, else free Microsoft neural / Google voices, see
// backend/services/ttsService.js) returns the speech as MP3 so the chatbot can
// still speak Tamil, Bengali, Telugu… on any phone. Languages the server has no
// free voice for (currently Odia) fall through to the device voice / silence.
// ---------------------------------------------------------------------------
const API_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || '';
const CLOUD_LANGS = new Set(['en', 'hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'ur', 'pa', 'or']);
let currentAudio = null;
let cloudSession = 0;
let cloudAbort = null;

function hasInstalledVoice(locale) {
  if (!synth) return false;
  const prefix = locale.split('-')[0];
  return synth.getVoices().some((v) => v.lang?.toLowerCase().startsWith(prefix));
}

function playUrl(url, session) {
  return new Promise((resolve, reject) => {
    if (session !== cloudSession) { URL.revokeObjectURL(url); return resolve(); }
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('audio playback failed')); };
    audio.play().catch((e) => { URL.revokeObjectURL(url); reject(e); });
  });
}

// Fetches each chunk from the server while the previous one plays, so speech is continuous.
function readViaCloud(text, lang, langCode, onEnd) {
  stopTextAloud();
  const session = ++cloudSession;
  const chunks = splitTextIntoChunks(text, 220);
  cloudAbort = new AbortController();
  const signal = cloudAbort.signal;
  const fetchChunk = (t) => fetch(`${API_BASE}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ text: t, lang }),
    signal,
  }).then((r) => { if (!r.ok) throw new Error(`tts ${r.status}`); return r.blob(); }).then((b) => URL.createObjectURL(b));

  (async () => {
    let next = fetchChunk(chunks[0]);
    try {
      for (let i = 0; i < chunks.length; i++) {
        const url = await next;
        if (session !== cloudSession) { URL.revokeObjectURL(url); return; }
        if (i + 1 < chunks.length) next = fetchChunk(chunks[i + 1]);
        await playUrl(url, session);
        if (session !== cloudSession) return;
      }
      onEnd();
    } catch (err) {
      if (session !== cloudSession || err?.name === 'AbortError') return; // stopped on purpose
      console.warn('Cloud voice unavailable, using the device voice:', err.message);
      readWithBrowser(text, langCode, onEnd); // graceful fallback
    }
  })();
  return true;
}

// The voice must match the language the TEXT is actually written in, not just the
// language the site is set to — otherwise a Tamil voice ends up reading Hindi
// (or English) text as noise. Pick by the dominant script; ambiguous cases keep
// the site language (e.g. Devanagari is Marathi when the site is Marathi).
const SCRIPTS = [
  ['hi', /[ऀ-ॿ]/g], ['bn', /[ঀ-৿]/g], ['pa', /[਀-੿]/g], ['gu', /[઀-૿]/g],
  ['or', /[଀-୿]/g], ['ta', /[஀-௿]/g], ['te', /[ఀ-౿]/g], ['kn', /[ಀ-೿]/g],
  ['ml', /[ഀ-ൿ]/g], ['ur', /[؀-ۿ]/g], ['en', /[A-Za-z]/g],
];
export function speechLangFor(text, siteLang) {
  let best = null; let bestCount = 0; let latin = 0;
  for (const [lang, re] of SCRIPTS) {
    const n = (String(text).match(re) || []).length;
    if (lang === 'en') { latin = n; continue; }
    if (n > bestCount) { best = lang; bestCount = n; }
  }
  // A few Latin words (e.g. the brand name "SchemeSahayak") must not turn a Tamil/Hindi
  // sentence into an English one: a native script wins unless Latin clearly dominates.
  if (best && bestCount >= latin * 0.3) return best === 'hi' && siteLang === 'mr' ? 'mr' : best;
  if (latin > 0) return 'en';
  return siteLang;
}

export function readTextAloud(text, langCode = 'hi-IN', onEnd = () => {}) {
  const siteLang = localeFor(langCode).split('-')[0];
  const lang = speechLangFor(text, siteLang);
  const code = lang === siteLang ? langCode : lang;
  if (CLOUD_LANGS.has(lang) && !hasInstalledVoice(localeFor(code))) {
    return readViaCloud(text, lang, code, onEnd);
  }
  return readWithBrowser(text, code, onEnd);
}

function readWithBrowser(text, langCode = 'hi-IN', onEnd = () => {}) {
  if (!synth) {
    console.warn("Audio speech output is not supported in this browser.");
    return false;
  }
  // No installed voice and no cloud voice (e.g. Odia): a Hindi voice cannot read this script.
  const prefix = localeFor(langCode).split('-')[0];
  if (!hasInstalledVoice(localeFor(langCode)) && !['hi', 'mr', 'en'].includes(prefix)) return false;

  // Cancel any ongoing speech
  synth.cancel();
  utteranceQueue = [];

  const chunks = splitTextIntoChunks(text, 200);
  let currentChunkIndex = 0;

  const speakNextChunk = () => {
    if (currentChunkIndex >= chunks.length) {
      currentUtterance = null;
      onEnd();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(chunks[currentChunkIndex]);
    const locale = localeFor(langCode);
    const voice = resolveVoice(locale);
    utterance.lang = voice?.lang || locale;
    if (voice) utterance.voice = voice;
    utterance.rate = 0.9; // Slightly slower for rural clarity
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onend = () => {
      currentChunkIndex++;
      speakNextChunk();
    };

    utterance.onerror = (error) => {
      console.error('Speech synthesis error:', error);
      currentChunkIndex++;
      speakNextChunk();
    };

    try {
      currentUtterance = utterance;
      synth.speak(utterance);
    } catch (error) {
      console.error('Error starting speech:', error);
      currentChunkIndex++;
      speakNextChunk();
    }
  };

  speakNextChunk();
  return true;
}

export function stopTextAloud() {
  cloudSession++; // invalidates any in-flight cloud playback
  try { cloudAbort?.abort(); } catch { /* ignore */ }
  cloudAbort = null;
  if (currentAudio) { try { currentAudio.pause(); } catch { /* ignore */ } currentAudio = null; }
  if (synth) {
    synth.cancel();
    currentUtterance = null;
  }
}

export function isSpeaking() {
  return Boolean((currentAudio && !currentAudio.paused) || (synth && synth.speaking));
}

/**
 * Speech Recognition (Speech-to-Text) wrapper
 */
export function startVoiceRecognition(onResult, onError, langCode = 'hi-IN') {
  const SpeechRecognition = typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  if (!SpeechRecognition) {
    onError("Voice typing is not supported in this browser. Please type your query.");
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = localeFor(langCode);
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    onResult(transcript);
  };

  recognition.onerror = (event) => {
    onError(event.error || "Voice recognition failed.");
  };

  recognition.start();
  return recognition;
}
