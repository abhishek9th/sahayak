import { Router } from 'express';
import Groq from 'groq-sdk';
import { getSupabaseAdmin } from '../services/supabaseAdmin.js';

// POST /api/vision/scheme { image: "data:image/jpeg;base64,...", lang }
// Reads a photo of a scheme banner / poster / pamphlet with a vision model and works out which scheme or benefit it
// is about. The model may only report what is actually printed in the picture (names, benefit wording, organisation);
// it never supplies scheme facts. Those come from matching the printed words against the real myscheme.gov.in
// catalogue, and every match is shown as "check the official page", not as a confirmed identification.
const router = Router();

const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
const MAX_DATA_URL = 4_500_000; // the vision API rejects very large inline images

const PROMPT = `You are reading a photo of an Indian government scheme banner, poster, pamphlet, notice or screenshot.
Report ONLY what is visibly printed in the image. Never guess or add scheme facts from memory.
Return JSON with exactly these keys:
- "is_scheme_material": true if the image is about a government scheme, benefit, scholarship, subsidy, loan or welfare programme, else false
- "scheme_names": array of scheme/programme names exactly as printed (empty if none is printed)
- "benefit_summary": one short sentence of the benefit/offer as printed, or "" if not visible
- "organisation": ministry/department/bank named in the image, or ""
- "keywords": up to 6 distinctive words from the image that describe the benefit (e.g. "scholarship", "pension", "tractor", "girl child")
- "language": language of the printed text
- "readable": false if the text is too blurry or small to read reliably`;

const clean = (s) => String(s || '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

router.post('/scheme', async (req, res) => {
  try {
    const image = req.body?.image;
    if (typeof image !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image)) {
      return res.status(400).json({ error: 'Please send a JPEG, PNG or WebP image.' });
    }
    if (image.length > MAX_DATA_URL) return res.status(413).json({ error: 'That image is too large. Try a smaller photo.' });
    if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'Image reading is not configured on the server.' });

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: VISION_MODEL,
      temperature: 0,
      max_completion_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
    });
    let read = {};
    try {
      read = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    } catch {
      read = {};
    }
    const names = (Array.isArray(read.scheme_names) ? read.scheme_names : []).map(clean).filter((n) => n.length >= 4).slice(0, 3);
    const keywords = (Array.isArray(read.keywords) ? read.keywords : []).map(clean).filter((k) => k.length >= 4).slice(0, 6);
    const summary = {
      isSchemeMaterial: read.is_scheme_material === true,
      schemeNames: (Array.isArray(read.scheme_names) ? read.scheme_names : []).map((n) => String(n).slice(0, 160)).slice(0, 3),
      benefit: String(read.benefit_summary || '').slice(0, 300),
      organisation: String(read.organisation || '').slice(0, 160),
      language: String(read.language || '').slice(0, 40),
      readable: read.readable !== false,
    };

    let matches = [];
    if (summary.isSchemeMaterial && (names.length || keywords.length)) {
      const supabase = getSupabaseAdmin();
      const terms = [...names.map((n) => ({ t: n, w: 10 })), ...keywords.map((k) => ({ t: k, w: 2 }))];
      const filter = terms.flatMap(({ t }) => [`name.ilike.%${t}%`, `short_description.ilike.%${t}%`]).join(',');
      const { data, error } = await supabase
        .from('myscheme_catalogue')
        .select('slug, name, short_description, level, ministries, states, category_tags')
        .or(filter)
        .limit(60);
      if (error) throw error;
      const score = (row) => {
        const name = String(row.name || '').toLowerCase();
        const desc = String(row.short_description || '').toLowerCase();
        let s = 0;
        for (const { t, w } of terms) {
          const q = t.toLowerCase();
          if (name === q) s += 50;
          if (name.includes(q)) s += w * 2;
          if (desc.includes(q)) s += w;
        }
        return s;
      };
      matches = (data || [])
        .map((r) => ({ r, s: score(r) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 5)
        .map((x) => x.r);
    }
    res.json({ read: summary, matches });
  } catch (error) {
    console.error('Vision scheme error:', error.message);
    res.status(502).json({ error: 'Could not read that image right now. Please try again.' });
  }
});

export default router;
