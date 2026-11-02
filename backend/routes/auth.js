import express from 'express';
import { getSupabaseAdmin } from '../services/supabaseAdmin.js';
import { verifyAccessToken, normalizeMobile, widgetSendOtp, widgetRetryOtp, widgetVerifyOtp, allowOtpAction, rememberReq, mobileForReq, isPhoneReq, signProof, checkProof, proofsEnabled } from '../services/otpService.js';

const router = express.Router();

// Map internal error codes -> HTTP status + user-facing message.
function fail(res, code, fallback, status = 400) {
  return res.status(status).json({ error: fallback, code });
}

// OTP send/verify/retry happen client-side via the MSG91 OTP Widget. The browser
// sends us the resulting access token in /register, which we re-validate here.

// Decode a data URL or bare base64 string into a Buffer.
function decodeImage(photoBase64) {
  if (!photoBase64 || typeof photoBase64 !== 'string') return null;
  const comma = photoBase64.indexOf(',');
  const raw = photoBase64.startsWith('data:') && comma !== -1 ? photoBase64.slice(comma + 1) : photoBase64;
  try {
    const buf = Buffer.from(raw, 'base64');
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// DEV/TESTING ONLY: REGISTER_REPLACE_EXISTING=true lets a number that already has an account
// register again as a brand-new user; the old account and all its data are deleted first.
// Never enable in production — the OTP token is not bound to the submitted number here, so
// anyone could otherwise wipe another person's account by registering their number.
const REPLACE_EXISTING = process.env.REGISTER_REPLACE_EXISTING === 'true';

async function removeAccountsByPhone(supabase, phone) {
  const { data: rows, error } = await supabase.from('profiles').select('id').eq('phone', phone);
  if (error) throw error;
  for (const { id } of rows || []) {
    const { data: files } = await supabase.storage.from('faces').list(id);
    if (files?.length) await supabase.storage.from('faces').remove(files.map((f) => `${id}/${f.name}`)).catch(() => {});
    await supabase.from('profiles').delete().eq('id', id);
    const { error: delErr } = await supabase.auth.admin.deleteUser(id); // cascades to the user's other tables
    if (delErr) throw delErr;
  }
}

// POST /api/auth/register
// { email, password, fullName, mobile, verificationToken, photoBase64, profile }
// Creates the Supabase Auth user (email identity; password hashed by Supabase),
// uploads the mandatory live photo to the private "faces" bucket, and inserts
// the linked profiles row. Phone OTP must already have been verified.
router.post('/register', async (req, res) => {
  const { email, password, fullName, mobile, verificationToken, photoBase64, profile = {} } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  const normMobile = normalizeMobile(mobile);
  const name = String(fullName || '').trim();

  // --- Validation of the mandatory fields ---
  if (!EMAIL_RE.test(mail)) return fail(res, 'INVALID_EMAIL', 'Please enter a valid email address');
  if (String(password || '').length < 6) return fail(res, 'WEAK_PASSWORD', 'Password must be at least 6 characters');
  if (!name) return fail(res, 'INVALID_NAME', 'Full name is required');
  if (!normMobile) return fail(res, 'INVALID_MOBILE', 'Invalid mobile number');
  const photo = decodeImage(photoBase64);
  if (!photo) return fail(res, 'PHOTO_REQUIRED', 'A live photo is required to create your profile');

  // --- Validation of the optional profile fields (only checked if provided) ---
  if (profile.age !== undefined && profile.age !== null && profile.age !== '') {
    const ageNum = Number(profile.age);
    if (!Number.isInteger(ageNum) || ageNum < 0 || ageNum > 120) return fail(res, 'INVALID_AGE', 'Please select a valid age');
  }
  if (profile.pincode && !/^[0-9]{6}$/.test(String(profile.pincode).trim())) {
    return fail(res, 'INVALID_PINCODE', 'PIN code must be 6 digits');
  }
  if (profile.date_of_birth) {
    const dob = new Date(profile.date_of_birth);
    if (Number.isNaN(dob.getTime()) || dob > new Date()) return fail(res, 'INVALID_DOB', 'Please enter a valid date of birth');
  }

  // Re-validate the MSG91 widget access token server-side (secret authkey).
  // Dev escape hatch: OTP_SERVER_VERIFY=false trusts the client-side OTP the
  // widget already verified (use ONLY in development — set it to true in prod
  // once a real MSG91 account Auth Key is configured).
  if (process.env.OTP_SERVER_VERIFY !== 'false') {
    try {
      await verifyAccessToken(verificationToken);
    } catch (err) {
      console.error('access token validation failed:', err.code || '', err.message);
      if (err.code === 'OTP_NOT_CONFIGURED') return fail(res, err.code, 'OTP service is not configured', 503);
      return fail(res, 'OTP_NOT_VERIFIED', 'Please verify your mobile number with OTP first', 401);
    }
  } else {
    console.warn('[dev] OTP_SERVER_VERIFY=false — skipping MSG91 token re-validation for /register');
  }

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (err) {
    return fail(res, err.code || 'SUPABASE_NOT_CONFIGURED', 'Server is not configured', 503);
  }

  let authId = null;
  let uploadedPath = null;
  try {
    // Friendly uniqueness checks before creating anything.
    const { data: existing, error: exErr } = await supabase
      .from('profiles')
      .select('email, phone')
      .or(`email.eq.${mail},phone.eq.${normMobile}`)
      .limit(1)
      .maybeSingle();
    if (exErr) throw exErr;
    if (REPLACE_EXISTING) {
      // Re-registering a number replaces its old account (and all its data) with the new one.
      await removeAccountsByPhone(supabase, normMobile);
      const { data: sameEmail } = await supabase.from('profiles').select('id').eq('email', mail).maybeSingle();
      if (sameEmail) return fail(res, 'EMAIL_REGISTERED', 'This email is already registered. Please log in.', 409);
    } else {
      if (existing?.email === mail) return fail(res, 'EMAIL_REGISTERED', 'This email is already registered. Please log in.', 409);
      if (existing?.phone === normMobile) return fail(res, 'MOBILE_REGISTERED', 'This mobile number is already registered. Please log in.', 409);
    }

    // Create the auth user (Supabase stores a bcrypt hash of the password).
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: mail,
      password,
      email_confirm: true, // no confirmation email; account is active immediately
      user_metadata: { full_name: name, phone: normMobile },
    });
    if (createErr) {
      if (/already been registered|already exists|duplicate/i.test(createErr.message))
        return fail(res, 'EMAIL_REGISTERED', 'This email is already registered. Please log in.', 409);
      throw createErr;
    }
    authId = created.user.id;

    // Upload the mandatory live photo to the private faces bucket at <uid>/...
    uploadedPath = `${authId}/live_${Date.now()}.jpg`;
    const { error: upErr } = await supabase.storage
      .from('faces')
      .upload(uploadedPath, photo, { contentType: 'image/jpeg', upsert: true });
    if (upErr) throw upErr;

    // Insert the linked profile row (live_photo_url now satisfied).
    const baseRow = {
      id: authId,
      email: mail,
      full_name: name,
      phone: normMobile,
      live_photo_url: uploadedPath,
      state: profile.state || null,
      gender: profile.gender || null,
      social_category: profile.social_category || null,
      date_of_birth: profile.date_of_birth || null,
      age: profile.age ? Number(profile.age) : null,
      spouse_name: profile.spouse_name || null,
      address: profile.address || null,
      pincode: profile.pincode || null,
      education_level: profile.education_level || null, // "qualification"
    };
    let { error: profErr } = await supabase.from('profiles').insert(baseRow);

    // Self-heal: if the table still has the old NOT NULL legacy columns
    // (user_id / mobile) from the first schema, satisfy them and retry so
    // registration works even before the cleanup migration is run.
    if (profErr && /null value in column "(user_id|mobile)"/.test(profErr.message)) {
      ({ error: profErr } = await supabase
        .from('profiles')
        .insert({ ...baseRow, user_id: authId, mobile: normMobile }));
    }

    if (profErr) {
      if (/duplicate|unique/i.test(profErr.message))
        return fail(res, 'EMAIL_REGISTERED', 'This account already exists. Please log in.', 409);
      throw profErr;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('register error:', err.code || '', err.message);
    // Best-effort rollback so we don't leave an orphaned auth user or file.
    if (uploadedPath) await supabase.storage.from('faces').remove([uploadedPath]).catch(() => {});
    if (authId) await supabase.auth.admin.deleteUser(authId).catch(() => {});
    return fail(res, 'REGISTRATION_FAILED', 'Registration failed. Please try again.', 500);
  }
});

// POST /api/auth/register-check  { mobile } -> { ok:true } if this mobile is
// FREE to register, or 409 MOBILE_REGISTERED if it's already tied to an
// account. Called by the frontend BEFORE sending the registration OTP, so a
// returning user is told immediately (step 1) instead of after filling in
// their name/email/password/face photo and only discovering it at submit time.
router.post('/register-check', async (req, res) => {
  const normMobile = normalizeMobile(req.body?.mobile);
  if (!normMobile) return fail(res, 'INVALID_MOBILE', 'Please enter a valid 10-digit mobile number');
  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { return fail(res, err.code || 'SUPABASE_NOT_CONFIGURED', 'Server is not configured', 503); }
  try {
    const { data, error } = await supabase.from('profiles').select('id').eq('phone', normMobile).maybeSingle();
    if (error) throw error;
    if (data && !REPLACE_EXISTING) return fail(res, 'MOBILE_REGISTERED', 'This mobile number is already registered. Please log in instead.', 409);
    res.json({ ok: true });
  } catch (err) {
    console.error('register-check error:', err.message);
    return fail(res, 'DB_ERROR', 'Something went wrong. Please try again.', 500);
  }
});

// POST /api/auth/resolve-mobile  { mobile } -> { email }
// Lets users log in with their mobile number: we map it to the account email,
// then the client signs in with email + password.
router.post('/resolve-mobile', async (req, res) => {
  const normMobile = normalizeMobile(req.body?.mobile);
  if (!normMobile) return fail(res, 'INVALID_MOBILE', 'Please enter a valid 10-digit mobile number');
  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { return fail(res, err.code || 'SUPABASE_NOT_CONFIGURED', 'Server is not configured', 503); }
  try {
    const { data, error } = await supabase.from('profiles').select('email').eq('phone', normMobile).maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 'USER_NOT_FOUND', 'No account found for this mobile number', 404);
    res.json({ ok: true, email: data.email });
  } catch (err) {
    console.error('resolve-mobile error:', err.message);
    return fail(res, 'DB_ERROR', 'Something went wrong. Please try again.', 500);
  }
});

// POST /api/auth/forgot-check  { mobile } -> { ok:true } if a profile exists
// for that mobile (so the client can then send an OTP to it).
router.post('/forgot-check', async (req, res) => {
  const normMobile = normalizeMobile(req.body?.mobile);
  if (!normMobile) return fail(res, 'INVALID_MOBILE', 'Please enter a valid 10-digit mobile number');
  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { return fail(res, err.code || 'SUPABASE_NOT_CONFIGURED', 'Server is not configured', 503); }
  try {
    const { data, error } = await supabase.from('profiles').select('id').eq('phone', normMobile).maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 'USER_NOT_FOUND', 'No account is registered with this mobile number', 404);
    res.json({ ok: true });
  } catch (err) {
    console.error('forgot-check error:', err.message);
    return fail(res, 'DB_ERROR', 'Something went wrong. Please try again.', 500);
  }
});

// POST /api/auth/reset-password  { mobile, verificationToken, newPassword }
// Verifies the MSG91 OTP token, matches the mobile to a registered profile,
// then updates that user's password. Returns the email for auto sign-in.
router.post('/reset-password', async (req, res) => {
  const { mobile, verificationToken, newPassword } = req.body || {};
  const normMobile = normalizeMobile(mobile);
  if (!normMobile) return fail(res, 'INVALID_MOBILE', 'Invalid mobile number');
  if (String(newPassword || '').length < 6) return fail(res, 'WEAK_PASSWORD', 'Password must be at least 6 characters');

  if (process.env.OTP_SERVER_VERIFY !== 'false') {
    try {
      await verifyAccessToken(verificationToken);
    } catch (err) {
      if (err.code === 'OTP_NOT_CONFIGURED') return fail(res, err.code, 'OTP service is not configured', 503);
      return fail(res, 'OTP_NOT_VERIFIED', 'Please verify the OTP first', 401);
    }
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { return fail(res, err.code || 'SUPABASE_NOT_CONFIGURED', 'Server is not configured', 503); }

  try {
    const { data, error } = await supabase.from('profiles').select('id, email').eq('phone', normMobile).maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 'USER_NOT_FOUND', 'No account is registered with this mobile number', 404);

    const { error: updErr } = await supabase.auth.admin.updateUserById(data.id, { password: newPassword });
    if (updErr) throw updErr;

    res.json({ ok: true, email: data.email });
  } catch (err) {
    console.error('reset-password error:', err.message);
    return fail(res, 'RESET_FAILED', 'Could not reset password. Please try again.', 500);
  }
});

// ---- OTP for the Android app (the web app uses the MSG91 browser widget instead) --------------------
// POST /api/auth/otp/send    { mobile }       -> { reqId }
// POST /api/auth/otp/retry   { reqId }        -> { reqId }
// POST /api/auth/otp/verify  { reqId, otp }   -> { verificationToken }  (pass it to /register or /reset-password)
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const otpFail = (res, err) => {
  if (err.code === 'OTP_NOT_CONFIGURED') return fail(res, err.code, 'OTP service is not configured', 503);
  if (err.code === 'OTP_UNREACHABLE') return fail(res, err.code, 'OTP service is unreachable. Please try again.', 502);
  return fail(res, 'OTP_REJECTED', err.message || 'OTP request failed', 400);
};

router.post('/otp/send', async (req, res) => {
  const mobile = normalizeMobile(req.body?.mobile);
  if (!mobile) return fail(res, 'INVALID_MOBILE', 'Please enter a valid 10-digit mobile number');
  if (!allowOtpAction('send:ip:' + clientIp(req), 10, 3600_000) || !allowOtpAction('send:mobile:' + mobile, 3, 15 * 60_000)) {
    return fail(res, 'RATE_LIMITED', 'Too many OTP requests. Please wait a few minutes and try again.', 429);
  }
  try {
    const data = await widgetSendOtp(mobile);
    rememberReq(data.message, mobile);
    res.json({ ok: true, reqId: data.message });
  } catch (err) { otpFail(res, err); }
});

// POST /api/auth/otp/phone-sent { mobile, reqId } -> { ok }
// The app can ask MSG91 for the OTP itself (so the SMS request comes from the phone, not from this server's shared host
// address). The server then only has to verify it. Because a phone could claim any number for a reqId, this is accepted
// ONLY for numbers with no account yet (new sign-ups). Such a reqId never gets a sign-in proof, so it cannot be used to
// log in to, or reset the password of, an existing account.
router.post('/otp/phone-sent', async (req, res) => {
  const mobile = normalizeMobile(req.body?.mobile);
  const reqId = String(req.body?.reqId || '');
  if (!mobile || !reqId) return fail(res, 'INVALID_INPUT', 'mobile and reqId are required');
  if (!allowOtpAction('phone:ip:' + clientIp(req), 30, 3600_000)) return fail(res, 'RATE_LIMITED', 'Too many requests. Please wait a few minutes and try again.', 429);
  let supabase;
  try { supabase = getSupabaseAdmin(); } catch (err) { return fail(res, err.code || 'SUPABASE_NOT_CONFIGURED', 'Server is not configured', 503); }
  try {
    const { data, error } = await supabase.from('profiles').select('id').eq('phone', mobile).maybeSingle();
    if (error) throw error;
    if (data && !REPLACE_EXISTING) return fail(res, 'MOBILE_REGISTERED', 'This number already has an account. Please sign in with your password.', 409);
    rememberReq(reqId, mobile, { phone: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('phone-sent error:', err.message);
    return fail(res, 'DB_ERROR', 'Something went wrong. Please try again.', 500);
  }
});

router.post('/otp/retry', async (req, res) => {
  const reqId = String(req.body?.reqId || '');
  if (!reqId) return fail(res, 'INVALID_INPUT', 'reqId is required');
  if (!allowOtpAction('retry:ip:' + clientIp(req), 10, 3600_000) || !allowOtpAction('retry:req:' + reqId, 3, 15 * 60_000)) {
    return fail(res, 'RATE_LIMITED', 'Too many OTP requests. Please wait a few minutes and try again.', 429);
  }
  try {
    const data = await widgetRetryOtp(reqId);
    const m = mobileForReq(reqId);
    rememberReq(data.message || reqId, m);
    res.json({ ok: true, reqId: data.message || reqId });
  } catch (err) { otpFail(res, err); }
});

router.post('/otp/verify', async (req, res) => {
  const reqId = String(req.body?.reqId || '');
  const otp = String(req.body?.otp || '').replace(/\D/g, '');
  if (!reqId || otp.length < 4) return fail(res, 'INVALID_INPUT', 'reqId and otp are required');
  if (!allowOtpAction('verify:req:' + reqId, 6, 15 * 60_000) || !allowOtpAction('verify:ip:' + clientIp(req), 30, 3600_000)) {
    return fail(res, 'RATE_LIMITED', 'Too many attempts. Please request a new OTP.', 429);
  }
  try {
    const data = await widgetVerifyOtp(reqId, otp);
    const m = mobileForReq(reqId);
    res.json({ ok: true, verificationToken: data.message, mobile: m, proof: m && !isPhoneReq(reqId) && proofsEnabled() ? signProof(m) : null });
  } catch (err) { otpFail(res, err); }
});

// POST /api/auth/otp-login { mobile, proof } -> { tokenHash }
// Passwordless sign-in for an EXISTING account after its mobile OTP was verified (proof from /otp/verify).
// The app exchanges tokenHash with supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }) to get a session.
router.post('/otp-login', async (req, res) => {
  const mobile = normalizeMobile(req.body?.mobile);
  if (!mobile) return fail(res, 'INVALID_MOBILE', 'Invalid mobile number');
  if (!proofsEnabled()) return fail(res, 'NOT_CONFIGURED', 'OTP sign-in is not configured', 503);
  if (!checkProof(mobile, req.body?.proof)) return fail(res, 'OTP_NOT_VERIFIED', 'Please verify the OTP for this number first', 401);
  if (!allowOtpAction('login:ip:' + clientIp(req), 20, 3600_000)) return fail(res, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.', 429);
  let supabase;
  try { supabase = getSupabaseAdmin(); } catch (err) { return fail(res, err.code || 'SUPABASE_NOT_CONFIGURED', 'Server is not configured', 503); }
  try {
    const { data: prof, error } = await supabase.from('profiles').select('email').eq('phone', mobile).maybeSingle();
    if (error) throw error;
    if (!prof) return fail(res, 'USER_NOT_FOUND', 'No account is registered with this mobile number', 404);
    const { data, error: linkErr } = await supabase.auth.admin.generateLink({ type: 'magiclink', email: prof.email });
    if (linkErr || !data?.properties?.hashed_token) throw linkErr || new Error('no token');
    res.json({ ok: true, tokenHash: data.properties.hashed_token });
  } catch (err) {
    console.error('otp-login error:', err.message);
    return fail(res, 'LOGIN_FAILED', 'Could not sign you in. Please try again.', 500);
  }
});

export default router;
