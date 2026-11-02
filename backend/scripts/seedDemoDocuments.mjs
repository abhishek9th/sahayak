// Adds SAMPLE documents to the demo account's Sahayak Locker (ration card, ABHA id, PAN, Aadhaar, voter id, income
// statement) so the locker and the document checklists can be shown end to end.
//
// These are NOT real documents: every PDF is stamped "DEMO SAMPLE" and uses obviously fake numbers, and each row is
// marked metadata.demo = true so the app shows a "Demo sample" label. They are marked verified only so the verified
// badge can be shown in the demo; the app labels that as "Verified (demo)", never as a real verification. Re-running replaces the previous demo rows.
//
//   node scripts/seedDemoDocuments.mjs [email]        (default: user01@schemesetu.demo)
import 'dotenv/config';
import { getSupabaseAdmin } from '../services/supabaseAdmin.js';

const email = (process.argv[2] || 'user01@schemesetu.demo').toLowerCase();

const DOCS = [
  { type: 'ration_card', title: 'Ration Card (Demo)', lines: ['Department of Food and Civil Supplies (sample layout)', 'Card type: Priority Household (PHH)', 'Card no.: 0000-DEMO-0001', 'Head of family: Demo User', 'Members: 4', 'State: Uttar Pradesh'] },
  { type: 'abha_id', title: 'ABHA Health ID (Demo)', lines: ['Ayushman Bharat Digital Mission (sample layout)', 'ABHA number: 00-0000-0000-0000', 'ABHA address: demo.user@abdm', 'Name: Demo User', 'Year of birth: 1990'] },
  { type: 'pan', title: 'PAN Card (Demo)', lines: ['Income Tax Department (sample layout)', 'Permanent Account Number: DEMOX0000X', 'Name: DEMO USER', 'Date of birth: 01/01/1990'] },
  { type: 'aadhaar', title: 'Aadhaar Card (Demo)', lines: ['Unique Identification Authority of India (sample layout)', 'Aadhaar number: 0000 0000 0000', 'Name: Demo User', 'Date of birth: 01/01/1990', 'Address: Demo Street, Lucknow, Uttar Pradesh'] },
  { type: 'voter_id', title: 'Voter ID / EPIC (Demo)', lines: ['Election Commission of India (sample layout)', 'EPIC no.: DEMO0000000', 'Name: Demo User', 'Assembly constituency: Demo Nagar'] },
  { type: 'income_certificate', title: 'Income Statement (Demo)', lines: ['Tehsil / District Administration (sample layout)', 'Certificate no.: INC/DEMO/0001', 'Name: Demo User', 'Annual family income: Rs 2,50,000', 'Valid for: 1 year from issue'] },
];

// Smallest valid single-page text PDF (Helvetica), so no PDF library is needed.
function makePdf(title, lines) {
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);
  const body = [
    'BT /F2 26 Tf 60 780 Td (DEMO SAMPLE - NOT A REAL DOCUMENT) Tj ET',
    `BT /F2 20 Tf 60 730 Td (${esc(title)}) Tj ET`,
    ...lines.map((l, i) => `BT /F1 14 Tf 60 ${680 - i * 28} Td (${esc(l)}) Tj ET`),
    'BT /F1 10 Tf 60 90 Td (Created only to demonstrate SchemeSahayak. It has no legal value.) Tj ET',
  ].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const supabase = getSupabaseAdmin();
let user = null;
for (let page = 1; !user && page <= 20; page++) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
  if (error) throw error;
  user = data.users.find((u) => (u.email || '').toLowerCase() === email) || null;
  if (data.users.length < 200) break;
}
if (!user) {
  console.error(`No account with email ${email}.`);
  process.exit(1);
}

// Remove earlier demo rows and their files, then add fresh ones.
const { data: old } = await supabase.from('user_documents').select('id,file_path,metadata').eq('user_id', user.id);
const oldDemo = (old || []).filter((d) => d.metadata?.demo === true);
if (oldDemo.length) {
  await supabase.storage.from('documents').remove(oldDemo.map((d) => d.file_path));
  await supabase.from('user_documents').delete().in('id', oldDemo.map((d) => d.id));
}
for (const d of DOCS) {
  const path = `${user.id}/demo_${d.type}.pdf`;
  const up = await supabase.storage.from('documents').upload(path, makePdf(d.title, d.lines), { contentType: 'application/pdf', upsert: true });
  if (up.error) throw up.error;
  const ins = await supabase.from('user_documents').insert({ user_id: user.id, document_type: d.type, file_path: path, file_name: `${d.title}.pdf`, mime_type: 'application/pdf', verification_status: 'verified', verified_at: new Date().toISOString(), metadata: { demo: true } });
  if (ins.error) throw ins.error;
  console.log('added', d.type);
}
console.log(`Done: ${DOCS.length} demo documents for ${email}`);
