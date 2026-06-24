#!/usr/bin/env node
// pull-drive.mjs — fetch the canonical "Yangon Tyre" Drive workbooks via the service account
// into data/drive-cache/, with NO connector and NO human step. This is the front of the
// plug-and-play loop: `node pull-drive.mjs && node refresh.mjs`.
//
// Auth: set GOOGLE_SA_KEY (raw JSON) or GOOGLE_SA_KEY_FILE (path). The SA email must have at
// least read access to each file (share the "Yangon Tyre" folder with the SA).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken, downloadDriveFile, exportDriveFile, fileMeta } from './lib/google-sa.mjs';
import { pullableDrive } from './lib/connectors.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'data', 'drive-cache');
fs.mkdirSync(CACHE, { recursive: true });

// Drive sources come from the connectors hub (connectors.json), not hardcoded here.
const FILES = pullableDrive().map((c) => ({ role: c.id, id: c.fileId, cache: c.cache }));

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const main = async () => {
  const token = await getAccessToken();
  let ok = 0;
  for (const f of FILES) {
    try {
      const meta = await fileMeta(f.id, token);
      const isNative = String(meta.mimeType || '').startsWith('application/vnd.google-apps');
      const bytes = isNative ? await exportDriveFile(f.id, XLSX, token) : await downloadDriveFile(f.id, token);
      if (bytes.slice(0, 2).toString('hex') !== '504b') throw new Error('not a zip/xlsx (got ' + bytes.slice(0, 8).toString('hex') + ')');
      fs.writeFileSync(path.join(CACHE, f.cache), bytes);
      ok++;
      console.log(`  ✓ ${f.role.padEnd(20)} ${meta.modifiedTime?.slice(0, 10) || '?'}  ${(bytes.length / 1024).toFixed(0)}KB  -> ${f.cache}`);
    } catch (e) {
      console.error(`  ✗ ${f.role.padEnd(20)} ${e.message}`);
    }
  }
  console.log(`pull-drive — ${ok}/${FILES.length} files refreshed into data/drive-cache/`);
  if (ok === 0) process.exit(1);
};

main().catch((e) => { console.error('pull-drive failed:', e.message); process.exit(1); });
