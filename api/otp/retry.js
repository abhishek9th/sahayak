import { allow, checkBind, clientIp, fail, makeBind, normalizeMobile, otpFail, route, widget } from './_lib.js';

// POST { reqId, mobile, bind } -> { ok, reqId, bind }   (resend by SMS)
export default route(async (req, res) => {
  const reqId = String(req.body?.reqId || '');
  const mobile = normalizeMobile(req.body?.mobile);
  if (!reqId || !mobile) return fail(res, 400, 'INVALID_INPUT', 'reqId and mobile are required');
  if (!checkBind(reqId, mobile, req.body?.bind)) return fail(res, 400, 'INVALID_BIND', 'Please request a new OTP.');
  if (!allow(`retry:ip:${clientIp(req)}`, 10, 3600_000) || !allow(`retry:req:${reqId}`, 3, 15 * 60_000)) {
    return fail(res, 429, 'RATE_LIMITED', 'Too many OTP requests. Please wait a few minutes and try again.');
  }
  try {
    const data = await widget('retryOtp', { reqId, retryChannel: 11 }); // 11 = SMS
    const next = data.message || reqId;
    res.json({ ok: true, reqId: next, bind: makeBind(next, mobile) });
  } catch (err) {
    otpFail(res, err);
  }
});
