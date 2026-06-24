// Local dev server: serves the panel + a working /api/control with a MOCKED live app,
// so the dashboard can be demoed without the protected production deployment.
// Not used in production (Vercel runs api/control.js as a function, public/ as static).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(DIR, 'public');
const PORT = Number(process.env.PORT || 4173);

// Demo config + mocked live app
process.env.PANEL_TOKEN = 'demo123';
process.env.CRON_TOKEN = 'mock-cron';
process.env.LIVE_APP_BASE = 'https://live.mock';

global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/api/health')) {
    return new Response(JSON.stringify({
      status: 'ready', service: 'supermega-service',
      enterprise_db_ready: true, enterprise_db_mode: 'primary_database',
      ytf_operational_backend_ready: true, ytf_operational_backend_mode: 'primary_database',
      ytf_operational_intake_status: 'ready', autopilot_status: 'idle',
      review_status: 'ok', coverage_score: 87, site_root_ready: true, pilot_data_ready: true,
    }), { status: 200 });
  }
  if (u.includes('/api/cron/')) {
    await new Promise(r => setTimeout(r, 600));
    return new Response(JSON.stringify({ status: 'ok', refreshed: true, job: u.split('/').pop() }), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

const { default: control } = await import('./api/control.js');

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.svg':'image/svg+xml',
  '.webmanifest':'application/manifest+json', '.json':'application/json' };

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/control')) return control(req, res);
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, p);
  if (!file.startsWith(PUB) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
}).listen(PORT, () => console.log(`dev server on http://localhost:${PORT}  (passcode: demo123)`));
