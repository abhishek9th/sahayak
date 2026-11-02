// Server-side validation of the MSG91 OTP Widget access token.
// The browser verifies the OTP via the MSG91 widget (window.verifyOtp) and
// receives an access token; we re-validate that token here with the secret
// authkey before trusting that the mobile was verified. The authkey stays
// server-side only.
const VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';

export function normalizeMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}

// Returns the MSG91 response on success; throws with a code on failure.
export async function verifyAccessToken(token) {
  if (!process.env.MSG91_AUTHKEY) {
    const err = new Error('OTP service not configured');
    err.code = 'OTP_NOT_CONFIGURED';
    throw err;
  }
  if (!token) {
    const err = new Error('Missing verification token');
    err.code = 'OTP_NOT_VERIFIED';
    throw err;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let data;
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authkey: process.env.MSG91_AUTHKEY, 'access-token': token }),
      signal: ctrl.signal,
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'OTP service timed out' : 'OTP service unreachable');
    err.code = 'OTP_NOT_VERIFIED';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (data.type !== 'success') {
    const err = new Error(data.message || 'OTP verification could not be confirmed');
    err.code = 'OTP_NOT_VERIFIED';
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------------------------
// Server-driven OTP for the Android app. The MSG91 *widget* is a browser script, which a native app
// cannot load, so the app calls these endpoints and the backend talks to MSG91's widget REST API
// with the widget id + token. The resulting access-token is later re-validated by verifyAccessToken()
// exactly like the web flow. Because this path has no CAPTCHA, it is throttled per mobile and per IP.
//
// NOTE: written against MSG91's documented widget REST shape (sendOtp / verifyOtp / retryOtp with
// widgetId + tokenAuth). It has NOT been exercised against a live MSG91 account from this repo —
// verify with a real SMS before relying on it.
// ---------------------------------------------------------------------------------------------
const WIDGET_BASE = () => process.env.MSG91_WIDGET_API_BASE || 'https://control.msg91.com/api/v5/widget';
// The app uses its own widget (Widget Integration = Mobile). The website keeps the browser widget (VITE_* / MSG91_WIDGET_*).
// MSG91's mobile flow has no captcha: it sends through /sendOtpMobile with widgetId + tokenAuth in the body, exactly like
// MSG91's React Native SDK does.
const widgetId = () => process.env.MSG91_APP_WIDGET_ID || process.env.MSG91_WIDGET_ID || process.env.VITE_MSG91_WIDGET_ID;
const widgetToken = () => process.env.MSG91_APP_WIDGET_TOKEN_AUTH || process.env.MSG91_WIDGET_TOKEN_AUTH || process.env.VITE_MSG91_TOKEN_AUTH;

export const otpWidgetConfigured = () => Boolean(widgetId() && widgetToken());

async function widgetCall(path, body) {
  if (!otpWidgetConfigured()) {
    const err = new Error('OTP service not configured');
    err.code = 'OTP_NOT_CONFIGURED';
    throw err;
  }
  let res;
  try {
    res = await fetch(`${WIDGET_BASE()}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', tokenAuth: widgetToken() },
      body: JSON.stringify({ widgetId: widgetId(), tokenAuth: widgetToken(), ...body }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    const err = new Error('OTP service unreachable');
    err.code = 'OTP_UNREACHABLE';
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.type === 'error') {
    const err = new Error(data.message || 'OTP request failed');
    err.code = 'OTP_REJECTED';
    throw err;
  }
  return data;
}

export const widgetSendOtp = (mobile) => widgetCall('sendOtpMobile', { identifier: mobile });
export const widgetRetryOtp = (reqId) => widgetCall('retryOtp', { reqId, retryChannel: 11 }); // 11 = SMS
export const widgetVerifyOtp = (reqId, otp) => widgetCall('verifyOtp', { reqId, otp });

// Small in-memory sliding-window limiter (resets on restart; enough to stop casual SMS bombing).
const hits = new Map();
export function allowOtpAction(bucket, limit, windowMs, now = Date.now()) {
  const list = (hits.get(bucket) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(bucket, list);
    return false;
  }
  list.push(now);
  hits.set(bucket, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return true;
}

// ---- bind every OTP to the mobile number it was sent to ----------------------------------------------
// MSG91 access tokens do not say WHICH number they verified, so without this a user could verify their
// own number and then log in as someone else's. The server remembers reqId -> mobile at send time and, on a
// successful verify, hands out a short-lived HMAC proof for exactly that mobile; /otp-login requires it.
import crypto from 'node:crypto';
const reqMobile = new Map();
export function rememberReq(reqId, mobile, opts = {}) {
  if (!reqId) return;
  reqMobile.set(String(reqId), { mobile, at: Date.now(), phone: Boolean(opts.phone) });
  if (reqMobile.size > 5000) for (const [k, v] of reqMobile) if (Date.now() - v.at > 20 * 60_000) reqMobile.delete(k);
}
/** True when the OTP was sent from the phone itself: the server then cannot be sure which number it went to. */
export function isPhoneReq(reqId) {
  const v = reqMobile.get(String(reqId));
  return Boolean(v && v.phone);
}
export function mobileForReq(reqId) {
  const v = reqMobile.get(String(reqId));
  return v && Date.now() - v.at < 20 * 60_000 ? v.mobile : null;
}
const secret = () => process.env.AUTH_SIGNING_SECRET;
export const proofsEnabled = () => Boolean(secret());
export function signProof(mobile, ttlMs = 10 * 60_000) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', secret()).update(mobile + '.' + exp).digest('hex');
  return exp + '.' + sig;
}
export function checkProof(mobile, proof) {
  if (!proofsEnabled() || !mobile || typeof proof !== 'string') return false;
  const [exp, sig] = proof.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', secret()).update(mobile + '.' + exp).digest('hex');
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
