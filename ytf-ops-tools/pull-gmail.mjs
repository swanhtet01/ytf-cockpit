#!/usr/bin/env node
// pull-gmail.mjs — fetch YTF Gmail threads using OAuth2 refresh token.
// Requires env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
// Output: data/threads.live.json  (same schema as threads.sample.json)
// Skips gracefully if any env var is missing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || '';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.warn('[pull-gmail] Missing OAuth env vars — skipping Gmail pull.');
  process.exit(0);
}

const QUERY = 'after:2026/01/01 -in:draft -category:promotions -category:social';
const MAX_THREADS = 200;

async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Gmail token refresh failed: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function listThreadIds(token) {
  const ids = [];
  let pageToken = '';
  while (ids.length < MAX_THREADS) {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/threads');
    url.searchParams.set('q', QUERY);
    url.searchParams.set('maxResults', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (j.error) throw new Error('threads.list: ' + JSON.stringify(j.error));
    (j.threads || []).forEach(t => ids.push(t.id));
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
  }
  return ids.slice(0, MAX_THREADS);
}

async function getThreadMeta(token, id) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const j = await r.json();
  if (j.error || !j.messages?.length) return null;
  const msg = j.messages[0];
  const hdrs = {};
  (msg.payload?.headers || []).forEach(h => { hdrs[h.name.toLowerCase()] = h.value; });
  return {
    id,
    date:     hdrs.date  ? new Date(hdrs.date).toISOString().slice(0, 10) : null,
    sender:   hdrs.from  || '',
    subject:  hdrs.subject || '',
    snippet:  msg.snippet || '',
  };
}

async function main() {
  console.log('[pull-gmail] Authenticating…');
  const token = await getAccessToken();

  console.log('[pull-gmail] Listing thread IDs…');
  const ids = await listThreadIds(token);
  console.log(`[pull-gmail] ${ids.length} threads found`);

  const threads = [];
  for (let i = 0; i < ids.length; i++) {
    if (i % 20 === 0) console.log(`[pull-gmail] Fetching ${i}/${ids.length}…`);
    const t = await getThreadMeta(token, ids[i]);
    if (t) threads.push(t);
    // rate limit: ~10 req/s safe
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 1000));
  }

  const outPath = path.join(DIR, 'data', 'threads.live.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(threads, null, 2));
  console.log(`[pull-gmail] Saved ${threads.length} threads → ${outPath}`);
}

main().catch(err => { console.error('[pull-gmail] ERROR:', err.message); process.exit(1); });
