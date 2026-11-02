import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import userProfileService from './services/userProfileService.js';
import { translateBatch, LANG_NAMES } from './services/translationService.js';
import authRouter from './routes/auth.js';
import journeyRouter from './routes/journey.js';
import credentialsRouter from './routes/credentials.js';
import identityRouter from './routes/identity.js';
import bankAccountsRouter from './routes/bankAccounts.js';
import consentsRouter from './routes/consents.js';
import readinessRouter from './routes/readiness.js';
import partnersRouter from './routes/partners.js';
import catalogueRouter from './routes/catalogue.js';
import eligibilityRouter from './routes/eligibility.js';
import documentsRouter from './routes/documents.js';
import conflictsRouter from './routes/conflicts.js';
import advisorRouter from './routes/advisor.js';
import notificationsRouter from './routes/notifications.js';
import savedRouter from './routes/saved.js';
import newsRouter from './routes/news.js';
import visionRouter from './routes/vision.js';
import lockerRouter from './routes/locker.js';
import { synthesize, allowRequest } from './services/ttsService.js';
import { bhashiniEnabled, bhashiniSupports, bhashiniTranscribe, bhashiniTranslate, bhashiniNmtEnabled } from './services/bhashiniService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' })); // room for base64 live-photo in /api/auth/register
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Liveness ping used two ways: (1) the frontend fires it on the login screen
// mounting to wake a sleeping Render free-tier instance (~50s cold start)
// before the user submits a form, and (2) a GitHub Actions cron hits it every
// 10 min to keep Render from ever going idle. It also does one trivial
// Supabase read so that same cron keeps the Supabase free-tier project from
// auto-pausing after ~7 days of no DB activity (Render being awake alone
// doesn't touch the DB) — this caused a real prod outage once (every DB-backed
// route 500ing while this endpoint stayed fine), so `supabase` in the response
// is a real diagnostic, not decoration. Never itself fails: a Supabase hiccup
// still returns 200 so the Render keep-warm ping isn't taken down by it.
app.get('/api/health', async (req, res) => {
  let supabase = 'skipped';
  try {
    const { getSupabaseAdmin } = await import('./services/supabaseAdmin.js');
    const { error } = await getSupabaseAdmin().from('profiles').select('id').limit(1);
    supabase = error ? `error: ${error.message}` : 'ok';
  } catch (err) {
    supabase = `error: ${err.message}`;
  }
  res.json({ ok: true, supabase });
});

// Authentication: registration OTP (MSG91), user creation (Supabase Auth), login helpers.
app.use('/api/auth', authRouter);

// Guided application journey (state machine, OTP/consent pauses, status tracking).
app.use('/api/journey', journeyRouter);

// Encrypted, opt-in portal credential storage for automatic status tracking.
app.use('/api/credentials', credentialsRouter);

// Encrypted government-ID (Aadhaar/PAN) and bank-account storage, plus the
// consent audit trail — see supabase/migrations/20260915_profile_extension.sql
// and 20260916_sensitive_identity_bank.sql.
app.use('/api/identity', identityRouter);
app.use('/api/bank-accounts', bankAccountsRouter);
app.use('/api/consents', consentsRouter);

// Application Readiness & Document Checker — data-driven requirement engine
// + Groq explanation layer, and the nearby assistance-center directory.
app.use('/api/readiness', readinessRouter);
app.use('/api/partners', partnersRouter);

// Native browse/search over the full ~4,770-scheme myscheme.gov.in catalogue
// (scraped, not AI-generated — see backend/scripts/scrapeSchemeIndex.mjs).
app.use('/api/catalogue', catalogueRouter);

// Proactive eligibility engine — "what can I claim now?" for the signed-in
// user, evaluated deterministically across all curated schemes.
app.use('/api/eligibility', eligibilityRouter);

// Document vault — what the user has, what's missing, and how many schemes
// each missing document would unlock.
app.use('/api/documents', documentsRouter);

// Scheme conflict engine — official-rule-driven mutual-exclusion detection.
app.use('/api/conflicts', conflictsRouter);
app.use('/api/advisor', advisorRouter);

// Android app: push-device registration, notification preferences + in-app inbox, saved schemes.
app.use('/api/notifications', notificationsRouter);
app.use('/api/saved', savedRouter);

// Latest scheme-related headlines (Google News RSS, cached).
app.use('/api/news', newsRouter);

// Reads a scheme banner/poster photo and matches it against the real catalogue.
app.use('/api/vision', visionRouter);

// Sahayak Locker PIN (set / verify / change).
app.use('/api/locker', lockerRouter);

// Endpoint to understand natural language or partial profile using Groq
app.post('/api/analyze-user', async (req, res) => {
  try {
    const { query, currentProfile, language } = req.body;
    
    // Validate input
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query is required and must be non-empty' });
    }
    
    if (!process.env.GROQ_API_KEY) {
      console.error('GROQ_API_KEY is not configured in environment variables');
      return res.status(503).json({ error: 'Service configuration error. Please try again later.' });
    }
    
    const profile = await userProfileService.analyzeProfile(query, currentProfile, language);
    res.json(profile);
  } catch (error) {
    console.error('Profile analysis error:', error.message);
    
    // Specific error handling
    if (error.message.includes('API key') || error.message.includes('authentication')) {
      return res.status(503).json({ error: 'Service authentication failed. Please try again.' });
    }
    
    if (error.message.includes('rate_limit')) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    
    if (error.message.includes('timeout') || error.message.includes('ECONNREFUSED')) {
      return res.status(504).json({ error: 'Service timeout. Please try again.' });
    }
    
    res.status(500).json({ error: 'Failed to analyze user profile' });
  }
});

// Suggests real government schemes beyond SchemeSahayak's own structured catalogue
// (see userProfileService.suggestAdditionalSchemes for the honesty rules —
// Groq never invents a scheme or its numbers, only names real ones it knows).
app.post('/api/schemes/suggest', async (req, res) => {
  try {
    const { criteria, language, alreadyShown } = req.body || {};
    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({ error: 'Service configuration error. Please try again later.' });
    }
    const suggestions = await userProfileService.suggestAdditionalSchemes(
      { ...criteria, already_shown: Array.isArray(alreadyShown) ? alreadyShown : [] },
      language
    );
    res.json({ suggestions });
  } catch (error) {
    console.error('Scheme suggestion error:', error.message);
    if (error.message?.includes('rate_limit')) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    res.status(502).json({ error: 'Could not fetch additional scheme suggestions right now.' });
  }
});

// Batch translation endpoint for on-demand UI + scheme-content localisation.
app.post('/api/translate', async (req, res) => {
  try {
    const { texts, targetLang, sourceLang } = req.body || {};

    if (!Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({ error: 'texts must be a non-empty array' });
    }
    if (texts.length > 100) {
      return res.status(400).json({ error: 'Too many texts in one request (max 100)' });
    }
    if (!targetLang || !LANG_NAMES[targetLang]) {
      return res.status(400).json({ error: 'A valid targetLang is required' });
    }
    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({ error: 'Service configuration error.' });
    }

    let translations;
    const src = sourceLang || 'en';
    if (bhashiniNmtEnabled() && bhashiniSupports(targetLang) && bhashiniSupports(src) && src !== targetLang) {
      try { translations = await bhashiniTranslate(texts, src, targetLang); }
      catch (err) { console.warn('Bhashini NMT failed, using Groq:', err.message); }
    }
    translations ||= await translateBatch(texts, targetLang, src);
    res.json({ translations });
  } catch (error) {
    console.error('Translation error:', error.message);
    if (error.message && error.message.includes('rate_limit')) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
    res.status(502).json({ error: 'Translation unavailable' });
  }
});

// Cloud text-to-speech (free): lets the chatbot speak in a user's language even when their
// device has no voice installed for it. See services/ttsService.js for providers/limits.
app.post('/api/tts', async (req, res) => {
  try {
    const { text, lang } = req.body || {};
    if (typeof text !== 'string' || !text.trim() || typeof lang !== 'string') {
      return res.status(400).json({ error: 'text and lang are required', code: 'INVALID_INPUT' });
    }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!allowRequest(ip)) return res.status(429).json({ error: 'Too many speech requests. Please wait a moment.', code: 'RATE_LIMITED' });
    const { audio, contentType, provider } = await synthesize(text, lang);
    res.set({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400', 'X-TTS-Provider': provider });
    res.send(audio);
  } catch (error) {
    if (error.code === 'UNSUPPORTED_LANGUAGE') return res.status(501).json({ error: error.message, code: error.code });
    if (error.code === 'EMPTY_TEXT') return res.status(400).json({ error: error.message, code: error.code });
    console.error('TTS error:', error.message);
    res.status(502).json({ error: 'Speech is unavailable right now', code: 'TTS_FAILED' });
  }
});

// Which voice providers are live (never exposes the key) — handy for debugging deploys.
app.get('/api/voice/status', (req, res) => {
  res.json({ bhashini: bhashiniEnabled(), bhashiniNmt: bhashiniNmtEnabled(), groqFallback: Boolean(process.env.GROQ_API_KEY) });
});

const WHISPER_LANGS = new Set(['en', 'hi', 'bn', 'gu', 'kn', 'ml', 'mr', 'pa', 'ta', 'te', 'ur']);

// Audio stays in memory only long enough to send it to Groq Whisper.
app.post('/api/voice/transcribe', express.raw({ type: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/flac', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac'], limit: '12mb' }), async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'No audio received' });
    // Bhashini first (understands all 12 app languages, WAV input); Groq Whisper is the fallback.
    const lang = String(req.query.lang || '');
    if (bhashiniEnabled() && bhashiniSupports(lang) && !/webm|mp4|m4a|aac/.test(req.headers['content-type'] || '')) { // those need converting; Groq handles them
      try {
        return res.json({ text: await bhashiniTranscribe(req.body, lang, req.headers['content-type'] || ''), provider: 'bhashini' });
      } catch (err) {
        console.warn(`Bhashini ASR failed (${lang}), falling back to Groq:`, err.message);
      }
    }
    const groq = new (await import('groq-sdk')).default({ apiKey: process.env.GROQ_API_KEY });
    const ct = req.headers['content-type'] || '';
    const extension = ct.includes('ogg') ? 'ogg' : ct.includes('wav') ? 'wav' : /mp4|m4a/.test(ct) ? 'm4a' : ct.includes('aac') ? 'aac' : /mpeg|mp3/.test(ct) ? 'mp3' : ct.includes('flac') ? 'flac' : 'webm';
    const audioFile = new File([req.body], `schemesetu-recording.${extension}`, { type: req.headers['content-type'] || 'audio/webm' });
    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3-turbo',
      response_format: 'json',
      // Language hint helps short utterances; Whisper has no Odia model, so Odia stays on auto-detect.
      ...(WHISPER_LANGS.has(String(req.query.lang || '')) ? { language: String(req.query.lang) } : {})
    });
    res.json({ text: transcription.text || '' });
  } catch {
    res.status(502).json({ error: 'Voice transcription unavailable' });
  }
});

// --- Serve the built frontend (single-service deployment, e.g. Render) ---
// `npm run build` outputs to ../dist. In production this server hosts both the
// static site and the /api routes on the same origin, so no CORS/proxy config
// is needed. In local dev you use Vite (port 3000) instead and this is a no-op
// when dist/ hasn't been built.
const distDir = path.resolve(__dirname, '../dist');
app.use(express.static(distDir));

// SPA fallback: any non-API GET returns index.html. (Express 5 dropped bare "*"
// route strings, so this is written as middleware.)
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) next();
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Secure AI Backend API running on port ${PORT}`);
});
