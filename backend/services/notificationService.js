// ============================================================================
// Scheme-change notifications for the Android app.
//
//   detectChanges()  catalogue rows  -> fingerprints -> scheme_change_events
//   fanOut()         events          -> user_notifications (per preferences)
//   dispatchPush()   user_notifications -> Expo push service (FCM under the hood)
//   run()            all three, idempotently, safe to call from cron / a script
//
// The pure functions (fingerprint, classifyChanges, decideNotification, inQuietHours,
// buildMessage) hold all the decisions and are unit-tested without a database
// (backend/scripts/testNotificationLogic.mjs). The DB/HTTP wrappers are thin.
//
// WHAT "NEW" MEANS HERE: the catalogue has no government publication date, so a scheme
// is 'added' only when its slug was never seen by an earlier run AFTER the baseline run,
// and 'updated' only when the hash of its official-content columns changed. The very
// first run just records a baseline. A run that would announce a suspicious number of
// 'added' schemes is treated as a bulk re-import and announces nothing.
// ============================================================================
import crypto from 'node:crypto';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

// Columns that carry official scheme content. Timestamps (scraped_at, updated_at, ...) are
// deliberately excluded: a re-scrape with identical content must not look like a change.
const CONTENT_COLUMNS = [
  'name', 'short_description', 'level', 'ministries', 'states', 'category_tags',
  'details_text', 'eligibility_text', 'benefits_text', 'application_process',
  'documents_required', 'official_website', 'application_mode', 'scheme_type',
];
export const SELECT_COLUMNS = ['slug', 'detail_scraped_at', ...CONTENT_COLUMNS].join(',');

const MAX_ADDED_PER_RUN = Number(process.env.NOTIFY_MAX_ADDED_PER_RUN || 40);
const SETTLE_MS = 24 * 3600_000; // an 'updated' event waits until a scheme has been known for a day
const STALE_PENDING_MS = 3 * 24 * 3600_000;

// ---------------------------------------------------------------- pure logic
const stable = (v) => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
};

export function fingerprint(row) {
  const payload = {};
  for (const c of CONTENT_COLUMNS) {
    let v = row[c] ?? null;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) v = [...v].sort();
    payload[c] = v;
  }
  return crypto.createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
}

/**
 * rows:         current catalogue rows
 * known:        Map(slug -> { content_hash, had_detail, first_seen_at })
 * baseline:     true on the very first run (record only, announce nothing)
 * Returns { upserts, events, notes } where events are { slug, event_type, content_hash }.
 */
export function classifyChanges(rows, known, { baseline, now = Date.now(), maxAdded = MAX_ADDED_PER_RUN, force = false }) {
  const upserts = [];
  const added = [];
  const updated = [];
  const notes = [];
  for (const row of rows) {
    const hash = fingerprint(row);
    const hasDetail = Boolean(row.detail_scraped_at);
    const prev = known.get(row.slug);
    if (!prev) {
      upserts.push({ slug: row.slug, content_hash: hash, had_detail: hasDetail, first_seen_at: new Date(now).toISOString(), last_changed_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString() });
      if (!baseline) added.push({ slug: row.slug, event_type: 'added', content_hash: hash });
      continue;
    }
    if (prev.content_hash === hash) {
      continue; // unchanged: nothing to write (last_seen_at is refreshed in bulk elsewhere)
    }
    // Content changed.
    const becameDetailed = !prev.had_detail && hasDetail;
    const young = now - Date.parse(prev.first_seen_at) < SETTLE_MS;
    upserts.push({ slug: row.slug, content_hash: hash, had_detail: hasDetail, last_changed_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString() });
    // The stub → detailed transition (and anything within a day of first sight) is the same
    // scheme finishing its import, not a government update, so it never announces itself.
    if (!baseline && !becameDetailed && !young) updated.push({ slug: row.slug, event_type: 'updated', content_hash: hash });
  }
  let events = [...added, ...updated];
  if (!force && added.length > maxAdded) {
    notes.push(`bulk import suspected: ${added.length} schemes looked new (limit ${maxAdded}); recorded silently`);
    events = updated;
  }
  if (baseline) notes.push(`baseline run: ${upserts.length} fingerprints recorded, no notifications`);
  return { upserts, events, notes };
}

/** "HH:MM" quiet window in the user's own time zone; supports windows crossing midnight. */
export function inQuietHours(prefs, at = new Date()) {
  if (!prefs.quiet_start || !prefs.quiet_end) return false;
  let hh;
  let mm;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: prefs.timezone || 'Asia/Kolkata' }).formatToParts(at);
    hh = Number(parts.find((p) => p.type === 'hour').value) % 24;
    mm = Number(parts.find((p) => p.type === 'minute').value);
  } catch {
    return false; // unknown zone: never silently suppress a notification forever
  }
  const now = hh * 60 + mm;
  const [sh, sm] = prefs.quiet_start.split(':').map(Number);
  const [eh, em] = prefs.quiet_end.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Decide whether (and why) one user should hear about one event. Returns a reason string or null.
 * ctx: { saved: Set(slug), profileMatches: Set(slug) | null }
 * Reasons are plain statements of fact — never "you are eligible".
 */
export function decideNotification(prefs, event, scheme, ctx) {
  if (!prefs.enabled) return null;
  if (event.event_type === 'updated' && prefs.saved_updates && ctx.saved.has(event.slug)) {
    return { reason: 'A scheme you saved was updated', key: 'saved_updates' };
  }
  if (prefs.state_schemes && prefs.region_state && (scheme.states || []).includes(prefs.region_state)) {
    return { reason: `Applies to ${prefs.region_state}`, key: 'state_schemes' };
  }
  if (event.event_type === 'added') {
    if (prefs.profile_matches && ctx.profileMatches && ctx.profileMatches.has(event.slug)) {
      return { reason: 'Matches the details in your saved profile (not a guarantee of eligibility)', key: 'profile_matches' };
    }
    if (prefs.new_schemes) return { reason: 'Newly added to SchemeSahayak', key: 'new_schemes' };
  }
  return null;
}

const CHANNEL_BY_KEY = { saved_updates: 'saved_updates', state_schemes: 'state_schemes', profile_matches: 'profile_matches', new_schemes: 'new_schemes' };

/** Push payload: generic title, public scheme name only, ids in `data`. No profile or location data. */
export function buildMessage(token, n, key) {
  return {
    to: token,
    title: n.kind === 'scheme_added' ? 'New scheme on SchemeSahayak' : 'Scheme updated on SchemeSahayak',
    body: n.body,
    data: { slug: n.slug, nid: n.id },
    channelId: CHANNEL_BY_KEY[key] || 'general',
    priority: 'default',
    ttl: 2 * 24 * 3600,
  };
}

export const isExpoToken = (t) => /^Expo(nent)?PushToken\[[\w-]+\]$/.test(String(t || ''));

// ------------------------------------------------------------ DB wrappers
async function fetchAllCatalogue(supabase) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('myscheme_catalogue').select(SELECT_COLUMNS).order('slug').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

async function fetchFingerprints(supabase) {
  const map = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('catalogue_fingerprints').select('slug,content_hash,had_detail,first_seen_at').order('slug').range(from, from + 999);
    if (error) throw error;
    for (const r of data) map.set(r.slug, r);
    if (data.length < 1000) break;
  }
  return map;
}

export async function detectChanges(supabase, { force = false, dryRun = false } = {}) {
  const [rows, known, state] = await Promise.all([
    fetchAllCatalogue(supabase),
    fetchFingerprints(supabase),
    supabase.from('notification_job_state').select('value').eq('key', 'baseline').maybeSingle(),
  ]);
  if (state.error) throw state.error;
  const baseline = !state.data;
  const { upserts, events, notes } = classifyChanges(rows, known, { baseline, force });
  if (dryRun) return { baseline, upserts: upserts.length, events, notes, dryRun: true };

  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await supabase.from('catalogue_fingerprints').upsert(upserts.slice(i, i + 500), { onConflict: 'slug' });
    if (error) throw error;
  }
  if (events.length) {
    // unique(slug,event_type,content_hash) makes a re-run a no-op instead of a duplicate announcement.
    const { error } = await supabase.from('scheme_change_events').upsert(events, { onConflict: 'slug,event_type,content_hash', ignoreDuplicates: true });
    if (error) throw error;
  }
  if (baseline) {
    const { error } = await supabase.from('notification_job_state').upsert({ key: 'baseline', value: { completed_at: new Date().toISOString(), schemes: upserts.length } });
    if (error) throw error;
  }
  return { baseline, upserts: upserts.length, events: events.length, notes };
}

async function profileMatchSet(supabase, userId) {
  const { data: p } = await supabase.from('profiles').select('annual_income, social_category, gender, education_level, state, date_of_birth, age').eq('id', userId).maybeSingle();
  if (!p) return null;
  const age = p.age ?? (p.date_of_birth ? Math.floor((Date.now() - new Date(p.date_of_birth).getTime()) / 31557600000) : null);
  const { data, error } = await supabase.rpc('match_catalogue_schemes', {
    p_income: p.annual_income ?? null, p_category: p.social_category ?? null, p_gender: p.gender ?? null,
    p_education: p.education_level ?? null, p_state: p.state ?? null, p_age: age, p_benefit_types: null, p_limit: 200,
  });
  if (error) return null; // matcher unavailable: simply no profile-based notifications this run
  return new Set((data || []).map((r) => r.slug));
}

export async function fanOut(supabase) {
  const { data: events, error } = await supabase.from('scheme_change_events').select('id,slug,event_type').is('fanned_out_at', null).order('detected_at').limit(200);
  if (error) throw error;
  if (!events.length) return { events: 0, created: 0 };

  const { data: prefsRows, error: pErr } = await supabase.from('notification_preferences').select('*').eq('enabled', true);
  if (pErr) throw pErr;
  const slugs = [...new Set(events.map((e) => e.slug))];
  const { data: schemes } = await supabase.from('myscheme_catalogue').select('slug,name,states').in('slug', slugs);
  const schemeBySlug = new Map((schemes || []).map((s) => [s.slug, s]));

  const wantsProfile = prefsRows.filter((p) => p.profile_matches).map((p) => p.user_id);
  const profileSets = new Map();
  for (const uid of wantsProfile) profileSets.set(uid, await profileMatchSet(supabase, uid));
  const { data: savedRows } = prefsRows.length ? await supabase.from('user_saved_schemes').select('user_id,scheme_key').eq('kind', 'catalogue').in('scheme_key', slugs).in('user_id', prefsRows.map((p) => p.user_id)) : { data: [] };
  const savedByUser = new Map();
  for (const r of savedRows || []) (savedByUser.get(r.user_id) || savedByUser.set(r.user_id, new Set()).get(r.user_id)).add(r.scheme_key);

  const rows = [];
  for (const ev of events) {
    const scheme = schemeBySlug.get(ev.slug);
    if (!scheme) continue;
    for (const prefs of prefsRows) {
      const decision = decideNotification(prefs, ev, scheme, { saved: savedByUser.get(prefs.user_id) || new Set(), profileMatches: profileSets.get(prefs.user_id) ?? null });
      if (!decision) continue;
      rows.push({
        user_id: prefs.user_id, event_id: ev.id, slug: ev.slug, kind: ev.event_type === 'added' ? 'scheme_added' : 'scheme_updated',
        title: ev.event_type === 'added' ? 'New scheme' : 'Scheme updated', body: scheme.name, reason: decision.reason,
        _key: decision.key,
      });
    }
  }
  let created = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map(({ _key, ...r }) => r);
    const { data, error: iErr } = await supabase.from('user_notifications').upsert(chunk, { onConflict: 'user_id,event_id', ignoreDuplicates: true }).select('id');
    if (iErr) throw iErr;
    created += data?.length || 0;
  }
  const { error: uErr } = await supabase.from('scheme_change_events').update({ fanned_out_at: new Date().toISOString() }).in('id', events.map((e) => e.id));
  if (uErr) throw uErr;
  return { events: events.length, created };
}

async function expoFetch(url, body) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`; // only if enhanced push security is on
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`expo push ${res.status}`);
  return res.json();
}

export async function dispatchPush(supabase, { now = new Date() } = {}) {
  const stale = new Date(now.getTime() - STALE_PENDING_MS).toISOString();
  await supabase.from('user_notifications').update({ push_status: 'skipped' }).eq('push_status', 'pending').lt('created_at', stale);

  const { data: pending, error } = await supabase.from('user_notifications').select('id,user_id,slug,kind,body,reason').eq('push_status', 'pending').is('dismissed_at', null).order('created_at').limit(500);
  if (error) throw error;
  if (!pending.length) return { sent: 0, held: 0, failed: 0, noDevice: 0 };

  const userIds = [...new Set(pending.map((n) => n.user_id))];
  const [{ data: prefs }, { data: tokens }] = await Promise.all([
    supabase.from('notification_preferences').select('*').in('user_id', userIds),
    supabase.from('device_push_tokens').select('user_id,expo_push_token').in('user_id', userIds).is('disabled_at', null),
  ]);
  const prefBy = new Map((prefs || []).map((p) => [p.user_id, p]));
  const tokensBy = new Map();
  for (const t of tokens || []) (tokensBy.get(t.user_id) || tokensBy.set(t.user_id, []).get(t.user_id)).push(t.expo_push_token);

  const ready = [];
  let held = 0;
  let noDevice = 0;
  for (const n of pending) {
    const p = prefBy.get(n.user_id);
    if (!p || !p.enabled) { await supabase.from('user_notifications').update({ push_status: 'skipped' }).eq('id', n.id); continue; }
    if (inQuietHours(p, now)) { held += 1; continue; } // stays 'pending'; delivered by the first run after quiet hours
    const toks = tokensBy.get(n.user_id) || [];
    if (!toks.length) { noDevice += 1; await supabase.from('user_notifications').update({ push_status: 'skipped' }).eq('id', n.id); continue; } // still visible in the in-app inbox
    ready.push({ n, toks });
  }

  // Claim before sending so two overlapping runs cannot both deliver the same notification.
  const claimIds = ready.map((r) => r.n.id);
  let claimed = new Set();
  if (claimIds.length) {
    const { data: got, error: cErr } = await supabase.from('user_notifications').update({ push_status: 'sending', push_attempted_at: now.toISOString() }).in('id', claimIds).eq('push_status', 'pending').select('id');
    if (cErr) throw cErr;
    claimed = new Set((got || []).map((g) => g.id));
  }
  const messages = [];
  for (const { n, toks } of ready) {
    if (!claimed.has(n.id)) continue;
    const key = n.reason?.startsWith('A scheme you saved') ? 'saved_updates' : n.reason?.startsWith('Applies to') ? 'state_schemes' : n.reason?.startsWith('Matches') ? 'profile_matches' : 'new_schemes';
    for (const t of toks) messages.push({ msg: buildMessage(t, n, key), n });
  }

  let sent = 0;
  let failed = 0;
  const ok = new Set();
  const bad = new Set();
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const { data: tickets } = await expoFetch(EXPO_PUSH_URL, chunk.map((c) => c.msg));
      for (let j = 0; j < chunk.length; j++) {
        const t = tickets?.[j];
        const { n, msg } = chunk[j];
        if (t?.status === 'ok') {
          ok.add(n.id);
          await supabase.from('user_notifications').update({ push_ticket_id: t.id }).eq('id', n.id);
        } else {
          bad.add(n.id);
          if (t?.details?.error === 'DeviceNotRegistered') await supabase.from('device_push_tokens').update({ disabled_at: now.toISOString() }).eq('expo_push_token', msg.to);
        }
      }
    } catch (e) {
      for (const c of chunk) bad.add(c.n.id); // network/5xx: retried below via 'pending'
    }
  }
  for (const { n } of ready) {
    if (!claimed.has(n.id)) continue;
    if (ok.has(n.id)) { sent += 1; await supabase.from('user_notifications').update({ push_status: 'sent' }).eq('id', n.id); }
    else { failed += 1; await supabase.from('user_notifications').update({ push_status: 'pending' }).eq('id', n.id); } // retry next run (stale ones expire after 3 days)
  }
  return { sent, held, failed, noDevice };
}

/** Expo receipts reveal tokens that died after the ticket was issued. Cheap to run every cycle. */
export async function checkReceipts(supabase, { now = new Date() } = {}) {
  const older = new Date(now.getTime() - 15 * 60_000).toISOString();
  const { data } = await supabase.from('user_notifications').select('id,user_id,push_ticket_id').eq('push_status', 'sent').not('push_ticket_id', 'is', null).lt('push_attempted_at', older).gt('push_attempted_at', new Date(now.getTime() - 24 * 3600_000).toISOString()).limit(300);
  if (!data?.length) return { checked: 0, disabled: 0 };
  let disabled = 0;
  try {
    const { data: receipts } = await expoFetch(EXPO_RECEIPTS_URL, { ids: data.map((d) => d.push_ticket_id) });
    for (const d of data) {
      const r = receipts?.[d.push_ticket_id];
      if (r?.status === 'error' && r.details?.error === 'DeviceNotRegistered') {
        const { data: toks } = await supabase.from('device_push_tokens').select('expo_push_token').eq('user_id', d.user_id).is('disabled_at', null);
        // The receipt does not name the token; disable only when the user has exactly one active token.
        if (toks?.length === 1) { await supabase.from('device_push_tokens').update({ disabled_at: now.toISOString() }).eq('expo_push_token', toks[0].expo_push_token); disabled += 1; }
      }
      await supabase.from('user_notifications').update({ push_ticket_id: null }).eq('id', d.id);
    }
  } catch { /* receipts are best-effort */ }
  return { checked: data.length, disabled };
}

export async function run(supabase, opts = {}) {
  const detected = await detectChanges(supabase, opts);
  if (detected.dryRun) return { detected };
  const fan = await fanOut(supabase);
  const push = await dispatchPush(supabase);
  const receipts = await checkReceipts(supabase);
  return { detected, fanOut: fan, push, receipts };
}
