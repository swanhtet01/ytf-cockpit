// read-sheet.mjs — robust spreadsheet reader using SheetJS (reads .xlsx AND legacy .xls/OLE2,
// handles merged cells), with the same {sheets:[{name,rows}]} shape as the old xlsx-lite.
// Falls back to xlsx-lite if SheetJS isn't installed (so the pipeline still runs zero-dep locally).
import fs from 'node:fs';

let XLSX = null;
async function lib() {
  if (XLSX) return XLSX;
  try { XLSX = await import('xlsx'); XLSX = XLSX.default || XLSX; } catch { XLSX = null; }
  return XLSX;
}

// returns { sheets: [{ name, rows: any[][] }] }
// Use the proven xlsx-lite for .xlsx (zip) — generators' column maps are tuned to its output.
// Use SheetJS ONLY for legacy .xls (OLE2), which xlsx-lite cannot read at all.
export async function readSheet(path) {
  if (!isOle2(path)) {
    const { readXlsx } = await import('./xlsx-lite.mjs');
    return readXlsx(path);
  }
  const x = await lib();
  if (!x) throw new Error('legacy .xls needs SheetJS (not installed)');
  const wb = x.readFile(path, { cellDates: false, cellNF: false, cellText: false });
  return {
    sheets: (wb.SheetNames || []).map((name) => {
      const ws = wb.Sheets[name];
      const rows = x.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
      return { name, rows: rows || [] };
    }),
  };
}

export function isOle2(path) {
  try { const b = fs.readFileSync(path).slice(0, 4).toString('hex'); return b === 'd0cf11e0'; } catch { return false; }
}
