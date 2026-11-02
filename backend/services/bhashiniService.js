// ============================================================================
// Bhashini (MeitY's national language platform) — speech-to-text and
// text-to-speech for all 12 app languages, including Odia which the free cloud
// voices lack. Uses the Dhruva inference pipeline API, authorised with the
// Bhashini "inference API key" (BHASHINI_API_KEY).
//
// Everything degrades gracefully: when no key is configured, or Bhashini is
// unreachable, callers fall back to Groq Whisper (STT) / Edge+Google (TTS).
// Model ids below are the public AI4Bharat defaults; override per env if
// Bhashini rotates them (BHASHINI_ASR_SERVICE_<GROUP>, BHASHINI_TTS_SERVICE_<GROUP>).
// ============================================================================

const pipelineUrl = () => process.env.BHASHINI_PIPELINE_URL || 'https://dhruva-api.bhashini.gov.in/services/inference/pipeline';

// language -> model group
const GROUP = {
  en: 'EN',
  hi: 'INDO', bn: 'INDO', gu: 'INDO', mr: 'INDO', or: 'INDO', pa: 'INDO', ur: 'INDO',
  ta: 'DRAV', te: 'DRAV', kn: 'DRAV', ml: 'DRAV',
};

const ASR_DEFAULT = {
  EN: 'ai4bharat/whisper-medium-en--gpu--t4',
  INDO: 'ai4bharat/conformer-multilingual-indo_aryan-gpu--t4',
  DRAV: 'ai4bharat/conformer-multilingual-dravidian-gpu--t4',
};
const TTS_DEFAULT = {
  EN: 'ai4bharat/indic-tts-coqui-misc-gpu--t4',
  INDO: 'ai4bharat/indic-tts-coqui-indo_aryan-gpu--t4',
  DRAV: 'ai4bharat/indic-tts-coqui-dravidian-gpu--t4',
};

export const bhashiniEnabled = () => Boolean(process.env.BHASHINI_API_KEY);
export const bhashiniSupports = (lang) => lang in GROUP;
// Odia speech synthesis hangs on the shared indo_aryan model (tested), so skip it for TTS.
export const bhashiniSupportsTts = (lang) => lang in GROUP && lang !== 'or';

const asrService = (lang) => process.env[`BHASHINI_ASR_SERVICE_${GROUP[lang]}`] || ASR_DEFAULT[GROUP[lang]];
const ttsService = (lang) => process.env[`BHASHINI_TTS_SERVICE_${GROUP[lang]}`] || TTS_DEFAULT[GROUP[lang]];

async function callPipeline(body, timeoutMs) {
  const res = await fetch(pipelineUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: process.env.BHASHINI_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`bhashini ${res.status}`);
  return res.json();
}

// Map an upload's content-type to Bhashini's audioFormat (wav is the safe default).
const audioFormatFor = (contentType = '') =>
  /flac/.test(contentType) ? 'flac' : /mpeg|mp3/.test(contentType) ? 'mp3' : /ogg/.test(contentType) ? 'ogg' : 'wav';

/** audio: Buffer (16 kHz mono WAV preferred). Returns the transcript string. */
export async function bhashiniTranscribe(audio, lang, contentType = 'audio/wav') {
  if (!bhashiniEnabled() || !bhashiniSupports(lang)) throw new Error('bhashini unavailable');
  const data = await callPipeline({
    pipelineTasks: [{
      taskType: 'asr',
      config: {
        language: { sourceLanguage: lang },
        serviceId: asrService(lang),
        audioFormat: audioFormatFor(contentType),
        samplingRate: 16000,
        postProcessors: ['itn'],
      },
    }],
    inputData: { audio: [{ audioContent: audio.toString('base64') }] },
  }, 30000);
  const text = data?.pipelineResponse?.[0]?.output?.[0]?.source;
  if (!text || !text.trim()) throw new Error('bhashini returned no transcript');
  return text.trim();
}

/** Returns a WAV Buffer of `text` spoken in `lang`. */
export async function bhashiniSynthesize(text, lang) {
  if (!bhashiniEnabled() || !bhashiniSupportsTts(lang)) throw new Error('bhashini unavailable');
  const data = await callPipeline({
    pipelineTasks: [{
      taskType: 'tts',
      config: {
        language: { sourceLanguage: lang },
        serviceId: ttsService(lang),
        gender: 'female',
        samplingRate: 22050,
      },
    }],
    inputData: { input: [{ source: text }] },
  }, 20000);
  const b64 = data?.pipelineResponse?.[0]?.audio?.[0]?.audioContent;
  if (!b64) throw new Error('bhashini returned no audio');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 200) throw new Error('bhashini returned no audio');
  return buf;
}

const NMT_SERVICE = () => process.env.BHASHINI_NMT_SERVICE || 'ai4bharat/indictrans-v2-all-gpu--t4';

/** Optional machine translation (opt-in: BHASHINI_NMT=true). Same length/order as `texts`. */
export const bhashiniNmtEnabled = () => bhashiniEnabled() && process.env.BHASHINI_NMT === 'true';
export async function bhashiniTranslate(texts, sourceLang, targetLang) {
  if (!bhashiniNmtEnabled()) throw new Error('bhashini nmt disabled');
  const data = await callPipeline({
    pipelineTasks: [{
      taskType: 'translation',
      config: { language: { sourceLanguage: sourceLang, targetLanguage: targetLang }, serviceId: NMT_SERVICE() },
    }],
    inputData: { input: texts.map((t) => ({ source: String(t ?? '') })) },
  }, 30000);
  const out = data?.pipelineResponse?.[0]?.output;
  if (!Array.isArray(out) || out.length !== texts.length) throw new Error('bhashini nmt bad response');
  return out.map((o, i) => (o?.target?.trim() ? o.target : String(texts[i] ?? '')));
}
