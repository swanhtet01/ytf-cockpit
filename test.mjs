// Local smoke test for api/control.js — mocks the live app via global.fetch.
// Run: node test.mjs
import handler from './api/control.js';

process.env.PANEL_TOKEN = 'secret-pass';
process.env.CRON_TOKEN = 'cron-xyz';
process.env.LIVE_APP_BASE = 'https://live.example';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { (cond?pass++:fail++); console.log(`${cond?'  ok':'FAIL'}  ${name}${extra?'  ('+extra+')':''}`); };

// Minimal Node res mock
function mockRes() {
  return {
    statusCode: 200, _headers: {}, _body: '',
    setHeader(k, v){ this._headers[k.toLowerCase()] = v; },
    end(b){ this._body = b; this._done = true; },
    json(){ return JSON.parse(this._body); },
  };
}
function req(method, url, headers={}) { return { method, url, headers: { host: 'panel.example', ...headers } }; }

// Capture outbound calls + script the live app's responses
let calls = [];
global.fetch = async (url, init={}) => {
  calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
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
  if (u.includes('/api/cron/ytf/full-refresh')) {
    return new Response(JSON.stringify({ status: 'ok', refreshed: true }), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

async function call(r) { const res = mockRes(); await handler(r, res); return res; }

// 1. No/!wrong token -> 401
let res = await call(req('GET', '/api/control?action=status', { 'x-panel-token': 'WRONG' }));
ok('wrong token rejected', res.statusCode === 401);

// 2. Missing token -> 401
res = await call(req('GET', '/api/control?action=status'));
ok('missing token rejected', res.statusCode === 401);

// 3. status with good token -> normalized health
calls = [];
res = await call(req('GET', '/api/control?action=status', { 'x-panel-token': 'secret-pass' }));
let body = res.json();
ok('status 200', res.statusCode === 200);
ok('status reached live /api/health', calls[0]?.url === 'https://live.example/api/health');
ok('health normalized: db_ready', body.health?.db_ready === true);
ok('health normalized: coverage', body.health?.coverage_score === 87);
ok('status no-store header', res._headers['cache-control'] === 'no-store');

// 4. jobs list gated + returned
res = await call(req('GET', '/api/control?action=jobs', { 'x-panel-token': 'secret-pass' }));
body = res.json();
ok('jobs returns allowlist', Array.isArray(body.jobs) && body.jobs.some(j => j.name === 'full-refresh'));

// 5. run requires POST
res = await call(req('GET', '/api/control?action=run&job=full-refresh', { 'x-panel-token': 'secret-pass' }));
ok('run rejects GET', res.statusCode === 405);

// 6. run unknown job -> 400, never calls live
calls = [];
res = await call(req('POST', '/api/control?action=run&job=rm-rf', { 'x-panel-token': 'secret-pass' }));
ok('run rejects unknown job', res.statusCode === 400 && calls.length === 0);

// 7. run valid job -> posts with cron header, never leaks token to client
calls = [];
res = await call(req('POST', '/api/control?action=run&job=full-refresh', { 'x-panel-token': 'secret-pass' }));
body = res.json();
ok('run posts to live cron path', calls[0]?.url.includes('/api/cron/ytf/full-refresh') && calls[0]?.method === 'POST');
ok('run sends cron token header', calls[0]?.headers['x-supermega-cron-token'] === 'cron-xyz');
ok('run ok + result echoed', body.ok === true && body.result?.refreshed === true);
ok('cron token NOT in client response', !JSON.stringify(body).includes('cron-xyz'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
