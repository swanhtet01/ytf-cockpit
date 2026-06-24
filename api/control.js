// SuperMega Remote — serverless control proxy
// Single Node function (Vercel auto-detects /api/*.js, no build step).
// Sits between your phone panel and the live supermega-ytf app.
// Holds the cron secret server-side; the panel never sees it.
//
// Env vars (set in Vercel project settings):
//   PANEL_TOKEN        required  passcode the phone panel must send (x-panel-token)
//   CRON_TOKEN         required  value of the live app's CRON_SECRET / SUPERMEGA_INTERNAL_CRON_TOKEN
//   LIVE_APP_BASE      optional  base URL of the live app (default below)
//   VERCEL_BYPASS      optional  Vercel "Protection Bypass for Automation" secret, if the live app is access-protected
//
// Actions (query param ?action=):
//   status            GET  live /api/health -> normalized status JSON         (panel-token gated)
//   run&job=<name>    POST live /api/cron/ytf/<name> with cron token          (panel-token gated)
//   jobs              GET  list of allowed job names                          (panel-token gated)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Blob helpers — gracefully no-op when not in a Vercel environment
const BLOB_NOTICES_PATH = 'ytf/notices.json';
async function blobPut(pathname, data) {
  try {
    const { put } = await import('@vercel/blob');
    return await put(pathname, JSON.stringify(data), { access: 'public', allowOverwrite: true, addRandomSuffix: false });
  } catch { return null; }
}
async function blobGet(pathname) {
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: pathname });
    const b = blobs.find(x => x.pathname === pathname);
    if (!b) return null;
    const r = await fetch(b.url);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const DEFAULT_LIVE_BASE = 'https://supermega-ytf-swanhtet01s-projects.vercel.app';
// PRIVATE data feed — bundled into this function via vercel.json includeFiles, served only after the panel-token check
const FEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'feed');
// Feed namespace is config-driven so the template serves any tenant: FEED_PREFIX env (default 'ytf')
// must match config.json "feed_prefix". Allowlist = prefix × fixed suffixes (no arbitrary file reads).
const FEED_PREFIX = (process.env.FEED_PREFIX || 'ytf').replace(/[^a-z0-9-]/gi, '');
const DATA_SUFFIXES = ['dashboard', 'ops', 'sources', 'claims', 'procurement', 'raw-material'];
const DATA_FILES = DATA_SUFFIXES.map((s) => `${FEED_PREFIX}-${s}`);

// Only these pipeline jobs can be triggered remotely. Maps a short name -> live path.
const JOBS = {
  'full-refresh':         '/api/cron/ytf/full-refresh',
  'source-records':       '/api/cron/ytf/source-records',
  'workbook-extraction':  '/api/cron/ytf/workbook-extraction',
  'workbook-values':      '/api/cron/ytf/workbook-values',
  'communications-sync':  '/api/cron/ytf/communications-sync',
  'source-behavior-map':  '/api/cron/ytf/source-behavior-map',
  'operational-intake':   '/api/cron/ytf/operational-intake',
  'operating-metrics':    '/api/cron/ytf/operating-metrics',
  'owner-brief':          '/api/cron/ytf/owner-brief',
  'evaluation':           '/api/cron/ytf/evaluation',
  'knowledge-vector':     '/api/cron/ytf/knowledge-vector',
  'agent-queue':          '/api/cron/ytf/agent-queue',
  'supermega-daily':      '/api/cron/supermega/daily',
  'supermega-agent-queue':'/api/cron/supermega/agent-queue',
};

// Friendly labels + grouping for the UI.
export const JOB_META = {
  'full-refresh':         { label: 'Full Refresh', group: 'pipeline', primary: true },
  'source-records':       { label: 'Source Records', group: 'pipeline' },
  'workbook-extraction':  { label: 'Workbook Extraction', group: 'pipeline' },
  'workbook-values':      { label: 'Workbook Values', group: 'pipeline' },
  'communications-sync':  { label: 'Comms Sync', group: 'pipeline' },
  'source-behavior-map':  { label: 'Source Behavior Map', group: 'pipeline' },
  'operational-intake':   { label: 'Operational Intake', group: 'pipeline' },
  'operating-metrics':    { label: 'Operating Metrics', group: 'pipeline' },
  'owner-brief':          { label: 'Owner Brief', group: 'insight' },
  'evaluation':           { label: 'Evaluation', group: 'insight' },
  'knowledge-vector':     { label: 'Knowledge Vector', group: 'insight' },
  'agent-queue':          { label: 'YTF Agent Queue', group: 'agents' },
  'supermega-daily':      { label: 'SuperMega Daily', group: 'agents' },
  'supermega-agent-queue':{ label: 'SuperMega Agent Queue', group: 'agents' },
};

// ---------- roles + access model ----------
// PANEL_USERS (env, JSON): { "ceo": {"token":"…","groups":["*"]}, "manager": {"token":"…","groups":["plant-a"]}, … }
// Fallback: PANEL_TOKEN -> a single "ceo" user with all access. Roles gate (a) which jobs they can run,
// (b) whether they see EMAIL-derived data (CEO only), and (c) which Viber groups' data they see.
const EMAIL_SUFFIXES = ['claims', 'procurement', 'raw-material'];           // sourced from Gmail -> CEO only
const EMAIL_FILES = EMAIL_SUFFIXES.map((s) => `${FEED_PREFIX}-${s}`);
const EMAIL_OPS_KEYS = ['claims', 'procurement', 'raw_material'];           // keys inside <prefix>-ops.json
const EMAIL_HEADLINE_KEYS = ['claims_processed', 'claims_approval_pct', 'procurement_threads', 'procurement_latest', 'raw_material_shipments'];
const ROLE_CAP = {
  // YTF's actual roles (2026-06-23):
  admin:         { jobs: ['pipeline', 'insight', 'agents'], email: false }, // me/IT — full system, NO email by rule (CEO-only)
  ceo:           { jobs: ['pipeline', 'insight', 'agents'], email: true  }, // owner — only role that sees Gmail-sourced data
  manager:       { jobs: ['pipeline', 'insight'],           email: false }, // head-office / general manager
  plant_manager: { jobs: ['pipeline'],                      email: false }, // per-plant; scope via Viber/site groups
};
const capFor = (role) => ROLE_CAP[role] || ROLE_CAP.plant_manager;          // unknown role → most restricted

function loadUsers() {
  const out = {};
  try {
    const j = JSON.parse(process.env.PANEL_USERS || '{}');
    for (const [role, v] of Object.entries(j)) if (v && v.token) out[role] = { token: String(v.token), groups: Array.isArray(v.groups) ? v.groups : ['*'] };
  } catch { /* ignore malformed */ }
  if (process.env.PANEL_TOKEN && !out.ceo) out.ceo = { token: process.env.PANEL_TOKEN, groups: ['*'] };
  return out;
}
function resolveRole(provided) {
  let match = null;
  for (const [role, v] of Object.entries(loadUsers())) if (timingSafeEqual(provided, v.token)) match = { role, groups: v.groups }; // iterate all (constant-time-ish)
  return match;
}
// Redact a feed payload for a non-CEO role. DENY-BY-DEFAULT: rather than chasing the drifting feed
// shape with deletes, we keep an explicit whitelist of non-email fields. Anything we don't recognize is
// dropped (so adding an email-derived field can never accidentally leak — fixes the contacts /
// summary.procurement / categories class of bugs found in the 2026-06-23 audit).
// Anti-CEO-leakage: Email-derived fields (Gmail-sourced) NEVER reach non-CEO.
const OPS_PUBLIC_KEYS = [
  'generated_at', 'window', 'as_of', 'alerts',            // headers
  'production', 'production_fg', 'production_mc',          // production (xlsx-derived)
  'daily_production', 'inventory', 'stock_balance',        // factory state (xlsx-derived)
  'retailers', 'sites', 'finance', 'trends',               // business + macro
  'drive_sources', 'quality', 'insights', 'captures',      // sources / OEE / signals (text-redacted below) / whiteboard
  'orders',                                                // Galaxy iStock orders + receivables (not Gmail-derived)
  'copq',                                                  // Cost of Poor Quality (scrap+claims+downtime — no email data)
  'viber',                                                 // viber payload — group-scoped below
];
const SUMMARY_PUBLIC_KEYS = ['window', 'threads_total', 'as_of_label'];   // anything email-derived (claims/procurement/contacts/categories) is dropped
const DASH_HEADLINE_PUBLIC_KEYS = [                       // ytf-dashboard.json `headline` — non-email tiles only
  'tyres_produced', 'grade_a_pct', 'off_grade_pct', 'stock_materials', 'low_stock_items',
  'reorder_flags', 'materials_in_transit', 'materials_in_transit_mt', 'production_reports',
  'window_days', 'sources_tracked', 'sources_live', 'dealers', 'retailer_regions',
  'distribution_sales_b', 'top_region', 'revenue_b', 'net_profit_b', 'net_margin_pct', 'cash_b',
  'mtd_produced', 'mtd_attainment_pct', 'mtd_as_of', 'critical_signals', 'high_signals',
  'production_momentum_pct', 'sales_mom_pct',
];
const EMAIL_TEXT_RE = /\bclaim|warrant|procurement|tft\(|tft\)|kiic|junky|ygn-?[rbt]/i;

function pickKeys(obj, keys) {
  const out = {};
  if (obj && typeof obj === 'object') for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
// scrub email-text references from any free-text array (alerts, insights signal titles/details)
function scrubEmailText(arr) { return Array.isArray(arr) ? arr.filter((a) => !EMAIL_TEXT_RE.test(String(a && a.title ? a.title + ' ' + (a.detail || '') : a))) : arr; }

function redactForRole(file, json, who) {
  const cap = capFor(who.role);
  const groups = who.groups || [];
  const fullAccess = cap.email && groups.includes('*');
  if (fullAccess) return json;

  // Viber group scoping — applies to every role (CEO with explicit groups is also scoped)
  if (json && json.viber && !groups.includes('*')) {
    const g = new Set(groups);
    if (Array.isArray(json.viber.records)) {
      json.viber.records = json.viber.records.filter((r) => !r.group || g.has(r.group));
      json.viber.count = json.viber.records.length;
    }
  }

  if (cap.email) return json;   // CEO with limited groups: keep email, just viber-scoped

  // --- non-CEO: rebuild ops payload from the whitelist, scrubbed ---
  if (file === `${FEED_PREFIX}-ops`) {
    const clean = pickKeys(json, OPS_PUBLIC_KEYS);
    if (json.summary) clean.summary = pickKeys(json.summary, SUMMARY_PUBLIC_KEYS);
    clean.alerts = scrubEmailText(json.alerts);
    if (clean.insights && Array.isArray(clean.insights.signals)) {
      clean.insights = { ...clean.insights, signals: scrubEmailText(clean.insights.signals) };
    }
    return clean;
  }
  if (file === `${FEED_PREFIX}-dashboard`) {
    const clean = pickKeys(json, ['generated_at', 'window', 'as_of', 'viber']);
    if (json.headline) clean.headline = pickKeys(json.headline, DASH_HEADLINE_PUBLIC_KEYS);
    clean.alerts = scrubEmailText(json.alerts);
    return clean;
  }
  return json;
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function liveBase() {
  return String(process.env.LIVE_APP_BASE || DEFAULT_LIVE_BASE).replace(/\/+$/, '');
}

// Append the Vercel protection-bypass query if configured, so the proxy can reach
// an access-protected live deployment.
function withBypass(url) {
  const secret = process.env.VERCEL_BYPASS;
  if (!secret) return url;
  const u = new URL(url);
  u.searchParams.set('x-vercel-protection-bypass', secret);
  u.searchParams.set('x-vercel-set-bypass-cookie', 'true');
  return u.toString();
}

function bypassHeaders() {
  const secret = process.env.VERCEL_BYPASS;
  return secret ? { 'x-vercel-protection-bypass': secret } : {};
}

async function fetchJson(url, init = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { body = { raw: text.slice(0, 2000) }; }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

// Reduce the live /api/health payload to the few fields the panel shows.
function normalizeStatus(h) {
  if (!h || typeof h !== 'object') return { reachable: false };
  return {
    reachable: true,
    status: h.status ?? 'unknown',
    service: h.service ?? '',
    db_ready: !!h.enterprise_db_ready,
    db_mode: h.enterprise_db_mode ?? 'unknown',
    db_write_blocked: !!h.enterprise_db_write_blocked,
    db_next_step: h.enterprise_db_next_step ?? '',
    backend_ready: !!h.ytf_operational_backend_ready,
    backend_mode: h.ytf_operational_backend_mode ?? 'unknown',
    intake_status: h.ytf_operational_intake_status ?? 'unknown',
    intake_storage: h.ytf_operational_intake_storage_status ?? 'unknown',
    autopilot: h.autopilot_status ?? 'unknown',
    review: h.review_status ?? 'unknown',
    coverage_score: Number(h.coverage_score ?? 0),
    site_ready: !!h.site_root_ready,
    pilot_ready: !!h.pilot_data_ready,
  };
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const action = (url.searchParams.get('action') || 'status').toLowerCase();

  // --- auth: every action requires a panel token; the token resolves to a ROLE ---
  if (!process.env.PANEL_USERS && !process.env.PANEL_TOKEN) return send(res, 503, { error: 'No PANEL_USERS / PANEL_TOKEN configured on the server.' });
  // header-only: never accept the token via query string (it leaks into access logs / Referer).
  const provided = req.headers['x-panel-token'] || '';
  const who = resolveRole(provided);
  if (!who) return send(res, 401, { error: 'Invalid panel token.' });
  const cap = capFor(who.role);

  try {
    if (action === 'whoami') {
      return send(res, 200, { role: who.role, groups: who.groups, email_access: cap.email, job_groups: cap.jobs });
    }

    if (action === 'data') {
      // token-gated structured data; non-CEO roles cannot read Gmail-derived ledgers + get email fields redacted
      const file = String(url.searchParams.get('file') || '').replace(/[^a-z0-9-]/gi, '');
      if (!DATA_FILES.includes(file)) return send(res, 400, { error: `Unknown data file "${file}".`, allowed: DATA_FILES });
      if (EMAIL_FILES.includes(file) && !cap.email) return send(res, 403, { error: 'Email-sourced data is restricted to the CEO role.' });
      try {
        const json = JSON.parse(fs.readFileSync(path.join(FEED, `${file}.json`), 'utf8'));
        return send(res, 200, redactForRole(file, json, who));
      } catch {
        return send(res, 404, { error: `No data for "${file}" yet — run node refresh.mjs.` });
      }
    }

    if (action === 'jobs') {
      // only show jobs whose group this role may trigger
      const jobs = Object.keys(JOBS)
        .map((name) => ({ name, ...(JOB_META[name] || { label: name, group: 'other' }) }))
        .filter((j) => cap.jobs.includes(j.group));
      return send(res, 200, { jobs, role: who.role });
    }

    if (action === 'status') {
      const r = await fetchJson(withBypass(`${liveBase()}/api/health`), { headers: bypassHeaders() });
      const out = {
        ok: r.ok,
        http_status: r.status,
        live_base: liveBase(),
        checked_at: new Date().toISOString(),
        health: normalizeStatus(r.ok ? r.body : null),
      };
      if (!r.ok) out.detail = r.body?.detail || r.body?.error || `Live app returned ${r.status}`;
      return send(res, 200, out);
    }

    if (action === 'run') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST to run a job.' });
      const job = (url.searchParams.get('job') || '').toLowerCase();
      const path = JOBS[job];
      if (!path) return send(res, 400, { error: `Unknown job "${job}".`, allowed: Object.keys(JOBS) });
      const jobGroup = (JOB_META[job] || {}).group || 'other';
      if (!cap.jobs.includes(jobGroup)) return send(res, 403, { error: `Role "${who.role}" cannot trigger ${jobGroup} jobs.` });

      const cronToken = process.env.CRON_TOKEN;
      if (!cronToken) return send(res, 503, { error: 'CRON_TOKEN not configured on the server.' });

      const started = Date.now();
      const r = await fetchJson(withBypass(`${liveBase()}${path}`), {
        method: 'POST',
        headers: {
          'x-supermega-cron-token': cronToken,
          'content-type': 'application/json',
          ...bypassHeaders(),
        },
        body: '{}',
      }, 55000);

      return send(res, 200, {
        ok: r.ok,
        http_status: r.status,
        job,
        path,
        took_ms: Date.now() - started,
        finished_at: new Date().toISOString(),
        result: r.body,
      });
    }

    // ── notices: shared team notice board (role-gated read + write) ─────────────────
    if (action === 'notices') {
      const NOTICES_FILE = path.join(FEED, `${FEED_PREFIX}-notices.json`);

      if (req.method === 'GET') {
        // Read from Blob first, fall back to local file
        let notices = await blobGet(BLOB_NOTICES_PATH);
        if (!notices) {
          try { notices = JSON.parse(fs.readFileSync(NOTICES_FILE, 'utf8')); } catch { notices = []; }
        }
        const groups = who.groups || [];
        const visible = groups.includes('*')
          ? notices
          : notices.filter((n) => !n.group || groups.includes(n.group));
        return send(res, 200, { notices: visible.slice(0, 100), role: who.role, groups });
      }

      if (req.method === 'POST') {
        const chunks = [];
        await new Promise((resolve) => { req.on('data', (c) => chunks.push(c)); req.on('end', resolve); });
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }

        const { text, group, type } = body;
        if (!text || String(text).trim().length < 2) return send(res, 400, { error: 'Notice text is required.' });
        const groups = who.groups || [];
        const targetGroup = String(group || 'head-office');
        if (!groups.includes('*') && !groups.includes(targetGroup)) return send(res, 403, { error: `Your role cannot post to group "${targetGroup}".` });

        // Read current notices from Blob or local
        let notices = await blobGet(BLOB_NOTICES_PATH);
        if (!notices) {
          try { notices = JSON.parse(fs.readFileSync(NOTICES_FILE, 'utf8')); } catch { notices = []; }
        }
        const notice = {
          id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text: String(text).trim().slice(0, 1000),
          type: ['announcement', 'handover', 'urgent', 'general'].includes(type) ? type : 'general',
          group: targetGroup,
          role: who.role,
          posted_at: new Date().toISOString(),
          pinned: false,
        };
        notices.unshift(notice);
        notices = notices.slice(0, 200);

        // Write to Blob (durable) or fall back to local file
        const saved = await blobPut(BLOB_NOTICES_PATH, notices);
        if (saved) return send(res, 200, { ok: true, notice, stored: 'blob' });
        try {
          fs.writeFileSync(NOTICES_FILE, JSON.stringify(notices, null, 2) + '\n');
          return send(res, 200, { ok: true, notice, stored: 'local' });
        } catch {
          return send(res, 200, { ok: false, notice, download: true });
        }
      }

      return send(res, 405, { error: 'Use GET to list or POST to add a notice.' });
    }

    // ── entry: persist a capture from entry.html to Blob ────────────────────────────
    if (action === 'entry' && req.method === 'POST') {
      const chunks = [];
      await new Promise((resolve) => { req.on('data', (c) => chunks.push(c)); req.on('end', resolve); });
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'Invalid JSON body.' }); }
      if (!body.kind || !body.machine) return send(res, 400, { error: 'Entry must have kind and machine.' });

      const ENTRY_PATH = `ytf/entries/${Date.now()}-${Math.random().toString(36).slice(2,7)}.json`;
      const entry = { ...body, submitted_by: who.role, submitted_at: new Date().toISOString() };
      const saved = await blobPut(ENTRY_PATH, entry);
      if (saved) return send(res, 200, { ok: true, stored: 'blob', path: ENTRY_PATH });
      // Blob not available — return for local download
      return send(res, 200, { ok: false, download: true, entry });
    }

    return send(res, 400, { error: `Unknown action "${action}".`, allowed: ['status', 'run', 'jobs', 'data', 'whoami', 'notices', 'entry'] });
  } catch (err) {
    console.error('control proxy error:', err && err.stack || err);  // detail stays server-side only
    return send(res, 502, { error: 'Proxy error — the live app could not be reached.' });
  }
}
