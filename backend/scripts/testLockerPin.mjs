import assert from 'node:assert/strict';
import { changePin, isValidPin, pinStatus, setPin, verifyPin, MAX_FAILS, LOCK_MS } from '../services/lockerPin.js';

const mem = () => {
  let row = null;
  return { get: async () => row, put: async (r) => { row = r; }, raw: () => row };
};
const s = mem();
assert.equal((await pinStatus(s)).hasPin, false);
assert.equal((await setPin(s, '12')).status, 400);
assert.equal((await setPin(s, 'abcd')).status, 400);
assert.equal((await setPin(s, '4821')).status, 200);
assert.equal((await setPin(s, '1111')).status, 409);
assert.ok(!JSON.stringify(s.raw()).includes('4821'), 'PIN must not be stored in clear');
assert.equal((await verifyPin(s, '4821')).status, 200);
const r = await verifyPin(s, '0000');
assert.equal(r.status, 403);
assert.equal(r.attemptsLeft, MAX_FAILS - 1);
assert.equal((await verifyPin(s, '4821')).status, 200); // success resets the counter
assert.equal(s.raw().failed_attempts, 0);
const t0 = Date.now();
for (let i = 0; i < MAX_FAILS - 1; i++) assert.equal((await verifyPin(s, '9999', t0)).status, 403);
assert.equal((await verifyPin(s, '9999', t0)).status, 423);
assert.equal((await verifyPin(s, '4821', t0 + 1000)).status, 423, 'locked even for the right PIN');
assert.equal((await verifyPin(s, '4821', t0 + LOCK_MS + 1000)).status, 200, 'unlocks after the lock time');
assert.equal((await changePin(s, '0000', '5555')).status, 403);
assert.equal((await changePin(s, '4821', '5555')).status, 200);
assert.equal((await verifyPin(s, '4821')).status, 403);
assert.equal((await verifyPin(s, '5555')).status, 200);
assert.ok(isValidPin('0123') && !isValidPin('12345'));
console.log('locker pin logic: all checks passed');
