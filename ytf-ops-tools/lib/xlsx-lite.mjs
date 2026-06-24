// xlsx-lite.mjs — minimal, dependency-free .xlsx reader (Node built-in zlib only).
// Unlocks YTF's hundreds of production / stock / sales spreadsheets without openpyxl/Excel.
//
// readXlsx(path) -> { sheets: [ { name, rows: [ [cell, cell, ...], ... ] } ] }
// Cells are strings or numbers (empty cells -> ''). Good enough for the tabular reports YTF uses.

import fs from 'node:fs';
import zlib from 'node:zlib';

// --- ZIP: parse central directory, return Map<name, Buffer(uncompressed)> ---
function unzip(buf) {
  // find End Of Central Directory record (sig 0x06054b50), scanning back from the end
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip / no EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const fnLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + fnLen);
    // local header to find the actual data start
    const lhFnLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhFnLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let content;
    try { content = method === 0 ? raw : zlib.inflateRawSync(raw); }
    catch { content = Buffer.alloc(0); }
    files.set(name, content);
    off += 46 + fnLen + extraLen + commentLen;
  }
  return files;
}

// --- XML helpers (regex-based; spreadsheetML is regular enough) ---
const decode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  // each <si>...</si> may contain multiple <t> runs; concatenate them
  for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) || []) {
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]));
    out.push(parts.join(''));
  }
  return out;
}

const colToIdx = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function parseSheet(xml, shared) {
  const rows = [];
  for (const rowXml of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const cm of rowXml.matchAll(/<c\s+([^>]*?)\/?>(?:([\s\S]*?)<\/c>)?/g)) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const ref = (/r="([^"]+)"/.exec(attrs) || [])[1] || '';
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || 'n';
      const idx = colToIdx(ref);
      let val = '';
      if (type === 's') {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        val = v != null ? (shared[+v] ?? '') : '';
      } else if (type === 'inlineStr') {
        val = decode([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        if (v != null) { const num = Number(v); val = Number.isFinite(num) ? num : decode(v); }
      }
      cells[idx] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

// ref "B5" -> {r:4, c:1}
function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || '');
  if (!m) return null;
  return { c: colToIdx(m[1]), r: Number(m[2]) - 1 };
}

// merged ranges from <mergeCells><mergeCell ref="A1:C2"/></mergeCells>
function parseMerges(xml) {
  const out = [];
  for (const m of xml.matchAll(/<mergeCell[^>]*\bref="([A-Z]+\d+):([A-Z]+\d+)"/g)) {
    const s = parseRef(m[1]), e = parseRef(m[2]);
    if (s && e) out.push({ s, e });
  }
  return out;
}

// propagate each merged range's top-left value across the range (empty cells only).
// Essential for the messy YTF sheets: merged section labels, multi-row headers, spanned categories.
export function densify(rows, merges) {
  const g = rows.map((r) => r.slice());
  for (const { s, e } of merges || []) {
    const v = g[s.r] && g[s.r][s.c];
    if (v === undefined || v === '') continue;
    for (let r = s.r; r <= e.r; r++) {
      if (!g[r]) g[r] = [];
      for (let c = s.c; c <= e.c; c++) if (g[r][c] === undefined || g[r][c] === '') g[r][c] = v;
    }
  }
  return g;
}

// opts.densify (default false) — fill merged cells. Generators that need merge-aware grids pass true.
export function readXlsx(path, opts = {}) {
  const files = unzip(fs.readFileSync(path));
  const shared = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
  // sheet names + order from workbook.xml (display order matches sheetN.xml ordering closely enough)
  const wb = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const names = [...wb.matchAll(/<sheet[^>]*\bname="([^"]+)"/g)].map((m) => decode(m[1]));
  const sheetFiles = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => (+(/(\d+)/.exec(a)[1]) - +(/(\d+)/.exec(b)[1])));
  const sheets = sheetFiles.map((k, i) => {
    const xml = files.get(k).toString('utf8');
    const rows = parseSheet(xml, shared);
    const merges = parseMerges(xml);
    return {
      name: names[i] || k.replace('xl/worksheets/', '').replace('.xml', ''),
      rows: opts.densify ? densify(rows, merges) : rows,
      merges,
    };
  });
  return { sheets };
}

// CLI: `node xlsx-lite.mjs <file> [sheetIndex] [maxRows] [dense]` -> dump structure + merges
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('xlsx-lite.mjs')) {
  const [, , file, si = '0', max = '20', dense] = process.argv;
  if (file) {
    const { sheets } = readXlsx(file, { densify: dense === 'dense' || dense === '1' });
    console.log('sheets:', sheets.map((s, i) => `[${i}] ${s.name} (${s.rows.length}r, ${s.merges.length}merges)`).join(' | '));
    const s = sheets[+si];
    if (s) {
      console.log(`merges[${si}]:`, s.merges.slice(0, 12).map((m) => `${m.s.r},${m.s.c}->${m.e.r},${m.e.c}`).join('  '));
      s.rows.slice(0, +max).forEach((r, i) => {
        const cells = r.map((c, j) => (c === '' ? null : `${j}:${c}`)).filter(Boolean);
        if (cells.length) console.log(`r${i}`, cells.slice(0, 14).join(' | '));
      });
    }
  }
}
