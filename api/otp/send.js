import { allow, clientIp, fail, makeBind, normalizeMobile, otpFail, route, widget } from './_lib.js';

// POST { mobile } -> { ok, reqId, bind }   (bind proves to the later calls which number this OTP went to)
export default route(async (req, res) => {
  const mobile = normalizeMobile(req.body?.mobile);
  if (!mobile) return fail(res, 400, 'INVALID_MOBILE', 'Please enter a valid 10-digit mobile number');
  if (!allow(`send:ip:${clientIp(req)}`, 10, 3600_000) || !allow(`send:mobile:${mobile}`, 3, 15 * 60_000)) {
    return fail(res, 429, 'RATE_LIMITED', 'Too many OTP requests. Please wait a few minutes and try again.');
  }
  try {
    const data = await widget('sendOtpMobile', { identifier: mobile });
    res.json({ ok: true, reqId: data.message, bind: makeBind(data.message, mobile) });
  } catch (err) {
    otpFail(res, err);
  }
});
