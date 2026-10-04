// Player feedback API on the leaderboard Worker. Players POST from the game's FEEDBACK form;
// the private inbox page (feedback/, at https://feedback.riftborn.us) lists, triages and exports it
// with a bearer admin key.
// No IP address is ever stored: CF-Connecting-IP only becomes a rate-limit key, as a keyed hash
// (ipLimitKey) wherever the Worker has its signing key.
import { ipLimitKey } from './accounts-api.js';

export const CATEGORIES = ['bug', 'balance', 'idea', 'other'];
export const STATUSES = ['new', 'read', 'archived'];
export const SOURCES = ['live', 'dev', 'unknown'];
export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 1500;
export const CONTACT_MAX = 120;
export const BODY_MAX = 8192;
// Settings the game summarises into context.settings; anything else is dropped.
export const SETTINGS_KEYS = ['nightmare', 'pixelation', 'lighting', 'fog', 'fpsCap', 'crt', 'radar', 'muted', 'aimAssist',
  'autoFire', 'fireMode', 'palette', 'flashes', 'shake', 'gameSpeed', 'uiScale'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = 'GET, POST, PATCH, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization';

function corsHeaders(origin) {
  return origin ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Expose-Headers': 'Content-Disposition'
  } : {};
}

const json = (value, status = 200, origin = null, extra = {}) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
    ...corsHeaders(origin),
    ...extra
  }
});

// Same origin rule as server/scores-api.js (kept separate so the score route stays untouched).
// These origins (the games) submit feedback; they have always been able to reach the admin routes
// too, which still need the admin key.
function originAllowed(origin, env) {
  if (!origin) return true;
  const defaults = 'https://riftborn.chanmanc10.chatgpt.site' +
    (env.ENVIRONMENT === 'production' ? '' : ',http://127.0.0.1:4173,http://localhost:4173');
  return `${defaults},${env.ALLOWED_ORIGINS || ''}`
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .includes(origin);
}

// Admin-only origins (FEEDBACK_ADMIN_ORIGINS, from site.hosts.mjs: the inbox at feedback.riftborn.us
// and its old github.io copy). An origin listed there but not allowed above (feedback.riftborn.us)
// may use the admin routes only (list, CSV, status changes: the same key check and admin rate limit
// as everyone), never submit player feedback: its POST gets 403 before the rate limiter, the body or
// the database, and its preflight offers only that route's admin method. Scores and accounts never
// read this list, so they refuse it like any unknown origin.
function adminOnlyOrigin(origin, env) {
  return Boolean(origin) && String(env.FEEDBACK_ADMIN_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .includes(origin);
}

// ---- validation -----------------------------------------------------------------------------

// Control characters out (tabs/newlines kept only where asked), CRLF folded, trimmed.
function cleanText(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/\r\n?/g, '\n');
  text = multiline
    ? text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    : text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  text = text.trim();
  return text.length > max ? text.slice(0, max) : text;
}

const shortText = (value, max) => {
  const text = cleanText(value, max);
  return text ? text : null;
};
const int = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : null);
const bool = value => (typeof value === 'boolean' ? value : null);

function cleanSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of SETTINGS_KEYS) {
    const value = raw[key];
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000) out[key] = Math.round(value * 100) / 100;
    else if (typeof value === 'string' && value.length) out[key] = cleanText(value, 24);
  }
  return Object.keys(out).length ? out : null;
}

function cleanLastRun(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {
    outcome: ['victory', 'defeat', 'quit', 'ended'].includes(raw.outcome) ? raw.outcome : null,
    // Run position (2.4: KEEPERS and Death Mode runs have 6 stages, ORIGINAL 5).
    stage: int(raw.stage, 1, 6),
    score: int(raw.score, 0, 1000000000),
    kills: int(raw.kills, 0, 10000000),
    seconds: int(raw.seconds, 0, 86400),
    ruleset: ['keepers', 'original'].includes(raw.ruleset) ? raw.ruleset : null,
    death: bool(raw.death),
    practice: bool(raw.practice),
    build: shortText(raw.build, 200),
    cause: shortText(raw.cause, 60)
  };
  for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
  return Object.keys(out).length ? out : null;
}

// Context is informational: bad fields are dropped rather than rejecting the player's message.
export function cleanContext(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fps = typeof c.avgFps === 'number' && Number.isFinite(c.avgFps) && c.avgFps >= 0 && c.avgFps <= 1000
    ? Math.round(c.avgFps * 10) / 10 : null;
  const out = {
    build: shortText(c.build, 40),
    ruleset: ['keepers', 'original'].includes(c.ruleset) ? c.ruleset : null,
    source: SOURCES.includes(c.source) && c.source !== 'unknown' ? c.source : null,
    from: ['title', 'results'].includes(c.from) ? c.from : null,
    browser: shortText(c.browser, 60),
    os: shortText(c.os, 40),
    screen: shortText(c.screen, 24),
    touch: bool(c.touch),
    device: ['mouse', 'pad', 'touch'].includes(c.device) ? c.device : null,
    avgFps: fps,
    settings: cleanSettings(c.settings),
    lastRun: cleanLastRun(c.lastRun)
  };
  for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
  return out;
}

/** Validate a submission. Returns { error } or { value } with only known, capped fields. */
export function validateFeedback(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: 'Invalid feedback' };
  if (!CATEGORIES.includes(p.category)) return { error: 'Invalid category' };
  let rating = null;
  if (p.rating !== undefined && p.rating !== null) {
    rating = int(p.rating, 1, 5);
    if (rating === null) return { error: 'Invalid rating' };
  }
  if (typeof p.message !== 'string') return { error: 'Message required' };
  const message = cleanText(p.message, Infinity, { multiline: true });
  if (message.length < MESSAGE_MIN || message.length > MESSAGE_MAX) {
    return { error: `Message must be ${MESSAGE_MIN}-${MESSAGE_MAX} characters` };
  }
  let contact = null;
  if (p.contact !== undefined && p.contact !== null) {
    if (typeof p.contact !== 'string') return { error: 'Invalid contact' };
    contact = cleanText(p.contact, Infinity);
    if (contact.length > CONTACT_MAX) return { error: `Contact must be at most ${CONTACT_MAX} characters` };
    contact ||= null;
  }
  const id = typeof p.id === 'string' && UUID.test(p.id) ? p.id.toLowerCase() : null;
  return { value: { id, category: p.category, rating, message, contact, context: cleanContext(p.context) } };
}

// ---- admin auth -----------------------------------------------------------------------------

// Constant-time: compare SHA-256 digests byte by byte, so neither content nor length leaks.
async function sameSecret(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected))
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Every admin request (list, CSV, status change), right or wrong key, first takes a slot in the
// per-IP limiter shared with the accounts API (ACCOUNTS_RATE_LIMITER, 30 a minute, under its own
// key), so the admin key cannot be guessed at speed. Checked before the key: counting only failures
// would never slow down a guess that is right.
export const ADMIN_LIMIT = Object.freeze({ scope: 'feedback-admin', retryAfter: 60 });
async function limitAdmin(request, env, origin) {
  const limiter = env.ACCOUNTS_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = (await ipLimitKey(request, env, ADMIN_LIMIT.scope)) || `${ADMIN_LIMIT.scope}:${ip}`;
  const { success } = await limiter.limit({ key });
  return success ? null : json({ error: 'Too many requests. Wait a minute and try again.' }, 429, origin, { 'Retry-After': String(ADMIN_LIMIT.retryAfter) });
}

async function authorize(request, env, origin) {
  if (!env.FEEDBACK_ADMIN_KEY) return json({ error: 'Feedback admin key not configured' }, 503, origin);
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  if (!match || !(await sameSecret(match[1].trim(), String(env.FEEDBACK_ADMIN_KEY)))) {
    return json({ error: 'Unauthorized' }, 401, origin, { 'WWW-Authenticate': 'Bearer' });
  }
  return null;
}

// ---- schema ---------------------------------------------------------------------------------

// The table bootstraps itself on the first feedback request, so the feature never depends on the
// D1 migrations workflow (drizzle/0004_feedback.sql is the same schema, also IF NOT EXISTS).
// Every statement is IF NOT EXISTS: it can only ever add the feedback table, never alter scores.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    category TEXT NOT NULL,
    rating INTEGER,
    message TEXT NOT NULL,
    contact TEXT,
    context_json TEXT,
    source TEXT NOT NULL,
    build TEXT,
    status TEXT DEFAULT 'new' NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at, id)',
  'CREATE INDEX IF NOT EXISTS idx_feedback_status_created ON feedback (status, created_at)'
];
const ready = new WeakMap(); // DB binding -> Promise, once per isolate

export function ensureFeedbackTable(db) {
  let promise = ready.get(db);
  if (!promise) {
    promise = (async () => { for (const sql of SCHEMA) await db.prepare(sql).run(); })();
    ready.set(db, promise);
    promise.catch(() => ready.delete(db)); // a failed bootstrap retries on the next request
  }
  return promise;
}

// ---- queries --------------------------------------------------------------------------------

function parseFilters(params, maxLimit) {
  const f = { clauses: [], values: [] };
  const status = params.get('status') || 'all';
  if (status === 'active') f.clauses.push("status != 'archived'"); // the inbox view: new + read
  else if (status !== 'all') {
    if (!STATUSES.includes(status)) return { error: 'Invalid status filter' };
    f.clauses.push('status = ?'); f.values.push(status);
  }
  const category = params.get('category') || 'all';
  if (category !== 'all') {
    if (!CATEGORIES.includes(category)) return { error: 'Invalid category filter' };
    f.clauses.push('category = ?'); f.values.push(category);
  }
  const source = params.get('source') || 'all';
  if (source !== 'all') {
    if (!SOURCES.includes(source)) return { error: 'Invalid source filter' };
    f.clauses.push('source = ?'); f.values.push(source);
  }
  const rating = params.get('rating') || 'all';
  if (rating === 'none') f.clauses.push('rating IS NULL');
  else if (rating !== 'all') {
    if (!/^[1-5]$/.test(rating)) return { error: 'Invalid rating filter' };
    f.clauses.push('rating = ?'); f.values.push(Number(rating));
  }
  const since = params.get('since');
  if (since) {
    const ms = /^\d{1,15}$/.test(since) ? Number(since) : Date.parse(since);
    if (!Number.isFinite(ms)) return { error: 'Invalid since filter' };
    f.clauses.push('created_at >= ?'); f.values.push(ms);
  }
  const cursor = params.get('cursor');
  if (cursor) {
    const m = /^(\d{1,15})_([0-9a-f-]{36})$/i.exec(cursor);
    if (!m) return { error: 'Invalid cursor' };
    f.clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
    f.values.push(Number(m[1]), Number(m[1]), m[2].toLowerCase());
  }
  const limitText = params.get('limit');
  const limit = limitText == null ? Math.min(50, maxLimit) : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) return { error: `Limit must be 1-${maxLimit}` };
  f.limit = limit;
  f.where = f.clauses.length ? ' WHERE ' + f.clauses.join(' AND ') : '';
  return f;
}

const COLUMNS = 'id,created_at,category,rating,message,contact,context_json,source,build,status';

function rowOut(row) {
  let context = null;
  try { context = row.context_json ? JSON.parse(row.context_json) : null; } catch { context = null; }
  const { context_json: _drop, ...rest } = row;
  return { ...rest, context };
}

async function listFeedback(db, params, origin) {
  const f = parseFilters(params, 200);
  if (f.error) return json({ error: f.error }, 400, origin);
  const result = await db.prepare(`SELECT ${COLUMNS} FROM feedback${f.where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...f.values, f.limit + 1).all();
  const rows = result.results || [];
  const more = rows.length > f.limit;
  const items = rows.slice(0, f.limit).map(rowOut);
  const last = items[items.length - 1];
  const countRows = (await db.prepare('SELECT status, COUNT(*) AS n FROM feedback GROUP BY status').all()).results || [];
  const counts = { new: 0, read: 0, archived: 0, total: 0 };
  for (const row of countRows) {
    if (row.status in counts) counts[row.status] = Number(row.n) || 0;
    counts.total += Number(row.n) || 0;
  }
  return json({ items, nextCursor: more && last ? `${last.created_at}_${last.id}` : null, counts }, 200, origin);
}

// Spreadsheet-safe CSV: quoted cells, and a leading ' on anything a spreadsheet would run as a formula.
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportCsv(db, params, origin) {
  const f = parseFilters(params, 10000);
  if (f.error) return json({ error: f.error }, 400, origin);
  if (!params.get('limit')) f.limit = 10000;
  const result = await db.prepare(`SELECT ${COLUMNS} FROM feedback${f.where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...f.values, f.limit).all();
  const header = ['id', 'created_at', 'status', 'category', 'rating', 'source', 'build', 'message', 'contact', 'context_json'];
  const lines = [header.join(',')];
  for (const row of result.results || []) {
    lines.push([row.id, new Date(row.created_at).toISOString(), row.status, row.category, row.rating, row.source, row.build,
      row.message, row.contact, row.context_json].map(csvCell).join(','));
  }
  const day = new Date().toISOString().slice(0, 10);
  return new Response('﻿' + lines.join('\r\n') + '\r\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="riftborn-feedback-${day}.csv"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin',
      ...corsHeaders(origin)
    }
  });
}

async function readJson(request, origin) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return { response: json({ error: 'JSON required' }, 415, origin) };
  if (Number(request.headers.get('Content-Length') || 0) > BODY_MAX) return { response: json({ error: 'Request too large' }, 413, origin) };
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > BODY_MAX) return { response: json({ error: 'Request too large' }, 413, origin) };
  try {
    return { value: JSON.parse(new TextDecoder().decode(buffer)) };
  } catch {
    return { response: json({ error: 'Invalid JSON' }, 400, origin) };
  }
}

// Optional Discord ping; never blocks or fails the submission. allowed_mentions stops player
// text from pinging @everyone or roles. It carries the category, rating, source and the first 300
// characters of the message, never the contact line or the technical context: the privacy page
// (privacy/index.html, "Feedback messages") says exactly this, so change both together.
function notifyDiscord(env, ctx, entry) {
  const hook = env.DISCORD_WEBHOOK_URL;
  if (!hook || !/^https:\/\//i.test(hook)) return;
  const stars = entry.rating ? ' · ' + '★'.repeat(entry.rating) + '☆'.repeat(5 - entry.rating) : '';
  const text = entry.message.length > 300 ? entry.message.slice(0, 300) + '…' : entry.message;
  const content = `**Riftborn feedback** · ${entry.category.toUpperCase()}${stars} · ${entry.source}\n>>> ${text}`;
  const send = fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
  }).catch(() => {});
  try { ctx?.waitUntil?.(send); } catch {}
}

async function submitFeedback(request, env, ctx, db, origin) {
  if (env.FEEDBACK_RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limit = await env.FEEDBACK_RATE_LIMITER.limit({ key: (await ipLimitKey(request, env, 'feedback')) || ip });
    if (!limit.success) return json({ error: 'Too much feedback at once. Try again in a minute.' }, 429, origin);
  }
  const body = await readJson(request, origin);
  if (body.response) return body.response;
  const p = body.value;
  // Honeypot: a field people never see. Bots that fill it get a normal-looking success.
  if (p && typeof p === 'object' && typeof p.website === 'string' && p.website.trim()) {
    return json({ saved: true, id: crypto.randomUUID() }, 201, origin);
  }
  const checked = validateFeedback(p);
  if (checked.error) return json({ error: checked.error }, 400, origin);
  const v = checked.value;
  const entry = {
    id: v.id || crypto.randomUUID(),
    created_at: Date.now(),
    category: v.category,
    rating: v.rating,
    message: v.message,
    contact: v.contact,
    context_json: JSON.stringify(v.context),
    source: v.context.source || 'unknown',
    build: v.context.build || null
  };
  // A client-made id makes outbox retries idempotent.
  const result = await db.prepare(`INSERT INTO feedback (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,'new') ON CONFLICT(id) DO NOTHING`)
    .bind(entry.id, entry.created_at, entry.category, entry.rating, entry.message, entry.contact, entry.context_json, entry.source, entry.build)
    .run();
  const changes = result?.meta?.changes ?? result?.changes ?? 1;
  if (changes) notifyDiscord(env, ctx, entry);
  return json({ saved: true, id: entry.id }, 201, origin);
}

async function updateStatus(request, db, id, origin) {
  if (!UUID.test(id)) return json({ error: 'Invalid id' }, 400, origin);
  const body = await readJson(request, origin);
  if (body.response) return body.response;
  const status = body.value?.status;
  if (!STATUSES.includes(status)) return json({ error: 'Invalid status' }, 400, origin);
  const result = await db.prepare('UPDATE feedback SET status = ? WHERE id = ?').bind(status, id.toLowerCase()).run();
  const changes = result?.meta?.changes ?? result?.changes ?? 0;
  if (!changes) return json({ error: 'Not found' }, 404, origin);
  return json({ updated: true, id: id.toLowerCase(), status }, 200, origin);
}

export async function handleFeedback(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const item = /^\/api\/feedback\/([^/]+)$/.exec(path);
  if (path !== '/api/feedback' && path !== '/api/feedback.csv' && !item) return null;

  const origin = request.headers.get('Origin');
  const allowed = originAllowed(origin, env);
  const adminOnly = !allowed && adminOnlyOrigin(origin, env);
  if (!allowed && !adminOnly) return json({ error: 'Forbidden origin' }, 403);
  if (request.method === 'OPTIONS') {
    if (!origin) return json({ error: 'Origin required' }, 400);
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        // Admin-only origins: PATCH (JSON) on an item, GET with the key everywhere else.
        'Access-Control-Allow-Methods': adminOnly ? (item ? 'PATCH, OPTIONS' : 'GET, OPTIONS') : METHODS,
        'Access-Control-Allow-Headers': adminOnly && !item ? 'Authorization' : ALLOW_HEADERS,
        'Access-Control-Max-Age': '86400',
        'Cache-Control': 'no-store',
        Vary: 'Origin'
      }
    });
  }
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' && !origin) return json({ error: 'Forbidden' }, 403);

  const route = item ? (request.method === 'PATCH' ? 'patch' : null)
    : path === '/api/feedback.csv' ? (request.method === 'GET' ? 'csv' : null)
      : request.method === 'POST' ? 'submit' : request.method === 'GET' ? 'list' : null;
  if (!route) return json({ error: 'Method not allowed' }, 405, origin, { Allow: item ? 'PATCH, OPTIONS' : path.endsWith('.csv') ? 'GET, OPTIONS' : 'GET, POST, OPTIONS' });
  if (adminOnly && route === 'submit') return json({ error: 'Feedback is sent from the game, not from here' }, 403, origin);

  try {
    if (route !== 'submit') {
      const denied = (await limitAdmin(request, env, origin)) || (await authorize(request, env, origin));
      if (denied) return denied;
    }
    if (!env.DB) throw new Error('Feedback database unavailable');
    await ensureFeedbackTable(env.DB);
    if (route === 'submit') return await submitFeedback(request, env, ctx, env.DB, origin);
    if (route === 'list') return await listFeedback(env.DB, url.searchParams, origin);
    if (route === 'csv') return await exportCsv(env.DB, url.searchParams, origin);
    return await updateStatus(request, env.DB, item[1], origin);
  } catch (error) {
    console.error('Feedback request failed', error);
    return json({ error: 'Feedback temporarily unavailable' }, 503, origin);
  }
}
