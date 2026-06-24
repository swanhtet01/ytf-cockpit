// Connectors hub — load + query the source registry (connectors.json). One place that knows every
// data source for the tenant, so pullers/generators stop hardcoding sources. Pure Node, no deps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConnectors() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'connectors.json'), 'utf8')); }
  catch { return { tenant: 'ytf', connectors: [] }; }
}
export const allConnectors = () => loadConnectors().connectors || [];
export const byType = (type) => allConnectors().filter((c) => c.type === type);
// drive sources that are actually pullable by the service account (skip ones flagged unshared)
export const pullableDrive = () => byType('drive').filter((c) => c.fileId && c.cache && c.status !== 'unshared');
export const summarize = () => {
  const by = {};
  for (const c of allConnectors()) { by[c.type] = by[c.type] || { total: 0, live: 0 }; by[c.type].total++; if (c.status === 'live') by[c.type].live++; }
  return by;
};
