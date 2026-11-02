import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

// Sahayak Locker PIN: 4 digits chosen by the user, stored only as a salted, peppered scrypt hash (never the PIN).
// Wrong guesses are counted on the server; 5 in a row lock the locker for 15 minutes, so the 10,000 possible PINs
// cannot be brute-forced through the API.
export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60_000;

const pepper = () => process.env.AUTH_SIGNING_SECRET || process.env.CREDENTIAL_ENCRYPTION_KEY || 'schemesahayak-locker';
const derive = (pin, salt) => scryptSync(createHmac('sha256', pepper()).update(String(pin)).digest(), Buffer.from(salt, 'hex'), 32);

export const isValidPin = (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin);

export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return { salt, pin_hash: derive(pin, salt).toString('hex') };
}

function matches(row, pin) {
  const a = Buffer.from(row.pin_hash, 'hex');
  const b = derive(pin, row.salt);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `store` = { get(): row|null, put(row): void } for one user. Returns { status, ... } without throwing on bad input. */
export async function pinStatus(store, now = Date.now()) {
  const row = await store.get();
  if (!row) return { hasPin: false };
  const lockedFor = row.locked_until ? Math.max(0, new Date(row.locked_until).getTime() - now) : 0;
  return { hasPin: true, lockedForMs: lockedFor };
}

export async function setPin(store, pin) {
  if (!isValidPin(pin)) return { status: 400, error: 'The PIN must be exactly 4 digits.' };
  if (await store.get()) return { status: 409, error: 'A PIN is already set. Enter it to unlock, or change it from inside the locker.' };
  await store.put({ ...hashPin(pin), failed_attempts: 0, locked_until: null });
  return { status: 200, ok: true };
}

export async function verifyPin(store, pin, now = Date.now()) {
  const row = await store.get();
  if (!row) return { status: 404, error: 'No PIN is set yet.' };
  if (!isValidPin(pin)) return { status: 400, error: 'Enter your 4-digit PIN.' };
  const lockedFor = row.locked_until ? new Date(row.locked_until).getTime() - now : 0;
  if (lockedFor > 0) return { status: 423, error: 'Too many wrong attempts. Try again later.', lockedForMs: lockedFor };
  if (matches(row, pin)) {
    if (row.failed_attempts || row.locked_until) await store.put({ ...row, failed_attempts: 0, locked_until: null });
    return { status: 200, ok: true };
  }
  const fails = (row.failed_attempts || 0) + 1;
  if (fails >= MAX_FAILS) {
    await store.put({ ...row, failed_attempts: 0, locked_until: new Date(now + LOCK_MS).toISOString() });
    return { status: 423, error: 'Too many wrong attempts. Try again later.', lockedForMs: LOCK_MS };
  }
  await store.put({ ...row, failed_attempts: fails });
  // 403, not 401: a wrong PIN must never look like an expired login to the app.
  return { status: 403, error: `That PIN is not correct. ${MAX_FAILS - fails} ${MAX_FAILS - fails === 1 ? 'try' : 'tries'} left.`, attemptsLeft: MAX_FAILS - fails };
}

export async function changePin(store, oldPin, newPin, now = Date.now()) {
  if (!isValidPin(newPin)) return { status: 400, error: 'The new PIN must be exactly 4 digits.' };
  const v = await verifyPin(store, oldPin, now);
  if (!v.ok) return v;
  await store.put({ ...hashPin(newPin), failed_attempts: 0, locked_until: null });
  return { status: 200, ok: true };
}
