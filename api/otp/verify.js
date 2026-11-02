import { allow, checkBind, clientIp, fail, normalizeMobile, otpFail, route, signProof, widget } from './_lib.js';

// POST { reqId, mobile, bind, otp } -> { ok, verificationToken, mobile, proof }
// `proof` is what /login (and any other server that shares AUTH_SIGNING_SECRET) accepts as "this mobile was verified".
export default route(async (req, res) => {
  const reqId = String(req.body?.reqId || '');
  const mobile = normalizeMobile(req.body?.mobile);
  const otp = String(req.body?.otp || '').replace(/\D/g, '');
  if (!reqId || !mobile || otp.length < 4) return fail(res, 400, 'INVALID_INPUT', 'reqId, mobile and otp are required');
  if (!checkBind(reqId, mobile, req.body?.bind)) return fail(res, 400, 'INVALID_BIND', 'Please request a new OTP.');
  if (!allow(`verify:req:${reqId}`, 6, 15 * 60_000) || !allow(`verify:ip:${clientIp(req)}`, 30, 3600_000)) {
    return fail(res, 429, 'RATE_LIMITED', 'Too many attempts. Please request a new OTP.');
  }
  try {
    const data = await widget('verifyOtp', { reqId, otp });
    res.json({ ok: true, verificationToken: data.message, mobile, proof: signProof(mobile) });
  } catch (err) {
    otpFail(res, err);
  }
});
