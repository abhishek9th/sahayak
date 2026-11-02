/**
 * Keeps public.myscheme_catalogue fresh from the apimitra.in mirror of the myScheme index.
 *
 *   node backend/scripts/syncApimitra.mjs            # dry run: prints what would change, writes nothing
 *   node backend/scripts/syncApimitra.mjs --apply    # writes to Supabase
 *   node backend/scripts/syncApimitra.mjs --offline  # compare against the local scheme_index.json instead of Supabase
 *
 * What it does (and deliberately does NOT do):
 *   - NEW slugs (not in the catalogue yet) are inserted as index-only stubs. detail_scraped_at stays null,
 *     so scrapeSchemeDetails.mjs picks them up and fills eligibility/documents/steps from myscheme.gov.in.
 *   - EXISTING slugs only get close_date / close_date_raw / synced_at updated. Scraped eligibility, benefits,
 *     documents and AI-extracted columns are never overwritten.
 *   - Slugs that exist locally but not in the API are only reported — nothing is ever deleted.
 *   - Every row keeps source_url = myscheme.gov.in; the API is only used to find changes.
 *
 * Needs APIMITRA_API_KEY in .env (optional APIMITRA_BASE_URL). Run migration 20260929_catalogue_close_date.sql first.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const APPLY = process.argv.includes('--apply');
const OFFLINE = process.argv.includes('--offline');
const BASE = (process.env.APIMITRA_BASE_URL || 'https://api.apimitra.in').replace(/\/$/, '');
const KEY = process.env.APIMITRA_API_KEY;
const PAGE_SIZE = 100;
const PAUSE_MS = 250;
const BATCH = 500;
const LOCAL_INDEX = path.resolve(__dirname, '../data/myscheme-scrape/scheme_index.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csv = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

// Accepts 2026-12-31, 31-12-2026, 31/12/2026, "31 Dec 2026". Returns null when it isn't clearly a date.
export function parseCloseDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y, mo, d;
  if (m) [, y, mo, d] = m;
  else if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) [, d, mo, y] = m;
  else {
    const t = Date.parse(`${s} UTC`);
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
  }
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
  return dt.toISOString().slice(0, 10);
}

async function fetchPage(page) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${BASE}/schemes?limit=${PAGE_SIZE}&page=${page}`, {
      headers: { 'x-api-key': KEY },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * attempt); continue; }
    if (res.status === 401 || res.status === 403) throw new Error(`API rejected the key (HTTP ${res.status})`);
    if (!res.ok) throw new Error(`API error HTTP ${res.status} on page ${page}`);
    return res.json();
  }
  throw new Error(`API kept failing on page ${page}`);
}

async function fetchAll() {
  const all = [];
  let total = Infinity;
  for (let page = 1; all.length < total; page++) {
    const body = await fetchPage(page);
    const data = Array.isArray(body.data) ? body.data : [];
    total = Number(body.total) || data.length;
    all.push(...data);
    process.stdout.write(`\rFetched ${all.length}/${total}`);
    if (!data.length) break;
    await sleep(PAUSE_MS);
  }
  process.stdout.write('\n');
  return all;
}

async function loadExisting(supabase) {
  if (OFFLINE) {
    const idx = JSON.parse(fs.readFileSync(LOCAL_INDEX, 'utf8'));
    return new Map(idx.map((s) => [s.slug, { close_date_raw: null }]));
  }
  const map = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('myscheme_catalogue').select('slug, close_date_raw').range(from, from + 999);
    if (error) throw new Error(`Could not read catalogue: ${error.message}`);
    for (const r of data) map.set(r.slug, r);
    if (data.length < 1000) break;
  }
  return map;
}

function toNewRow(a, now) {
  const states = csv(a.beneficiary_state).filter((s) => s.toLowerCase() !== 'all');
  return {
    slug: a.slug,
    name: a.scheme_name || a.slug,
    short_description: a.brief || null,
    level: String(a.level || '').toLowerCase() === 'state' || states.length ? 'state' : 'central',
    ministries: a.ministry ? [a.ministry] : [],
    states,
    category_tags: csv(a.categories),
    keyword_tags: csv(a.tags),
    close_date: parseCloseDate(a.close_date),
    close_date_raw: a.close_date || null,
    source_url: `https://www.myscheme.gov.in/schemes/${a.slug}`,
    synced_at: now,
  };
}

async function run() {
  if (!KEY) {
    console.error('APIMITRA_API_KEY is not set. Add it to .env (never commit it), then re-run.');
    process.exit(1);
  }
  const supabase = OFFLINE ? null : (await import('../services/supabaseAdmin.js')).getSupabaseAdmin();

  console.log(`Mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}${OFFLINE ? ' · offline compare' : ''}`);
  const apiSchemes = (await fetchAll()).filter((a) => a && a.slug);
  const existing = await loadExisting(supabase);
  const now = new Date().toISOString();

  const fresh = [];
  const closeUpdates = [];
  const seen = new Set();
  for (const a of apiSchemes) {
    seen.add(a.slug);
    const cur = existing.get(a.slug);
    if (!cur) fresh.push(toNewRow(a, now));
    else if ((a.close_date || null) !== (cur.close_date_raw || null)) {
      closeUpdates.push({ slug: a.slug, close_date: parseCloseDate(a.close_date), close_date_raw: a.close_date || null, synced_at: now });
    }
  }
  const missingFromApi = [...existing.keys()].filter((s) => !seen.has(s));

  console.log(`API schemes: ${apiSchemes.length} · already in catalogue: ${apiSchemes.length - fresh.length}`);
  console.log(`New schemes to add: ${fresh.length}`);
  fresh.slice(0, 10).forEach((r) => console.log(`  + ${r.slug} — ${r.name}`));
  console.log(`Close-date changes: ${closeUpdates.length}`);
  closeUpdates.slice(0, 10).forEach((r) => console.log(`  ~ ${r.slug} → ${r.close_date_raw}`));
  console.log(`In catalogue but not in API (left untouched): ${missingFromApi.length}`);

  if (!APPLY) { console.log('Dry run only. Re-run with --apply to write.'); return; }
  if (OFFLINE) { console.error('--apply cannot be combined with --offline.'); process.exit(1); }

  for (let i = 0; i < fresh.length; i += BATCH) {
    const { error } = await supabase.from('myscheme_catalogue').upsert(fresh.slice(i, i + BATCH), { onConflict: 'slug', ignoreDuplicates: true });
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }
  // Update only the close-date columns, one row at a time, so no scraped column can be overwritten.
  for (const u of closeUpdates) {
    const { slug, ...patch } = u;
    const { error } = await supabase.from('myscheme_catalogue').update(patch).eq('slug', slug);
    if (error) throw new Error(`Update failed for ${slug}: ${error.message}`);
  }
  console.log(`DONE. Added ${fresh.length}, updated ${closeUpdates.length} close dates.`);
  if (fresh.length) console.log('Next: run scrapeSchemeDetails.mjs so the new stubs get eligibility and documents.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => { console.error('\nFATAL', e.message); process.exit(1); });
}
