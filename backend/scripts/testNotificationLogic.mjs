// Pure-logic tests for scheme-change notifications (no database, no network).
//   node backend/scripts/testNotificationLogic.mjs
import assert from 'node:assert/strict';
import { buildMessage, classifyChanges, decideNotification, fingerprint, inQuietHours, isExpoToken } from '../services/notificationService.js';
import { allowOtpAction } from '../services/otpService.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok  ${name}`);
};

const NOW = Date.parse('2026-10-24T12:00:00Z');
const DAY = 24 * 3600_000;
const row = (slug, over = {}) => ({ slug, name: `Scheme ${slug}`, short_description: 'd', level: 'central', ministries: ['M'], states: [], category_tags: [], details_text: 'full text', eligibility_text: 'e', benefits_text: 'b', application_process: ['one'], documents_required: [{ name: 'Aadhaar' }], official_website: 'https://x.gov.in', application_mode: 'Online', scheme_type: 'Subsidy', detail_scraped_at: '2026-10-01T00:00:00Z', ...over });
const toKnown = (upserts, first = '2026-01-01T00:00:00Z') => new Map(upserts.map((u) => [u.slug, { content_hash: u.content_hash, had_detail: u.had_detail, first_seen_at: first }]));

test('fingerprint ignores timestamps, whitespace and array order', () => {
  const a = fingerprint(row('a', { scraped_at: '1', updated_at: '1', ministries: ['B', 'A'], short_description: 'hello  world' }));
  const b = fingerprint(row('a', { scraped_at: '2', updated_at: '9', ministries: ['A', 'B'], short_description: 'hello world' }));
  assert.equal(a, b);
});

test('fingerprint changes when official text changes', () => {
  assert.notEqual(fingerprint(row('a')), fingerprint(row('a', { eligibility_text: 'income below 2 lakh' })));
});

test('first (baseline) run records everything and announces nothing', () => {
  const r = classifyChanges([row('a'), row('b'), row('c')], new Map(), { baseline: true, now: NOW });
  assert.equal(r.upserts.length, 3);
  assert.equal(r.events.length, 0);
});

test('a fresh import finding EXISTING schemes is never "new"', () => {
  const base = classifyChanges([row('a'), row('b')], new Map(), { baseline: true, now: NOW });
  const again = classifyChanges([row('a'), row('b')], toKnown(base.upserts), { baseline: false, now: NOW });
  assert.equal(again.events.length, 0);
});

test('a slug unseen after the baseline is "added"', () => {
  const base = classifyChanges([row('a')], new Map(), { baseline: true, now: NOW });
  const next = classifyChanges([row('a'), row('z')], toKnown(base.upserts), { baseline: false, now: NOW });
  assert.deepEqual(next.events.map((e) => [e.slug, e.event_type]), [['z', 'added']]);
});

test('re-running over the same data cannot produce the same event twice', () => {
  const base = classifyChanges([row('a')], new Map(), { baseline: true, now: NOW });
  const known = toKnown(base.upserts);
  const run1 = classifyChanges([row('a'), row('z')], known, { baseline: false, now: NOW });
  // after run1 persisted its fingerprints, z is known
  for (const u of run1.upserts) known.set(u.slug, { content_hash: u.content_hash, had_detail: u.had_detail, first_seen_at: u.first_seen_at });
  const run2 = classifyChanges([row('a'), row('z')], known, { baseline: false, now: NOW });
  assert.equal(run2.events.length, 0);
});

test('edited content on an established scheme is "updated", not "added"', () => {
  const base = classifyChanges([row('a')], new Map(), { baseline: true, now: NOW });
  const next = classifyChanges([row('a', { benefits_text: 'now ₹50,000' })], toKnown(base.upserts), { baseline: false, now: NOW });
  assert.deepEqual(next.events.map((e) => e.event_type), ['updated']);
});

test('stub → detailed (import finishing) is silent, not an "update"', () => {
  const base = classifyChanges([row('a', { detail_scraped_at: null, details_text: null })], new Map(), { baseline: true, now: NOW });
  const next = classifyChanges([row('a')], toKnown(base.upserts), { baseline: false, now: NOW });
  assert.equal(next.events.length, 0);
});

test('a change within a day of first sight is silent', () => {
  const base = classifyChanges([row('a')], new Map(), { baseline: true, now: NOW });
  const young = toKnown(base.upserts, new Date(NOW - 3600_000).toISOString());
  const next = classifyChanges([row('a', { benefits_text: 'x' })], young, { baseline: false, now: NOW });
  assert.equal(next.events.length, 0);
});

test('bulk-import guard: dozens of "new" schemes at once announce nothing', () => {
  const rows = Array.from({ length: 60 }, (_, i) => row(`s${i}`));
  const r = classifyChanges(rows, new Map([['old', { content_hash: 'h', had_detail: true, first_seen_at: '2026-01-01T00:00:00Z' }]]), { baseline: false, now: NOW, maxAdded: 40 });
  assert.equal(r.events.length, 0);
  assert.match(r.notes[0], /bulk import/);
  assert.equal(r.upserts.length, 60); // still recorded so they never fire later
});

test('quiet hours: same-day and midnight-crossing windows, in the user zone', () => {
  const p = { quiet_start: '22:00', quiet_end: '07:00', timezone: 'Asia/Kolkata' };
  assert.equal(inQuietHours(p, new Date('2026-10-24T17:00:00Z')), true); // 22:30 IST
  assert.equal(inQuietHours(p, new Date('2026-10-24T01:00:00Z')), true); // 06:30 IST
  assert.equal(inQuietHours(p, new Date('2026-10-24T06:30:00Z')), false); // 12:00 IST
  assert.equal(inQuietHours({ quiet_start: '13:00', quiet_end: '15:00', timezone: 'UTC' }, new Date('2026-10-24T14:00:00Z')), true);
  assert.equal(inQuietHours({ quiet_start: null, quiet_end: null }, new Date()), false);
  assert.equal(inQuietHours({ quiet_start: '22:00', quiet_end: '07:00', timezone: 'Not/AZone' }, new Date()), false);
});

const base = { enabled: true, new_schemes: true, state_schemes: true, profile_matches: true, deadlines: false, saved_updates: true, region_state: null };
const ctx = (over = {}) => ({ saved: new Set(), profileMatches: null, ...over });
const added = { slug: 'z', event_type: 'added' };
const updated = { slug: 'z', event_type: 'updated' };

test('master switch off → nothing', () => assert.equal(decideNotification({ ...base, enabled: false }, added, { states: [] }, ctx()), null));
test('new scheme → generic reason when only new_schemes applies', () => assert.equal(decideNotification(base, added, { states: [] }, ctx()).key, 'new_schemes'));
test('new_schemes off and nothing else matches → nothing', () => assert.equal(decideNotification({ ...base, new_schemes: false }, added, { states: [] }, ctx()), null));
test('state scheme for the chosen state', () => assert.equal(decideNotification({ ...base, region_state: 'Bihar' }, added, { states: ['Bihar'] }, ctx()).key, 'state_schemes'));
test('state scheme for another state is not state-matched', () => assert.equal(decideNotification({ ...base, new_schemes: false, region_state: 'Bihar' }, added, { states: ['Assam'] }, ctx()), null));
test('saved scheme update outranks other reasons', () => assert.equal(decideNotification({ ...base, region_state: 'Bihar' }, updated, { states: ['Bihar'] }, ctx({ saved: new Set(['z']) })).key, 'saved_updates'));
test('an update to an UNSAVED scheme is not broadcast as new', () => assert.equal(decideNotification(base, updated, { states: [] }, ctx()), null));
test('profile match wording never claims eligibility', () => {
  const d = decideNotification({ ...base, new_schemes: false }, added, { states: [] }, ctx({ profileMatches: new Set(['z']) }));
  assert.equal(d.key, 'profile_matches');
  assert.match(d.reason, /not a guarantee/);
});

test('push payload carries only public scheme name and ids', () => {
  const m = buildMessage('ExponentPushToken[abc]', { id: 'n1', slug: 'z', kind: 'scheme_added', body: 'PM Example Yojana' }, 'state_schemes');
  assert.deepEqual(Object.keys(m).sort(), ['body', 'channelId', 'data', 'priority', 'title', 'to', 'ttl']);
  assert.deepEqual(m.data, { slug: 'z', nid: 'n1' });
  assert.equal(m.channelId, 'state_schemes');
  assert.ok(!/income|state|profile|lat|lon/i.test(JSON.stringify(m.data)));
});

test('expo token validation', () => {
  assert.equal(isExpoToken('ExponentPushToken[xxxxxxxx]'), true);
  assert.equal(isExpoToken('fcm-raw-token'), false);
  assert.equal(isExpoToken(undefined), false);
});

test('OTP limiter blocks the 4th send inside the window and recovers after it', () => {
  const t = 1_000_000;
  assert.ok(allowOtpAction('m', 3, 1000, t));
  assert.ok(allowOtpAction('m', 3, 1000, t + 1));
  assert.ok(allowOtpAction('m', 3, 1000, t + 2));
  assert.equal(allowOtpAction('m', 3, 1000, t + 3), false);
  assert.ok(allowOtpAction('m', 3, 1000, t + 2000));
});

console.log(`\n${passed} tests passed`);
