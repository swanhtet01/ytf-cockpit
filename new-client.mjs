#!/usr/bin/env node
// new-client.mjs — stand up a new white-label tenant of the SuperMega Ops cockpit in minutes.
// Writes a ready public/config.json (brand, accent, monogram, feed namespace, module toggles) and
// prints the exact deploy checklist. The cockpit shell is generic; a tenant = config + their data
// adapters + a deploy. This is what makes it a product, not a YTF one-off.
//
// Usage examples:
//   node new-client.mjs --name "Acme Tyres" --prefix acme --accent "#D97757"
//   node new-client.mjs --name "Shwe Foods" --prefix shwe --modules claims=false,quality_wcm=false
//   node new-client.mjs --name "Demo Co" --prefix demo --write   (actually overwrite public/config.json)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, t, i, arr) => {
  if (t.startsWith('--')) a.push([t.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return a;
}, []));

const ALL_MODULES = ['intelligence', 'trends', 'financials', 'production_mtd', 'production_fg', 'production_mc',
  'production', 'inventory', 'stock_balance', 'distribution', 'claims', 'procurement', 'raw_material',
  'parties', 'sites', 'quality_wcm', 'data_sources'];

const name = args.name || 'New Client';
const prefix = (args.prefix || name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || 'tenant').replace(/[^a-z0-9-]/g, '');
const accent = args.accent || '#D97757';
const monogram = (args.monogram || name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2)).toUpperCase();

// modules: default all on; --modules a=false,b=false turns specific ones off
const modules = Object.fromEntries(ALL_MODULES.map((m) => [m, true]));
if (args.modules && args.modules !== 'true') {
  for (const pair of args.modules.split(',')) { const [k, v] = pair.split('='); if (k in modules) modules[k] = v !== 'false'; }
}

const config = {
  _comment: `White-label config for ${name}. feed_prefix MUST match the server FEED_PREFIX env. Toggle modules off to hide a section/tile/search source.`,
  brand: name,
  instance: name,
  tagline: 'operations cockpit',
  accent,
  vertical: args.vertical || 'operations',
  footer: 'Powered by SuperMega',
  feed_prefix: prefix,
  monogram,
  search_placeholder: 'Search inventory, orders, claims, stock, actions…',
  search_chips: ['stock', 'reorder', 'order', 'claim', 'low', 'today'],
  modules,
};

const panelToken = `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
const target = args.write === 'true' ? path.join(DIR, 'public', 'config.json') : path.join(DIR, `config.${prefix}.json`);
fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n');

console.log(`\n✓ Wrote ${path.relative(DIR, target)} for "${name}" (feed_prefix=${prefix}, accent=${accent}, monogram=${monogram})`);
console.log('\nStand up this tenant (each client = own Vercel project + own gated feed + own passcode):');
console.log(`  1. Fork supermega-remote + ytf-ops-tools into the client's folder (or a new Vercel project "${prefix}-ops").`);
console.log(`  2. Use this config as public/config.json (re-run with --write to overwrite directly).`);
console.log(`  3. Point the generators at the client's data: drop their workbooks in ytf-ops-tools/data/drive-cache/`);
console.log(`     (or share their Drive folder with the service account + list fileIds in pull-drive.mjs / drive-manifest.json),`);
console.log(`     and write thin adapters for any client-specific formats. Drop modules they don't have via --modules.`);
console.log('  4. Set Vercel env:');
console.log(`       PANEL_TOKEN  = ${panelToken}   (the client's phone passcode — change as you like)`);
console.log(`       FEED_PREFIX  = ${prefix}        (MUST match config.feed_prefix)`);
console.log('       GOOGLE_SA_KEY = <service-account JSON, if using server-side Drive pull>');
console.log('  5. node pull-drive.mjs && node refresh.mjs && vercel deploy --prod   (or sync.ps1).');
console.log(`  6. Assign the domain:  vercel alias set <prod-url> ${prefix}.yourdomain  (add the DNS A record 76.76.21.21).`);
console.log('\nHand over: the cockpit URL + the passcode. Data stays private (token-gated) per tenant.\n');
