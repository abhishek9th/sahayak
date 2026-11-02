import { startVoiceRecognition } from './audioService';

let recorder;
let stream;
let chunks = [];

export async function startGroqRecording() {
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  chunks = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  recorder.start();
}

// Bhashini's speech recogniser wants 16 kHz mono WAV, but MediaRecorder gives webm/opus.
// Decode and re-encode in the browser; if that fails, send the original recording.
async function toWav16k(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const pcm = (await offline.startRendering()).getChannelData(0);
    const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const str = (o, t) => [...t].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, pcm.length * 2, true);
    pcm.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
    return new Blob([view], { type: 'audio/wav' });
  } finally { ctx.close?.(); }
}

export function stopGroqRecording(lang = '') {
  return new Promise((resolve, reject) => {
    if (!recorder || recorder.state === 'inactive') return reject(new Error('No active recording'));
    recorder.onstop = async () => {
      try {
        const raw = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (!raw.size) throw new Error('Empty recording');
        const audio = await toWav16k(raw).catch(() => raw);
        const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/voice/transcribe?lang=${encodeURIComponent(lang)}`, { method: 'POST', headers: { 'Content-Type': audio.type || 'audio/webm' }, body: audio });
        if (!response.ok) throw new Error('Transcription unavailable');
        const { text } = await response.json();
        if (!text?.trim()) throw new Error('Empty transcription');
        resolve(text.trim());
      } catch (error) { reject(error); }
      finally { cleanupRecording(); }
    };
    recorder.stop();
  });
}

export function cleanupRecording() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  recorder = null;
  chunks = [];
}

export function startBrowserFallback(onResult, onError, language) {
  return startVoiceRecognition(onResult, onError, language);
}
