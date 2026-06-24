// Robust number parser for the messy, hand-keyed YTF workbooks.
// Handles the real cell formats the naive `Number(String(v).replace(/,/g,''))` silently dropped:
//   '(1,500)' -> -1500 (accounting negative)   '1 234' -> 1234 (space thousands)
//   '500 kg' / '12.5 %' -> 500 / 12.5 (unit/symbol suffix)   '-' / '—' / 'N/A' / '' -> onInvalid
// Returns `onInvalid` (default 0; pass NaN where the caller filters non-numbers) when there is no number.
export function parseNum(v, onInvalid = 0) {
  if (v == null) return onInvalid;
  if (typeof v === 'number') return Number.isFinite(v) ? v : onInvalid;
  let s = String(v).trim();
  if (!s) return onInvalid;
  const low = s.toLowerCase();
  if (s === '-' || s === '–' || s === '—' || low === 'n/a' || low === 'na' || low === 'nil') return onInvalid;
  let neg = false;
  const paren = s.match(/^\((.*)\)$/); // accounting-style negative
  if (paren) { neg = true; s = paren[1]; }
  if (/^\s*-/.test(s)) neg = true;
  s = s.replace(/,/g, '').replace(/[^0-9.]/g, ''); // drop spaces, units, currency, %, sign chars
  // collapse accidental multiple dots (keep the first) — e.g. stray formatting
  const firstDot = s.indexOf('.');
  if (firstDot !== -1) s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
  if (!s || s === '.') return onInvalid;
  const n = Number(s);
  if (!Number.isFinite(n)) return onInvalid;
  return neg ? -n : n;
}
