/**
 * Blanks ONLY the display name of registered users, so a demo can show the login step
 * (same mobile number + password/OTP) without anyone's name appearing on screen.
 *
 *   node backend/scripts/clearUserNames.mjs                       # dry run: lists who would change, writes nothing
 *   node backend/scripts/clearUserNames.mjs --apply               # blank every user's name
 *   node backend/scripts/clearUserNames.mjs --apply --only 98xxxxxx10,98xxxxxx11   # just these mobile numbers
 *   node backend/scripts/clearUserNames.mjs --restore             # put the saved names back (dry run unless --apply)
 *
 * Changes: profiles.full_name -> '' and the auth user's user_metadata.full_name -> ''.
 * Does NOT touch: mobile number, email, password, live photo, eligibility profile, documents,
 * applications, family members, bank accounts or anything else. Login uses mobile -> email -> password,
 * so it keeps working exactly as before. Original names are saved to backend/data/user-name-backup.json
 * (git-ignored) before any change, so --restore can undo it.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getSupabaseAdmin } from '../services/supabaseAdmin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const APPLY = process.argv.includes('--apply');
const RESTORE = process.argv.includes('--restore');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > -1 ? new Set(process.argv[onlyArg + 1].split(',').map((s) => s.replace(/\D/g, '').slice(-10))) : null;
const BACKUP = path.resolve(__dirname, '../data/user-name-backup.json');

const mask = (p) => (p ? `${'*'.repeat(Math.max(0, p.length - 4))}${p.slice(-4)}` : '(no phone)');
const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('.') + '.';

async function setName(supabase, id, name) {
  const { error } = await supabase.from('profiles').update({ full_name: name }).eq('id', id);
  if (error) throw new Error(`profiles update failed for ${id}: ${error.message}`);
  const { data } = await supabase.auth.admin.getUserById(id);
  const meta = { ...(data?.user?.user_metadata || {}), full_name: name };
  const { error: aErr } = await supabase.auth.admin.updateUserById(id, { user_metadata: meta });
  if (aErr) throw new Error(`auth metadata update failed for ${id}: ${aErr.message}`);
}

async function run() {
  const supabase = getSupabaseAdmin();
  console.log(`Mode: ${RESTORE ? 'RESTORE' : 'CLEAR NAMES'} · ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);

  if (RESTORE) {
    if (!fs.existsSync(BACKUP)) throw new Error('No backup file found — nothing to restore.');
    const saved = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
    console.log(`Backup holds ${saved.length} names.`);
    if (!APPLY) { console.log('Dry run only. Re-run with --restore --apply to put them back.'); return; }
    for (const r of saved) await setName(supabase, r.id, r.full_name);
    console.log('DONE. Names restored.');
    return;
  }

  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('profiles').select('id, phone, full_name').range(from, from + 999);
    if (error) throw new Error(`Could not read profiles: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const targets = rows.filter((r) => r.full_name && (!ONLY || ONLY.has(String(r.phone || '').slice(-10))));
  console.log(`Profiles: ${rows.length} · with a name to clear: ${targets.length}`);
  targets.forEach((r) => console.log(`  ${mask(r.phone)}  ${initials(r.full_name)}`));

  if (!APPLY) { console.log('Dry run only. Re-run with --apply to blank these names.'); return; }
  if (!targets.length) return;

  // Merge with any earlier backup so a second run never loses the original names.
  const prior = fs.existsSync(BACKUP) ? JSON.parse(fs.readFileSync(BACKUP, 'utf8')) : [];
  const byId = new Map(prior.map((r) => [r.id, r]));
  targets.forEach((r) => { if (!byId.has(r.id)) byId.set(r.id, { id: r.id, phone: r.phone, full_name: r.full_name }); });
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  fs.writeFileSync(BACKUP, JSON.stringify([...byId.values()], null, 2));
  console.log(`Saved original names to ${BACKUP}`);

  for (const r of targets) await setName(supabase, r.id, '');
  console.log(`DONE. Cleared ${targets.length} names. Undo with: node backend/scripts/clearUserNames.mjs --restore --apply`);
}

run().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
