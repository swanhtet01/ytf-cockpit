// tyre-size.mjs — parse Yangon Tyre's size strings into structured fields. YTF-specific.
// Examples seen in the workbooks: "145 R 12 C (6-PR)", "2.75-17 (YT-123)", "60/100-17 (YT-118)",
// "185/70 R 14(Premier Taxi)", "6.50 R 16 (B-210)".
//   - construction: "radial" if it contains R between numbers, else "bias" (the "-" diagonal form)
//   - rim: the wheel diameter (inches)
//   - aspect / width where present; ply rating from "(6-PR)"; mould/pattern code "YT-123" / "B-210"
export function parseTyreSize(raw) {
  const s = String(raw || '').trim();
  const out = { raw: s, construction: null, rim: null, width: null, aspect: null, ply: null, code: null };
  if (!s) return out;
  const ply = s.match(/(\d+)\s*-?\s*PR/i); if (ply) out.ply = Number(ply[1]);
  const code = s.match(/\b(YT-?\d+|B-?\d+)\b/i) || s.match(/\(([^)]*\d[^)]*)\)/); if (code) out.code = code[1].replace(/\s+/g, '');
  // radial: "<w> R <rim>" or "<w>/<aspect> R <rim>"
  let m = s.match(/(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s*R\s*(\d+(?:\.\d+)?)/i);
  if (m) { out.construction = 'radial'; out.width = Number(m[1]); if (m[2]) out.aspect = Number(m[2]); out.rim = Number(m[3]); return out; }
  // bias/diagonal: "<w>-<rim>" e.g. 2.75-17, 60/100-17
  m = s.match(/(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s*-\s*(\d+(?:\.\d+)?)/);
  if (m) { out.construction = 'bias'; out.width = Number(m[1]); if (m[2]) out.aspect = Number(m[2]); out.rim = Number(m[3]); return out; }
  return out;
}
// short, clean label for the cockpit
export function tyreLabel(raw) {
  const t = parseTyreSize(raw);
  return t.construction ? `${t.raw.replace(/\s*\([^)]*\)\s*/g, ' ').trim()}` : String(raw || '').trim();
}
