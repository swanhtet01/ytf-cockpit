// Google service-account auth + Drive download — pure Node (no npm deps).
// Reads the SA key from GOOGLE_SA_KEY (raw JSON) or GOOGLE_SA_KEY_FILE (path to the JSON).
// Used by pull-drive.mjs (local/cron) and api/refresh.js (Vercel) to fetch Drive files with
// no human in the loop. Scope is drive.readonly — the "Yangon Tyre" folder is shared (read) with
// the SA email (super-mega-dev-team@supermega-468612.iam.gserviceaccount.com).
import crypto from 'node:crypto';
import fs from 'node:fs';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function loadServiceAccount() {
  const raw = process.env.GOOGLE_SA_KEY
    || (process.env.GOOGLE_SA_KEY_FILE ? fs.readFileSync(process.env.GOOGLE_SA_KEY_FILE, 'utf8') : null);
  if (!raw) throw new Error('No service account: set GOOGLE_SA_KEY (JSON) or GOOGLE_SA_KEY_FILE (path).');
  const sa = JSON.parse(raw);
  if (sa.type !== 'service_account' || !sa.client_email || !sa.private_key) {
    throw new Error('GOOGLE_SA_KEY is not a valid service_account JSON.');
  }
  return sa;
}

// Sign a JWT and exchange it for a short-lived OAuth access token.
export async function getAccessToken(scope = 'https://www.googleapis.com/auth/drive.readonly', saArg) {
  const sa = saArg || loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(sa.private_key));
  const assertion = `${header}.${claim}.${sig}`;

  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.access_token;
}

// Download a Drive file's raw bytes (binary-safe) as a Buffer.
export async function downloadDriveFile(fileId, token) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive download ${fileId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// Export a Google-native file (Sheet/Doc) to a concrete format (e.g. an xlsx).
export async function exportDriveFile(fileId, mimeType, token) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive export ${fileId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// File metadata (name, modifiedTime, mimeType) — used to detect freshness + Google-native files.
// Includes shortcutDetails so callers can resolve Drive shortcuts to their real targets.
export async function fileMeta(fileId, token) {
  const fields = 'id,name,mimeType,modifiedTime,owners(emailAddress),shortcutDetails(targetId,targetMimeType)';
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive meta ${fileId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Search files with an arbitrary Drive query, newest-first, single page (capped).
// Used to pull only RECENT items from a huge folder (e.g. 16k Viber images) without listing it all.
export async function searchFiles(q, token, { pageSize = 100, orderBy = 'modifiedTime desc' } = {}) {
  const fields = 'files(id,name,mimeType,modifiedTime,size,owners(emailAddress))';
  const params = new URLSearchParams({
    q, fields, pageSize: String(pageSize), orderBy,
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, size: f.size, owner: f.owners?.[0]?.emailAddress || '' }));
}

// List the direct children of a folder (one page at a time, auto-paginated).
// Returns [{id,name,mimeType,modifiedTime,owner,shortcutTargetId,shortcutTargetMime}].
export async function listFolder(folderId, token) {
  const fields = 'nextPageToken,files(id,name,mimeType,modifiedTime,owners(emailAddress),shortcutDetails(targetId,targetMimeType))';
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields, pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive list ${folderId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    for (const f of j.files || []) {
      out.push({
        id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime,
        owner: f.owners?.[0]?.emailAddress || '',
        shortcutTargetId: f.shortcutDetails?.targetId || '',
        shortcutTargetMime: f.shortcutDetails?.targetMimeType || '',
      });
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}
