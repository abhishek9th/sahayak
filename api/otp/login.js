import { admin, allow, checkProof, clientIp, fail, normalizeMobile, route } from './_lib.js';

// POST { mobile, proof } -> { ok, tokenHash }
// Passwordless sign-in for an EXISTING account after its mobile OTP was verified. The app exchanges tokenHash with
// supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }) to get a session.
export default route(async (req, res) => {
  const mobile = normalizeMobile(req.body?.mobile);
  if (!mobile) return fail(res, 400, 'INVALID_MOBILE', 'Invalid mobile number');
  if (!checkProof(mobile, req.body?.proof)) return fail(res, 401, 'OTP_NOT_VERIFIED', 'Please verify the OTP for this number first');
  if (!allow(`login:ip:${clientIp(req)}`, 20, 3600_000)) return fail(res, 429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.');
  let supabase;
  try {
    supabase = admin();
  } catch {
    return fail(res, 503, 'SUPABASE_NOT_CONFIGURED', 'Server is not configured');
  }
  const { data: prof, error } = await supabase.from('profiles').select('email').eq('phone', mobile).maybeSingle();
  if (error) return fail(res, 500, 'LOGIN_FAILED', 'Could not sign you in. Please try again.');
  if (!prof) return fail(res, 404, 'USER_NOT_FOUND', 'No account is registered with this mobile number');
  const { data, error: linkErr } = await supabase.auth.admin.generateLink({ type: 'magiclink', email: prof.email });
  if (linkErr || !data?.properties?.hashed_token) return fail(res, 500, 'LOGIN_FAILED', 'Could not sign you in. Please try again.');
  res.json({ ok: true, tokenHash: data.properties.hashed_token });
});
