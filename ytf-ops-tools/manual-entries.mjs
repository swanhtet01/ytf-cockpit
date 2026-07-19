#!/usr/bin/env node
// manual-entries.mjs — fold device-captured records into the cockpit. Reads data/manual-entries/*.json
// (two shapes: entry.html exports = array of {kind, ...fields}; whiteboard-ocr.mjs = {image, records:[…]})
// and emits out/manual-entries.json — a normalized, deduped, newest-first list the pipeline surfaces and
// insights can act on. This closes the whiteboard/OCR loop: collect (entry.html) → analyse (whiteboard-ocr)
// → here → cockpit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const inDir = path.join(DIR, 'data', 'manual-entries');
const outDir = path.join(DIR, 'out');
fs.mkdirSync(inDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const records = [];
const files = fs.existsSync(inDir) ? fs.readdirSync(inDir).filter((f) => f.toLowerCase().endsWith('.json')) : [];
function canonicalGroup(value) {
  const v = String(value || '').toLowerCase();
  if (/plant[-\s]?b|bilin/.test(v)) return 'plant-b';
  if (/plant[-\s]?a|spt|yangon/.test(v)) return 'plant-a';
  if (/head|office|company/.test(v)) return 'head-office';
  return value || null;
}
for (const f of files) {
  let doc; try { doc = JSON.parse(fs.readFileSync(path.join(inDir, f), 'utf8')); } catch { continue; }
  if (!doc || typeof doc !== 'object') continue;                     // null / primitive — skip cleanly
  const rows = Array.isArray(doc) ? doc                              // entry.html export
    : Array.isArray(doc.records) ? doc.records                       // whiteboard-ocr output
    : (doc.kind ? [doc] : []);
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;                       // skip null/primitive entries inside the array
    const fields = r.fields && typeof r.fields === 'object' ? r.fields : r;
    const date = r.date || fields.date || (r.entered_at || '').slice(0, 10) || null;
    const kind = (r.kind || 'other').toLowerCase();
    const owner = fields.who || fields.owner || fields.assigned_to || null;
    const due = fields.due || fields.due_date || null;
    const status = (fields.status || '').toLowerCase() || null;
    const plant = r.plant || fields.plant || (/plant\s*b|bilin/i.test(String(fields.area || fields.site || '')) ? 'plant-b'
      : /plant\s*a|spt|yangon/i.test(String(fields.area || fields.site || '')) ? 'plant-a' : null);
    const group = canonicalGroup(r.group || fields.group || plant || fields.plant || fields.site || null);
    // is this an actionable record (CAPA / corrective work)? 5W1H, NCR, incident, downtime, claim follow-up
    const actionable = /5w1h|ncr|capa|incident|downtime|safety/.test(kind) || !!(owner || due || (status && status !== 'closed' && status !== 'verified'));
    records.push({
      kind, date,
      via: r.captured_via || (doc.image ? 'whiteboard-ocr' : 'entry'),
      group, plant,
      department: r.department || fields.department || null,
      image: r.image || doc.image || null,
      confidence: r.confidence ?? null,
      owner, due, status,
      area: fields.area || fields.machine || fields.site || null,
      actionable,
      open: actionable && status !== 'closed' && status !== 'verified' && status !== 'done',
      summary: r.source_text || fields.what || fields.description || fields.reason || fields.notes
        || fields.claim_id || fields.machine || fields.product || JSON.stringify(fields).slice(0, 80),
      fields,
      src: f,
    });
  }
}
records.sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1));
const by_kind = records.reduce((a, r) => ((a[r.kind] = (a[r.kind] || 0) + 1), a), {});
const open_actions = records.filter((r) => r.open);
const out = { generated_at: new Date().toISOString(), count: records.length, by_kind, open_action_count: open_actions.length, records: records.slice(0, 200) };
fs.writeFileSync(path.join(outDir, 'manual-entries.json'), JSON.stringify(out, null, 2) + '\n');
console.log('manual-entries — done');
console.log('  files :', files.length, '· records:', records.length, '·', JSON.stringify(by_kind));
console.log('  ->', path.join('out', 'manual-entries.json'));
