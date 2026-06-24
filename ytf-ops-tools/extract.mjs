#!/usr/bin/env node
// YTF Ops Extractor — turns raw Yangon Tyre email threads into structured ledgers
// and an auto-generated, data-current ops brief.
//
// This is the "doc as a tool" pattern: instead of hand-editing a stale Google Doc,
// you run this against the live inbox and it regenerates the structured truth.
//
// Input : data/threads.sample.json  (array of {id,date,sender,subject,snippet?})
//         — in production, replace with a live Gmail pull (search "yangontyre.com OR ...").
// Output: out/*.csv  +  out/YTF-LIVE-OPS-BRIEF.md  +  out/summary.json
//
// Usage : node extract.mjs [path/to/threads.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const inPath = process.argv[2] || path.join(DIR, 'data', 'threads.sample.json');
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });

const threads = JSON.parse(fs.readFileSync(inPath, 'utf8'));

// ---- known people / org directory (extend as you learn the org) ----
const DIRECTORY = {
  'htinkyawoo@yangontyre.com': ['Dr. Htin Kyaw Oo', 'Executive Director', 'YTF'],
  'htoomaw.ytf@gmail.com': ['Mr. Kyaw Kyaw Sein (U Kyaw / Htoo Maw)', 'Procurement / Factory', 'YTF'],
  'theinminindustry@gmail.com': ['Thein Min Industry', 'Partner', 'YTF'],
  'chriskhant@gmail.com': ['Chris Khant', 'Office', 'YTF'],
  'swannyhtet@gmail.com': ['Swan Htet', 'Owner / Data', 'YTF'],
  'ytqc2019@gmail.com': ['QC Team', 'Quality', 'YTF'],
  'showroom.yangontyre@gmail.com': ['Showroom', 'Sales', 'YTF'],
  'yangontyrefactory.bilin@gmail.com': ['Bilin Plant Office', 'Production', 'YTF Plant'],
  'yangontyrefactory.spt@gmail.com': ['SPT Plant Office', 'Production / HR', 'YTF Plant'],
  'ytpdoffice01@gmail.com': ['Production Office (SPT)', 'Production', 'YTF Plant'],
  'ytfplanningoffice01@gmail.com': ['Planning Office', 'Planning', 'YTF Plant'],
  'j2135.junky@msa.hinet.net': ['JS Cheng (Junky)', 'Supplier — machine parts', 'Taiwan'],
  'jerryrecht.junky@gmail.com': ['Junky (Jerry)', 'Supplier — machine parts', 'Taiwan'],
  'kiicwang@163.com': ['Ms Wang — King Industry (KIIC)', 'Supplier — raw materials', 'China'],
  'kiicqin@163.com': ['Mr Qin — King Industry (KIIC)', 'Supplier — raw materials', 'China'],
  'zhuangshidong1972@hotmail.com': ['Mr Dong — King Industry (KIIC)', 'Supplier — raw materials', 'China'],
  'evergreenmyanmar@gmail.com': ['Evergreen Myanmar', 'Agent / Logistics', 'Myanmar'],
  'paing.soe.aung@dksh.com': ['Paing Soe Aung (DKSH)', 'Supplier — compressors', 'Myanmar'],
};
const who = (email) => DIRECTORY[String(email).toLowerCase()]?.[0] || email;

// ---- classifier ----
function classify(t) {
  const s = (t.subject || '').toLowerCase();
  const from = (t.sender || '').toLowerCase();
  if (parseClaim(t.subject)) return 'claim';
  if (/\btft\(\d+\)/i.test(s)) return 'procurement';
  if (from.includes('163.com') || from.includes('zhuangshidong') || /carbon black|zinc oxide|nylon cord|raw/i.test(s)) return 'raw_material';
  if (/production|stock balance|flap|monthly/i.test(s)) return 'production';
  if (/salary|overdue|payment|invoice|financial/i.test(s)) return 'finance';
  if (/motor|compressor|servo|pump|cable|maintenance|burn out|machine/i.test(s)) return 'maintenance';
  if (from.includes('businessprofile') || /review|performance report|show room|showroom/i.test(s)) return 'marketing';
  if (/appointment|hospital|heart centre|medical/i.test(s)) return 'personal';
  return 'other';
}

// ---- parsers ----
// Claim subjects seen in the live inbox come in several shapes:
//   #YGN-R117-26 ( A )   #YGN-B032-26 ( NA )   #YGN-R094-26 ( 50% )
//   #YTF-R093-26 ( 50% DC )   #YGN-T011-2026 ( A )   #YGN-MC-001-26 ( A )
//   #YGN-R075-26 50% DISCOUNT   (status with NO parentheses)
// So: prefix YGN|YTF, type R/B/T/MC, number, year (2 or 4 digits), and an
// OPTIONAL status that is either parenthesised or trailing free text.
const CLAIM_RE = /#?\s*(YGN|YTF)-(MC|[RBT])-?\s*0*(\d+)\s*-\s*(\d{2,4})(?:\s*\(\s*([^)]*?)\s*\)|\s+([^\n]+))?/i;
function parseClaim(subject) {
  const m = (subject || '').match(CLAIM_RE);
  if (!m) return null;
  const [, prefix, typeRaw, no, yr, paren, trailing] = m;
  const type = typeRaw.toUpperCase();
  const sr = String(paren ?? trailing ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  let status = 'other';
  if (sr === 'A' || sr === 'OK') status = 'approved';
  else if (sr === 'NA' || sr === 'N/A') status = 'rejected';
  else if (/\b50\b|50\s*%/.test(sr)) status = 'partial';
  else if (sr === '') status = 'unspecified';
  const product = { R: 'radial', B: 'bias', T: 'tube', MC: 'motorcycle' }[type] || type.toLowerCase();
  return { prefix, type, product, claim_no: Number(no), year: yr, status, status_raw: sr };
}
const TFT_RE = /\btft\((\d+)\)/i;
const parseTFT = (subject) => (subject || '').match(TFT_RE)?.[1] || null;

// ---- run ----
const rows = threads.map((t) => ({ ...t, category: classify(t), claim: parseClaim(t.subject), tft: parseTFT(t.subject) }));
const by = (c) => rows.filter((r) => r.category === c);

// ---- CSV writers ----
const csv = (headers, records) =>
  [headers.join(','), ...records.map((r) => headers.map((h) => {
    const v = r[h] ?? '';
    return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  }).join(','))].join('\n') + '\n';

const claims = by('claim').filter((r) => r.claim).map((r) => ({
  date: r.date.slice(0, 10),
  claim_id: `${r.claim.type}${r.claim.claim_no}-${r.claim.year}`,
  product: r.claim.product, claim_no: r.claim.claim_no, year: r.claim.year,
  status: r.claim.status, status_raw: r.claim.status_raw, decided_by: who(r.sender), thread_id: r.id,
})).sort((a, b) => a.product.localeCompare(b.product) || a.claim_no - b.claim_no);

const procurement = by('procurement').map((r) => ({
  date: r.date.slice(0, 10), tft_ref: r.tft, supplier: who(r.sender), subject: r.subject, note: r.snippet || '', thread_id: r.id,
})).sort((a, b) => Number(a.tft_ref) - Number(b.tft_ref));

const production = by('production').map((r) => ({ date: r.date.slice(0, 10), source: who(r.sender), report: r.subject, thread_id: r.id }));
const rawmat = by('raw_material').map((r) => ({ date: r.date.slice(0, 10), supplier: who(r.sender), subject: r.subject, note: r.snippet || '', thread_id: r.id }));

const comms = rows.map((r) => ({ date: r.date.slice(0, 10), category: r.category, from: who(r.sender), subject: r.subject, thread_id: r.id }))
  .sort((a, b) => (a.date < b.date ? 1 : -1));

const contacts = [...new Set(rows.map((r) => r.sender.toLowerCase()))].map((e) => {
  const d = DIRECTORY[e] || [e, '', ''];
  return { email: e, name: d[0], role: d[1], org: d[2], messages: rows.filter((r) => r.sender.toLowerCase() === e).length };
}).sort((a, b) => b.messages - a.messages);

fs.writeFileSync(path.join(outDir, 'claims-ledger.csv'), csv(['date', 'claim_id', 'product', 'claim_no', 'year', 'status', 'status_raw', 'decided_by', 'thread_id'], claims));
fs.writeFileSync(path.join(outDir, 'procurement-ledger.csv'), csv(['date', 'tft_ref', 'supplier', 'subject', 'note', 'thread_id'], procurement));
fs.writeFileSync(path.join(outDir, 'production-reports.csv'), csv(['date', 'source', 'report', 'thread_id'], production));
fs.writeFileSync(path.join(outDir, 'raw-material-shipments.csv'), csv(['date', 'supplier', 'subject', 'note', 'thread_id'], rawmat));
fs.writeFileSync(path.join(outDir, 'communications-index.csv'), csv(['date', 'category', 'from', 'subject', 'thread_id'], comms));
fs.writeFileSync(path.join(outDir, 'contacts.csv'), csv(['email', 'name', 'role', 'org', 'messages'], contacts));

// ---- stats ----
const catCounts = rows.reduce((a, r) => ((a[r.category] = (a[r.category] || 0) + 1), a), {});
const claimStatus = claims.reduce((a, c) => ((a[c.status] = (a[c.status] || 0) + 1), a), {});
const claimByProduct = claims.reduce((a, c) => ((a[c.product] = (a[c.product] || 0) + 1), a), {});
const dates = rows.map((r) => r.date.slice(0, 10)).sort();
const approvalRate = claims.length ? Math.round((100 * (claimStatus.approved || 0)) / claims.length) : 0;

const summary = {
  generated_at: new Date().toISOString(),
  window: { from: dates[0], to: dates[dates.length - 1] },
  threads: rows.length,
  categories: catCounts,
  claims: { total: claims.length, by_status: claimStatus, by_product: claimByProduct, approval_rate_pct: approvalRate,
    radial_range: claims.filter(c=>c.product==='radial').map(c=>c.claim_no), },
  procurement: { tft_threads: procurement.length, refs: procurement.map((p) => p.tft_ref) },
  contacts: contacts.length,
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

// ---- auto-generated brief (the "living doc") ----
const md = `# YTF — Live Operations Brief (auto-generated)

> Generated ${summary.generated_at} from ${rows.length} email threads (${summary.window.from} → ${summary.window.to}).
> This file is produced by \`extract.mjs\`. Do not edit by hand — re-run the tool.

## Snapshot
- **Warranty claims processed:** ${claims.length}  ·  approved ${claimStatus.approved || 0} / rejected ${claimStatus.rejected || 0} / partial ${claimStatus.partial || 0}  ·  **${approvalRate}% approval**
- **Claims by product:** ${Object.entries(claimByProduct).map(([k, v]) => `${v} ${k}`).join(', ')}
- **Procurement threads (TFT):** ${procurement.length}  (refs ${procurement[0]?.tft_ref}–${procurement[procurement.length - 1]?.tft_ref}, supplier: JS Cheng / Junky)
- **Production reports in window:** ${production.length}
- **Raw-material / shipment threads:** ${rawmat.length}  (KIIC China — carbon black, zinc oxide)

## Claims ledger (radial)
| Claim | Date | Status | Decided by |
|------|------|--------|-----------|
${claims.filter((c) => c.product === 'radial').map((c) => `| ${c.claim_id} | ${c.date} | ${c.status} (${c.status_raw}) | ${c.decided_by} |`).join('\n')}

## Claims ledger (bias / tube)
| Claim | Date | Status | Decided by |
|------|------|--------|-----------|
${claims.filter((c) => c.product !== 'radial').map((c) => `| ${c.claim_id} | ${c.date} | ${c.status} (${c.status_raw}) | ${c.decided_by} |`).join('\n')}

## Procurement (machine parts — Junky/Taiwan)
| TFT | Date | Note |
|-----|------|------|
${procurement.map((p) => `| ${p.tft_ref} | ${p.date} | ${p.note || p.subject} |`).join('\n')}

## Production reports
${production.map((p) => `- **${p.date}** — ${p.report} _(${p.source})_`).join('\n') || '- none in window'}

## Raw materials & shipments (KIIC China)
${rawmat.map((r) => `- **${r.date}** — ${r.subject} _(${r.supplier})_`).join('\n') || '- none in window'}

## Org directory (active in window)
| Name | Role | Org | Msgs |
|------|------|-----|------|
${contacts.slice(0, 14).map((c) => `| ${c.name} | ${c.role} | ${c.org} | ${c.messages} |`).join('\n')}

---
*Source: Gmail (filter: yangontyre.com / claim IDs / TFT). Extend \`data/threads.json\` with a live pull to refresh.*
`;
fs.writeFileSync(path.join(outDir, 'YTF-LIVE-OPS-BRIEF.md'), md);

// ---- console summary ----
console.log('YTF Ops Extractor — done');
console.log('  threads      :', rows.length);
console.log('  categories   :', JSON.stringify(catCounts));
console.log('  claims       :', claims.length, JSON.stringify(claimStatus), `(${approvalRate}% approval)`);
console.log('  procurement  :', procurement.length, 'TFT threads');
console.log('  contacts     :', contacts.length);
console.log('  -> out/claims-ledger.csv, procurement-ledger.csv, production-reports.csv,');
console.log('     raw-material-shipments.csv, communications-index.csv, contacts.csv,');
console.log('     summary.json, YTF-LIVE-OPS-BRIEF.md');
