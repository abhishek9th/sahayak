import express from 'express';
import { requireUser } from '../services/requireUser.js';
import { getSupabaseAdmin } from '../services/supabaseAdmin.js';

// Saved schemes mirrored from the Android app (so the server can watch them for updates).
const router = express.Router();

const KINDS = new Set(['curated', 'catalogue']);

router.get('/', requireUser, async (req, res) => {
  try {
    const { data, error } = await getSupabaseAdmin().from('user_saved_schemes').select('kind,scheme_key,title,subtitle,saved_at').eq('user_id', req.user.id).order('saved_at', { ascending: false }).limit(500);
    if (error) throw error;
    res.json({ items: data });
  } catch (err) {
    console.error('saved list error:', err.message);
    res.status(500).json({ error: 'Could not load saved schemes', code: 'SAVED_ERROR' });
  }
});

router.put('/', requireUser, async (req, res) => {
  const { kind, key, title, subtitle } = req.body || {};
  if (!KINDS.has(kind) || !key || !title) return res.status(400).json({ error: 'kind, key and title are required', code: 'INVALID_INPUT' });
  try {
    const { error } = await getSupabaseAdmin().from('user_saved_schemes').upsert({ user_id: req.user.id, kind, scheme_key: String(key).slice(0, 200), title: String(title).slice(0, 300), subtitle: subtitle ? String(subtitle).slice(0, 300) : null }, { onConflict: 'user_id,kind,scheme_key' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('saved put error:', err.message);
    res.status(500).json({ error: 'Could not save this scheme', code: 'SAVED_ERROR' });
  }
});

router.delete('/:kind/:key', requireUser, async (req, res) => {
  if (!KINDS.has(req.params.kind)) return res.status(400).json({ error: 'Unknown kind', code: 'INVALID_INPUT' });
  try {
    const { error } = await getSupabaseAdmin().from('user_saved_schemes').delete().eq('user_id', req.user.id).eq('kind', req.params.kind).eq('scheme_key', req.params.key);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('saved delete error:', err.message);
    res.status(500).json({ error: 'Could not remove this scheme', code: 'SAVED_ERROR' });
  }
});

export default router;
