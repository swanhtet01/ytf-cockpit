#!/usr/bin/env node
// inventory.mjs — raw-material inventory & reorder engine for YTF.
//
// The ERP/iStock-comparable core, but AUTO-FED: instead of a human keying in every
// goods-receipt, this reads the supplier email flow (KIIC China carbon black / zinc oxide
// / nylon cord, Junky/Taiwan) and reconstructs a materials inventory — what's on order,
// what's in transit (with ETA), and which materials look due for reorder.
//
// Input : out/raw-material-shipments.csv + out/procurement-ledger.csv  (from extract.mjs)
//         optional: data/inventory-config.json  ({ today, materials:{key:{reorder_days,monthly_mt}} })
// Output: out/inventory.json
//
// Usage : node inventory.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
const cfgPath = path.join(DIR, 'data', 'inventory-config.json');
fs.mkdirSync(outDir, { recursive: true });

const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const TODAY = cfg.today || new Date().toISOString().slice(0, 10);

// --- tiny CSV reader (quoted fields) ---
function readCsv(file) {
  const full = path.join(outDir, file);
  if (!fs.existsSync(full)) return [];
  const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const headers = rows.shift();
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

// --- material catalog (defaults; override in inventory-config.json) ---
const MATERIALS = {
  cb_n220:    { name: 'Carbon Black N220', kind: 'raw', unit: 'mt', reorder_days: cfg.materials?.cb_n220?.reorder_days ?? 30 },
  cb_n330:    { name: 'Carbon Black N330', kind: 'raw', unit: 'mt', reorder_days: cfg.materials?.cb_n330?.reorder_days ?? 30 },
  cb_n660:    { name: 'Carbon Black N660', kind: 'raw', unit: 'mt', reorder_days: cfg.materials?.cb_n660?.reorder_days ?? 45 },
  zinc_oxide: { name: 'Zinc Oxide',        kind: 'raw', unit: 'mt', reorder_days: cfg.materials?.zinc_oxide?.reorder_days ?? 45 },
  nylon_cord: { name: 'Nylon Cord',        kind: 'raw', unit: 'mt', reorder_days: cfg.materials?.nylon_cord?.reorder_days ?? 45 },
  nat_rubber: { name: 'Natural Rubber',    kind: 'raw', unit: 'mt', reorder_days: cfg.materials?.nat_rubber?.reorder_days ?? 45 },
};

// --- shipment extractor: pull material + tonnage + ref + eta from a row's text ---
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function parseEta(text, rowDate) {
  const t = String(text);
  if (/arrive\s+tomorrow/i.test(t)) { const d = new Date(rowDate); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
  // "ETA: Jun 27th" / "arrive in Yangon ... 27th" / "arrival ... Jun 27"
  let m = t.match(/\bETA[:\s]*([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2})/i) || t.match(/arrive[^.]*?\b([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th)?/i);
  if (m && MONTHS[m[1].toLowerCase()] != null) {
    const yr = Number(rowDate.slice(0, 4));
    const mo = MONTHS[m[1].toLowerCase()], day = Number(m[2]);
    const d = new Date(Date.UTC(yr, mo, day));
    if (d.getUTCMonth() !== mo) return null;   // invalid day for that month (e.g. Feb 30) — don't fabricate
    return d.toISOString().slice(0, 10);
  }
  // bare "the 14th" / "early 14th" near 'arrive'
  m = t.match(/arrive[^.]*?\b(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (m) {
    const day = Number(m[1]);
    const base = new Date(rowDate);
    let y = base.getUTCFullYear(), mo = base.getUTCMonth();
    let d = new Date(Date.UTC(y, mo, day));
    if (d.getUTCMonth() !== mo) return null;                 // invalid day this month
    if (d < base) { mo += 1; d = new Date(Date.UTC(y, mo, day)); if (d.getUTCDate() !== day) return null; } // roll to next month safely
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function extractShipment(row) {
  const text = `${row.subject || ''} ${row.note || ''}`;
  const lower = text.toLowerCase();
  // skip pure price-inquiry / parts threads (no tonnage, or clearly machine parts)
  const isParts = /(siemens|drive|card|contactor|motor|finger|cylinder|gauge|cable|plc|hmi|servo|timer|counter|teclock|thickness)/i.test(text)
                  && !/carbon|zinc|nylon|rubber/i.test(text);
  if (isParts) return [];

  const out = [];
  const eta = parseEta(text, (row.date || TODAY).slice(0, 10));
  const ref = (text.match(/\b(26K\d{3,}|26-\d+#?(?:-+\d+#?)?)/) || [])[1] || '';

  // carbon black grades with tonnages: "N220 44mt & N330 66mt"
  const cbGrades = [...lower.matchAll(/n\s*-?\s*(220|330|660)\b/g)].map((m) => m[1]);
  const mtNums = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*mt\b/g)].map((m) => Number(m[1]));
  const mentionsCB = /carbon\s*black|c\.?\s*black|c\.?\s*blk/i.test(text) || cbGrades.length;

  if (mentionsCB) {
    if (cbGrades.length && cbGrades.length === mtNums.length) {
      cbGrades.forEach((g, i) => out.push({ key: `cb_n${g}`, qty_mt: mtNums[i] }));
    } else if (cbGrades.length) {
      const each = mtNums.length ? Math.round((mtNums.reduce((a, b) => a + b, 0) / cbGrades.length)) : null;
      cbGrades.forEach((g) => out.push({ key: `cb_n${g}`, qty_mt: each }));
    } else {
      out.push({ key: 'cb_n330', qty_mt: mtNums[0] ?? null, note: 'grade unspecified' });
    }
  }
  if (/zinc\s*oxide/i.test(text)) {
    const m = lower.match(/zinc\s*oxide[^.]*?(\d+(?:\.\d+)?)\s*mt/);
    out.push({ key: 'zinc_oxide', qty_mt: m ? Number(m[1]) : (mtNums[0] ?? null) });
  }
  if (/nylon\s*cord/i.test(text)) out.push({ key: 'nylon_cord', qty_mt: null });
  if (/natural\s*rubber|\bSBR\b/i.test(text)) out.push({ key: 'nat_rubber', qty_mt: null });

  return out.map((s) => ({
    date: (row.date || '').slice(0, 10), ...s, ref, eta,
    supplier: row.supplier || '', thread_id: row.thread_id || '',
    in_transit: eta ? daysBetween(TODAY, eta) >= -3 : daysBetween((row.date || TODAY).slice(0, 10), TODAY) <= 21,
  }));
}

// --- build shipment events ---
const rows = [...readCsv('raw-material-shipments.csv'), ...readCsv('procurement-ledger.csv')];
let shipments = rows.flatMap(extractShipment).filter((s) => MATERIALS[s.key]).sort((a, b) => (a.date < b.date ? 1 : -1));
// dedupe: the same physical shipment (same PI/container ref) is discussed across multiple
// email threads — collapse by (material, ref, tonnage) so tonnage isn't counted twice.
const seen = new Set();
shipments = shipments.filter((s) => {
  if (!s.ref) return true; // no ref → can't safely dedupe, keep
  const k = `${s.key}|${s.ref}|${s.qty_mt}`;
  if (seen.has(k)) return false;
  seen.add(k); return true;
});

// --- per-material rollup ---
const materials = Object.entries(MATERIALS).map(([key, def]) => {
  const evs = shipments.filter((s) => s.key === key);
  const inTransit = evs.filter((s) => s.in_transit);
  const lastInbound = evs[0]?.date || null;
  const daysSince = lastInbound ? daysBetween(lastInbound, TODAY) : null;
  const nextEta = inTransit.map((s) => s.eta).filter(Boolean).sort()[0] || null;
  const sumMt = (arr) => arr.reduce((a, s) => a + (Number(s.qty_mt) || 0), 0);
  const reorder = evs.length === 0 || (daysSince != null && daysSince > def.reorder_days && inTransit.length === 0);
  return {
    key, name: def.name, kind: def.kind, unit: def.unit,
    shipments: evs.length, in_transit_count: inTransit.length,
    in_transit_mt: sumMt(inTransit), ordered_mt_total: sumMt(evs),
    last_inbound: lastInbound, days_since_last: daysSince, next_eta: nextEta,
    reorder_days: def.reorder_days, reorder_flag: reorder,
    status: reorder ? 'reorder' : inTransit.length ? 'in_transit' : 'ok',
  };
});

// --- alerts ---
const alerts = [];
materials.filter((m) => m.reorder_flag).forEach((m) =>
  alerts.push(`Reorder check: ${m.name} — ${m.days_since_last == null ? 'no inbound on record' : m.days_since_last + 'd since last inbound'}, nothing in transit.`));
materials.filter((m) => m.in_transit_count).forEach((m) =>
  alerts.push(`In transit: ${m.name} — ${m.in_transit_mt ? m.in_transit_mt + 'mt' : m.in_transit_count + ' shipment(s)'}${m.next_eta ? `, ETA ${m.next_eta}` : ''}.`));

const out = {
  generated_at: new Date().toISOString(),
  as_of: TODAY,
  basis: 'auto-derived from supplier emails (KIIC China / Junky Taiwan) — goods-in & in-transit; finished-goods stock pending production-attachment parse',
  totals: {
    materials_tracked: materials.length,
    in_transit_shipments: shipments.filter((s) => s.in_transit).length,
    in_transit_mt: Math.round(shipments.filter((s) => s.in_transit).reduce((a, s) => a + (Number(s.qty_mt) || 0), 0)),
    reorder_flags: materials.filter((m) => m.reorder_flag).length,
  },
  materials,
  in_transit: shipments.filter((s) => s.in_transit).map((s) => ({
    date: s.date, material: MATERIALS[s.key].name, qty_mt: s.qty_mt, eta: s.eta, supplier: s.supplier, ref: s.ref,
  })),
  recent_shipments: shipments.slice(0, 20).map((s) => ({
    date: s.date, material: MATERIALS[s.key].name, qty_mt: s.qty_mt, eta: s.eta, in_transit: s.in_transit, ref: s.ref,
  })),
  alerts,
};
fs.writeFileSync(path.join(outDir, 'inventory.json'), JSON.stringify(out, null, 2) + '\n');

console.log('inventory — done');
console.log('  as of        :', TODAY);
console.log('  materials    :', materials.map((m) => `${m.name.replace('Carbon Black ', 'CB ')}:${m.status}`).join(', '));
console.log('  in transit   :', out.totals.in_transit_shipments, 'shipments,', out.totals.in_transit_mt, 'mt');
console.log('  reorder flags:', out.totals.reorder_flags);
console.log('  ->', path.join('out', 'inventory.json'));
