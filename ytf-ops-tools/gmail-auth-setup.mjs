#!/usr/bin/env node
// gmail-auth-setup.mjs — ONE-TIME SETUP to get a Gmail refresh token.
//
// Steps:
//  1. Go to https://console.cloud.google.com/apis/credentials
//  2. Create OAuth 2.0 Client ID → Desktop app type
//  3. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET below (or as env vars)
//  4. Run: node gmail-auth-setup.mjs
//  5. Open the printed URL in your browser and log in as swannyhtet@gmail.com
//  6. Copy the code from the redirect URL and paste it when prompted
//  7. Copy the printed GMAIL_REFRESH_TOKEN and add it as a GitHub secret:
//       gh secret set GMAIL_REFRESH_TOKEN
//       (paste the token, press Enter, then Ctrl+D)

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const REDIRECT_URI  = 'urn:ietf:wg:oauth:2.0:oob'; // manual copy flow

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars first.');
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id:     CLIENT_ID,
  redirect_uri:  REDIRECT_URI,
  response_type: 'code',
  scope:         SCOPE,
  access_type:   'offline',
  prompt:        'consent',
})}`;

console.log('\n=== Gmail OAuth Setup ===');
console.log('\n1. Open this URL in your browser:');
console.log('\n' + authUrl + '\n');
console.log('2. Log in as swannyhtet@gmail.com and approve access.');
console.log('3. Copy the authorization code shown.\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste the authorization code here: ', async (code) => {
  rl.close();
  code = code.trim();

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    }),
  });
  const j = await r.json();
  if (!j.refresh_token) {
    console.error('Error:', JSON.stringify(j, null, 2));
    process.exit(1);
  }

  console.log('\n=== SUCCESS ===');
  console.log('\nGMAIL_REFRESH_TOKEN =', j.refresh_token);
  console.log('\nNow run these commands to save it as a GitHub secret:');
  console.log('\n  gh secret set GMAIL_REFRESH_TOKEN');
  console.log('  (paste the token above, press Enter, then Ctrl+D)\n');
});
