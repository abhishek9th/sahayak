import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// Shared helpers for the OTP functions that run on Vercel (a different outgoing address from Render, which MSG91 was
// refusing). These functions are stateless: nothing is remembered between calls, so the link between an OTP request and
// the mobile number it was sent to is carried in a signed "bind" value instead of server memory.
//
// Environment (set on Vercel): MSG91_APP_WIDGET_ID, MSG91_APP_WIDGET_TOKEN_AUTH, AUTH_SIGNING_SECRET (the SAME value as on
// Render, so proofs are valid in both places), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const BASE = 'https://control.msg91.com/api/v5/widget';
const BIND_TTL = 20 * 60_000;

const env = (k) => process.env[k] || '';
const secret = () => env('AUTH_SIGNING_SECRET');

export function fail(res, status, code, error) {
  res.status(status).json({ error, code });
}

export function normalizeMobile(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  return null;
}

const hmac = (s) => crypto.createHmac('sha256', secret()).update(s).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Signed statement "this reqId was sent to this mobile", valid for 20 minutes. */
export function makeBind(reqId, mobile, now = Date.now()) {
  const exp = now + BIND_TTL;
  return `${exp}.${hmac(`bind|${reqId}|${mobile}|${exp}`)}`;
}
export function checkBind(reqId, mobile, bind, now = Date.now()) {
  if (!secret() || !reqId || !mobile || typeof bind !== 'string') return false;
  const [exp, sig] = bind.split('.');
  if (!exp || !sig || Number(exp) < now) return false;
  return safeEq(sig, hmac(`bind|${reqId}|${mobile}|${exp}`));
}

// Same format as the Render server's sign-in proof, so either side accepts the other's.
export function signProof(mobile, ttlMs = 10 * 60_000) {
  const exp = Date.now() + ttlMs;
  return `${exp}.${crypto.createHmac('sha256', secret()).update(`${mobile}.${exp}`).digest('hex')}`;
}
export function checkProof(mobile, proof) {
  if (!secret() || !mobile || typeof proof !== 'string') return false;
  const [exp, sig] = proof.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, crypto.createHmac('sha256', secret()).update(`${mobile}.${exp}`).digest('hex'));
}

/** MSG91 mobile-widget call (the same endpoints MSG91's React Native SDK uses; no captcha). */
export async function widget(path, body) {
  const widgetId = env('MSG91_APP_WIDGET_ID');
  const tokenAuth = env('MSG91_APP_WIDGET_TOKEN_AUTH');
  if (!widgetId || !tokenAuth) throw Object.assign(new Error('OTP service is not configured'), { code: 'OTP_NOT_CONFIGURED' });
  let r;
  try {
    r = await fetch(`${BASE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ widgetId, tokenAuth, ...body }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw Object.assign(new Error('OTP service unreachable'), { code: 'OTP_UNREACHABLE' });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.type === 'error') throw Object.assign(new Error(data.message || 'OTP request failed'), { code: 'OTP_REJECTED' });
  return data;
}

export function otpFail(res, err) {
  if (err.code === 'OTP_NOT_CONFIGURED') return fail(res, 503, err.code, 'OTP service is not configured');
  if (err.code === 'OTP_UNREACHABLE') return fail(res, 502, err.code, 'OTP service is unreachable. Please try again.');
  return fail(res, 400, 'OTP_REJECTED', err.message || 'OTP request failed');
}

// Best-effort rate limit (per running instance only; MSG91 enforces its own limits too).
const hits = new Map();
export function allow(bucket, limit, windowMs, now = Date.now()) {
  const list = (hits.get(bucket) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(bucket, list);
    return false;
  }
  list.push(now);
  hits.set(bucket, list);
  if (hits.size > 2000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return true;
}
export const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

export function admin() {
  const url = env('SUPABASE_URL') || env('VITE_SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw Object.assign(new Error('not configured'), { code: 'SUPABASE_NOT_CONFIGURED' });
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Common wrapper: POST only, CORS for the app, JSON body. */
export function route(handler) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST');
    try {
      await handler(req, res);
    } catch (err) {
      console.error('otp function error:', err.message);
      fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
    }
  };
}
