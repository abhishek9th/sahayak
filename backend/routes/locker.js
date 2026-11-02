import express from 'express';
import { requireUser } from '../services/requireUser.js';
import { getSupabaseAdmin } from '../services/supabaseAdmin.js';
import { changePin, pinStatus, setPin, verifyPin } from '../services/lockerPin.js';

// Sahayak Locker PIN (see services/lockerPin.js). The hash lives in public.locker_pins, which has no client policies,
// so only this server (service role) can read or write it.
const router = express.Router();

const storeFor = (userId) => ({
  async get() {
    const { data, error } = await getSupabaseAdmin().from('locker_pins').select('pin_hash,salt,failed_attempts,locked_until').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data;
  },
  async put(row) {
    const { error } = await getSupabaseAdmin().from('locker_pins').upsert({ user_id: userId, ...row, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
  },
});

const handle = (fn) => async (req, res) => {
  try {
    const { status, ...body } = await fn(storeFor(req.user.id), req.body || {});
    res.status(status || 200).json(status && status >= 400 ? { ...body, code: 'LOCKER_PIN' } : body);
  } catch (err) {
    console.error('locker pin error:', err.message);
    const missing = /locker_pins/.test(err.message || '') && /(does not exist|schema cache|relation)/i.test(err.message || '');
    res.status(500).json({ error: missing ? 'The locker is not set up on the server yet (database migration pending).' : 'Could not reach the locker. Try again.', code: missing ? 'LOCKER_NOT_MIGRATED' : 'LOCKER_ERROR' });
  }
};

router.get('/pin', requireUser, handle((store) => pinStatus(store)));
router.post('/pin', requireUser, handle((store, b) => setPin(store, b.pin)));
router.post('/pin/verify', requireUser, handle((store, b) => verifyPin(store, b.pin)));
router.post('/pin/change', requireUser, handle((store, b) => changePin(store, b.oldPin, b.newPin)));

export default router;
