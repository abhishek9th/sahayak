import express from 'express';
import crypto from 'node:crypto';
import { requireUser } from '../services/requireUser.js';
import { getSupabaseAdmin } from '../services/supabaseAdmin.js';
import { isExpoToken, run } from '../services/notificationService.js';

const router = express.Router();

const BOOL_PREFS = ['enabled', 'new_schemes', 'state_schemes', 'profile_matches', 'deadlines', 'saved_updates'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const validZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const DEFAULT_PREFS = { enabled: false, new_schemes: true, state_schemes: true, profile_matches: true, deadlines: false, saved_updates: true, region_state: null, quiet_start: null, quiet_end: null, timezone: null };
const pick = (row) => ({ ...DEFAULT_PREFS, ...Object.fromEntries(Object.keys(DEFAULT_PREFS).map((k) => [k, row?.[k] ?? DEFAULT_PREFS[k]])) });

function fail(res, err, fallback) {
  console.error('notifications route error:', err?.message);
  return res.status(500).json({ error: fallback, code: 'NOTIFICATIONS_ERROR' });
}

// ---- device registration (idempotent upsert; token belongs to exactly one user) ---------------------
router.put('/devices', requireUser, async (req, res) => {
  const { token, platform = 'android', timezone, appVersion, lang } = req.body || {};
  if (!isExpoToken(token)) return res.status(400).json({ error: 'A valid push token is required', code: 'INVALID_TOKEN' });
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from('device_push_tokens').upsert(
      {
        user_id: req.user.id, expo_push_token: token, platform: String(platform).slice(0, 20),
        timezone: timezone && validZone(timezone) ? timezone : null, app_version: appVersion ? String(appVersion).slice(0, 20) : null,
        lang: lang ? String(lang).slice(0, 8) : null, disabled_at: null, failure_count: 0, last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'expo_push_token' }
    );
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not register this device'); }
});

router.delete('/devices', requireUser, async (req, res) => {
  const { token } = req.body || {};
  if (!isExpoToken(token)) return res.status(400).json({ error: 'A valid push token is required', code: 'INVALID_TOKEN' });
  try {
    const { error } = await getSupabaseAdmin().from('device_push_tokens').delete().eq('user_id', req.user.id).eq('expo_push_token', token);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not remove this device'); }
});

// ---- preferences ---------------------------------------------------------------------------------
router.get('/preferences', requireUser, async (req, res) => {
  try {
    const { data, error } = await getSupabaseAdmin().from('notification_preferences').select('*').eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    res.json({ preferences: pick(data) });
  } catch (err) { fail(res, err, 'Could not load your notification settings'); }
});

router.put('/preferences', requireUser, async (req, res) => {
  const body = req.body || {};
  const patch = {};
  for (const k of BOOL_PREFS) if (k in body) {
    if (typeof body[k] !== 'boolean') return res.status(400).json({ error: `${k} must be true or false`, code: 'INVALID_INPUT' });
    patch[k] = body[k];
  }
  if ('region_state' in body) patch.region_state = body.region_state ? String(body.region_state).slice(0, 60) : null;
  for (const k of ['quiet_start', 'quiet_end']) if (k in body) {
    if (body[k] !== null && !HHMM.test(body[k])) return res.status(400).json({ error: `${k} must look like 22:00`, code: 'INVALID_INPUT' });
    patch[k] = body[k];
  }
  if ('timezone' in body) {
    if (body.timezone !== null && !validZone(body.timezone)) return res.status(400).json({ error: 'Unknown time zone', code: 'INVALID_INPUT' });
    patch.timezone = body.timezone;
  }
  // Quiet hours need both ends (or neither).
  if (('quiet_start' in patch) !== ('quiet_end' in patch)) return res.status(400).json({ error: 'Set both quiet_start and quiet_end', code: 'INVALID_INPUT' });
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from('notification_preferences').upsert({ user_id: req.user.id, ...patch }, { onConflict: 'user_id' }).select('*').single();
    if (error) throw error;
    // Turning the master switch off also stops delivery to this account's devices immediately.
    if (patch.enabled === false) await supabase.from('device_push_tokens').update({ disabled_at: new Date().toISOString() }).eq('user_id', req.user.id).is('disabled_at', null);
    res.json({ preferences: pick(data) });
  } catch (err) { fail(res, err, 'Could not save your notification settings'); }
});

// ---- in-app notification centre ---------------------------------------------------------------------
router.get('/', requireUser, async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  try {
    const supabase = getSupabaseAdmin();
    const [{ data, error }, { count }] = await Promise.all([
      supabase.from('user_notifications').select('id,kind,slug,title,body,reason,created_at,read_at').eq('user_id', req.user.id).is('dismissed_at', null).order('created_at', { ascending: false }).limit(limit),
      supabase.from('user_notifications').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).is('dismissed_at', null).is('read_at', null),
    ]);
    if (error) throw error;
    res.json({ notifications: data, unread: count ?? 0 });
  } catch (err) { fail(res, err, 'Could not load your notifications'); }
});

router.post('/read', requireUser, async (req, res) => {
  const { ids, all } = req.body || {};
  try {
    let q = getSupabaseAdmin().from('user_notifications').update({ read_at: new Date().toISOString() }).eq('user_id', req.user.id).is('read_at', null);
    if (!all) {
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids or all is required', code: 'INVALID_INPUT' });
      q = q.in('id', ids.slice(0, 200));
    }
    const { error } = await q;
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not update notifications'); }
});

router.delete('/:id', requireUser, async (req, res) => {
  try {
    const { error } = await getSupabaseAdmin().from('user_notifications').update({ dismissed_at: new Date().toISOString() }).eq('user_id', req.user.id).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not dismiss the notification'); }
});

router.delete('/', requireUser, async (req, res) => {
  try {
    const { error } = await getSupabaseAdmin().from('user_notifications').update({ dismissed_at: new Date().toISOString() }).eq('user_id', req.user.id).is('dismissed_at', null);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not clear notifications'); }
});

// ---- scheduled job entry point (cron / GitHub Action / Render cron) -------------------------------------------
// Protected by CRON_SECRET (server env only). Without it the route is disabled, not open.
router.post('/admin/run', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const given = String(req.headers['x-cron-secret'] || '');
  const okSecret = secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!okSecret) return res.status(secret ? 401 : 503).json({ error: secret ? 'Unauthorized' : 'Notification job is not configured', code: 'FORBIDDEN' });
  try {
    const result = await run(getSupabaseAdmin(), { dryRun: req.query.dry === '1', force: req.query.force === '1' });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('notification job failed:', err.message);
    res.status(500).json({ error: 'Notification job failed', code: 'JOB_FAILED', detail: err.message });
  }
});

export default router;
