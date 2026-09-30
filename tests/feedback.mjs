// Feedback API (server/feedback-api.js) through the real Worker entry, against an in-memory
// SQLite stand-in for D1 built from the drizzle migrations. Never touches the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.js';

const sqlite = new DatabaseSync(':memory:');
for (const file of fs.readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) sqlite.exec(fs.readFileSync('drizzle/' + file, 'utf8'));
const DB = { prepare(sql) {
  let values = [];
  return {
    bind(...v) { values = v; return this; },
    async run() { const r = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes) } }; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; }
  };
} };
const hits = new Map();
const FEEDBACK_RATE_LIMITER = { async limit({ key }) { const n = (hits.get(key) || 0) + 1; hits.set(key, n); return { success: n <= 3 }; } };
const ORIGIN = 'https://chancrisp.github.io';
const KEY = 'test-admin-key-0123456789';
const baseEnv = { DB, ENVIRONMENT: 'production', ALLOWED_ORIGINS: ORIGIN, FEEDBACK_RATE_LIMITER };
const env = { ...baseEnv, FEEDBACK_ADMIN_KEY: KEY };
const count = () => sqlite.prepare('SELECT COUNT(*) AS n FROM feedback').get().n;
const rows = () => sqlite.prepare('SELECT * FROM feedback ORDER BY created_at').all();

let ipSeq = 0;
const call = (path, { method = 'GET', body, headers = {}, ip, e = env, ctx } = {}) => worker.fetch(new Request('https://api.test' + path, {
  method,
  headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip || `198.51.100.${++ipSeq}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
}), e, ctx);
const post = (body, opts = {}) => call('/api/feedback', { method: 'POST', body, ...opts });
const admin = (path, opts = {}) => call(path, { ...opts, headers: { Authorization: `Bearer ${KEY}`, ...(opts.headers || {}) } });

const good = {
  category: 'bug', rating: 4, message: '  The dash sometimes clips through the quarry wall.  ', contact: 'ash#1234',
  context: {
    build: 'keepers-2', ruleset: 'keepers', source: 'dev', from: 'results', browser: 'Chrome 131', os: 'Windows', screen: '1920x1080@1',
    touch: false, device: 'mouse', avgFps: 58.456, secret: 'dropped',
    settings: { pixelation: 'auto', fpsCap: 60, nightmare: false, hacker: 'dropped' },
    lastRun: { outcome: 'defeat', stage: 3, score: 12000, kills: 140, seconds: 612, ruleset: 'keepers', death: false, practice: false, extra: 1 }
  },
  unknownTopLevel: 'dropped'
};

// ---- schema -------------------------------------------------------------------------------
assert.deepEqual(sqlite.prepare("PRAGMA table_info('feedback')").all().map(c => c.name),
  ['id', 'created_at', 'category', 'rating', 'message', 'contact', 'context_json', 'source', 'build', 'status']);

// ---- CORS ---------------------------------------------------------------------------------
let r = await call('/api/feedback', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type' } });
assert.equal(r.status, 204);
assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
assert.match(r.headers.get('Access-Control-Allow-Methods'), /PATCH/);
assert.match(r.headers.get('Access-Control-Allow-Headers'), /Authorization/);
r = await call('/api/feedback/11111111-1111-4111-8111-111111111111', { method: 'OPTIONS' });
assert.equal(r.status, 204, 'Preflight also covers PATCH /api/feedback/:id');
r = await call('/api/feedback', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
assert.equal(r.status, 403);
assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
r = await post(good, { headers: { Origin: 'https://evil.example' } });
assert.equal(r.status, 403, 'Other sites cannot post feedback');
assert.equal(count(), 0);
r = await call('/api/feedback', { method: 'DELETE' });
assert.equal(r.status, 405);

// ---- submit + validation --------------------------------------------------------------------
r = await post(good, { ip: '203.0.113.9' });
assert.equal(r.status, 201);
assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
const saved = await r.json();
assert.equal(saved.saved, true);
assert.equal(count(), 1);
let row = rows()[0];
assert.equal(row.id, saved.id);
assert.equal(row.message, 'The dash sometimes clips through the quarry wall.', 'Message is trimmed');
assert.equal(row.status, 'new');
assert.equal(row.source, 'dev');
assert.equal(row.build, 'keepers-2');
assert.equal(row.rating, 4);
assert.equal(row.contact, 'ash#1234');
const ctxStored = JSON.parse(row.context_json);
assert.equal(ctxStored.secret, undefined, 'Unknown context keys are dropped');
assert.equal(ctxStored.settings.hacker, undefined, 'Unknown settings are dropped');
assert.deepEqual(ctxStored.settings, { pixelation: 'auto', fpsCap: 60, nightmare: false });
assert.equal(ctxStored.lastRun.extra, undefined);
assert.equal(ctxStored.avgFps, 58.5);
assert.ok(!JSON.stringify(rows()).includes('203.0.113.9'), 'No IP address is stored');

const invalid = [
  [{ ...good, category: 'rant' }, 400], [{ ...good, category: undefined }, 400],
  [{ ...good, rating: 0 }, 400], [{ ...good, rating: 6 }, 400], [{ ...good, rating: 2.5 }, 400], [{ ...good, rating: '3' }, 400],
  [{ ...good, message: '   short    ' }, 400], [{ ...good, message: 'x'.repeat(1501) }, 400], [{ ...good, message: 42 }, 400],
  [{ ...good, contact: 'c'.repeat(121) }, 400], [{ ...good, contact: 5 }, 400], [[], 400], ['null', 400], ['{nope', 400]
];
for (const [body, status] of invalid) assert.equal((await post(body)).status, status, JSON.stringify(body).slice(0, 80));
assert.equal((await call('/api/feedback', { method: 'POST', body: JSON.stringify(good), headers: { 'Content-Type': 'text/plain' } })).status, 415);
assert.equal((await post({ ...good, context: { ...good.context, pad: 'x'.repeat(9000) } })).status, 413, 'Bodies over 8 KB are refused');
assert.equal(count(), 1, 'Nothing invalid was stored');

// Edge lengths and optional fields.
r = await post({ category: 'idea', message: 'x'.repeat(1500) });
assert.equal(r.status, 201);
row = sqlite.prepare('SELECT * FROM feedback WHERE id = ?').get((await r.json()).id);
assert.equal(row.rating, null);
assert.equal(row.contact, null);
assert.equal(row.source, 'unknown', 'Missing context is labelled unknown, not live');
r = await post({ category: 'other', rating: null, message: '1234567890', contact: '   ', context: { source: 'prod', build: 'b'.repeat(99), browser: 7 } });
assert.equal(r.status, 201);
row = sqlite.prepare('SELECT * FROM feedback WHERE id = ?').get((await r.json()).id);
assert.equal(row.contact, null);
assert.equal(row.build.length, 40, 'Context strings are capped');
assert.equal(JSON.parse(row.context_json).browser, undefined);

// Honeypot: success-shaped reply, nothing stored.
const before = count();
r = await post({ ...good, website: 'http://spam.example' });
assert.equal(r.status, 201);
assert.equal((await r.json()).saved, true);
assert.equal(count(), before, 'Honeypot submissions are not stored');

// Client ids make outbox retries idempotent.
const clientId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
assert.equal((await post({ ...good, id: clientId })).status, 201);
assert.equal((await post({ ...good, id: clientId.toUpperCase() })).status, 201);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM feedback WHERE id = ?').get(clientId).n, 1, 'A retried submission is stored once');

// Rate limit: 3 per minute per IP.
for (let i = 0; i < 3; i++) assert.equal((await post(good, { ip: '192.0.2.77' })).status, 201);
r = await post(good, { ip: '192.0.2.77' });
assert.equal(r.status, 429);
assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'The game can read the 429');
assert.equal((await post(good, { ip: '192.0.2.78' })).status, 201, 'Other players are unaffected');

// ---- Discord ping (non-blocking, failures ignored) ------------------------------------------
const realFetch = globalThis.fetch;
const pings = [];
const waits = [];
globalThis.fetch = async (url, init) => { pings.push({ url, body: JSON.parse(init.body) }); throw new Error('discord down'); };
r = await post({ ...good, category: 'balance', rating: 2, message: '@everyone ' + 'y'.repeat(400) }, {
  e: { ...env, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, ctx: { waitUntil: p => waits.push(p) }
});
await Promise.all(waits);
globalThis.fetch = realFetch;
assert.equal(r.status, 201, 'A failing webhook never fails the submission');
assert.equal(pings.length, 1);
assert.equal(waits.length, 1, 'The ping runs through ctx.waitUntil');
assert.match(pings[0].body.content, /BALANCE/);
assert.match(pings[0].body.content, /dev/);
assert.ok(pings[0].body.content.length < 450, 'Only the first 300 characters are forwarded');
assert.deepEqual(pings[0].body.allowed_mentions, { parse: [] }, 'Player text cannot ping @everyone');

// ---- admin ----------------------------------------------------------------------------------
r = await call('/api/feedback', { e: baseEnv });
assert.equal(r.status, 503);
assert.deepEqual(await r.json(), { error: 'Feedback admin key not configured' });
assert.equal((await call('/api/feedback')).status, 401);
assert.equal((await call('/api/feedback', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
assert.equal((await call('/api/feedback', { headers: { Authorization: `Bearer ${KEY}x` } })).status, 401);
assert.equal((await call('/api/feedback.csv', { headers: { Authorization: 'Basic ' + KEY } })).status, 401);
assert.equal((await call('/api/feedback/' + clientId, { method: 'PATCH', body: { status: 'read' } })).status, 401, 'PATCH needs the key');

// Spread timestamps so ordering and "since" are deterministic.
const all = rows();
all.forEach((item, i) => sqlite.prepare('UPDATE feedback SET created_at = ? WHERE id = ?').run(1790000000000 + i * 1000, item.id));
r = await admin('/api/feedback');
assert.equal(r.status, 200);
assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
let list = await r.json();
assert.equal(list.items.length, all.length);
assert.ok(list.items.every((item, i) => i === 0 || item.created_at <= list.items[i - 1].created_at), 'Newest first');
assert.equal(typeof list.items[0].context, 'object', 'Context comes back parsed');
assert.equal(list.items[0].context_json, undefined);
assert.deepEqual(list.counts, { new: all.length, read: 0, archived: 0, total: all.length });

// Cursor paging walks every row exactly once.
const seen = [];
let cursor = null;
do {
  const page = await (await admin('/api/feedback?limit=3' + (cursor ? '&cursor=' + cursor : ''))).json();
  assert.ok(page.items.length <= 3);
  seen.push(...page.items.map(item => item.id));
  cursor = page.nextCursor;
} while (cursor);
assert.equal(new Set(seen).size, all.length);
for (const bad of ['limit=0', 'limit=201', 'status=spam', 'category=x', 'source=prod', 'rating=9', 'since=yesterday', 'cursor=abc']) {
  assert.equal((await admin('/api/feedback?' + bad)).status, 400, bad);
}

// Status triage.
r = await admin('/api/feedback/' + clientId, { method: 'PATCH', body: { status: 'read' } });
assert.equal(r.status, 200);
assert.deepEqual(await r.json(), { updated: true, id: clientId, status: 'read' });
assert.equal((await admin('/api/feedback/' + clientId, { method: 'PATCH', body: { status: 'deleted' } })).status, 400);
assert.equal((await admin('/api/feedback/00000000-0000-4000-8000-000000000000', { method: 'PATCH', body: { status: 'read' } })).status, 404);
assert.equal((await admin('/api/feedback/not-an-id', { method: 'PATCH', body: { status: 'read' } })).status, 400);
assert.equal((await admin('/api/feedback/' + clientId, { method: 'GET' })).status, 405);

// Filters.
list = await (await admin('/api/feedback?status=read')).json();
assert.deepEqual(list.items.map(item => item.id), [clientId]);
assert.equal(list.counts.read, 1);
assert.equal(list.counts.new, all.length - 1);
assert.equal((await admin('/api/feedback/' + all[0].id, { method: 'PATCH', body: { status: 'archived' } })).status, 200);
list = await (await admin('/api/feedback?status=active')).json();
assert.ok(list.items.length === all.length - 1 && !list.items.some(item => item.id === all[0].id), 'active hides archived feedback');
assert.equal((await admin('/api/feedback/' + all[0].id, { method: 'PATCH', body: { status: 'new' } })).status, 200);
list = await (await admin('/api/feedback?category=idea')).json();
assert.ok(list.items.length === 1 && list.items[0].category === 'idea');
list = await (await admin('/api/feedback?source=unknown')).json();
assert.ok(list.items.length === 2 && list.items.every(item => item.source === 'unknown'));
list = await (await admin('/api/feedback?rating=none')).json();
assert.ok(list.items.length === 2 && list.items.every(item => item.rating === null));
list = await (await admin('/api/feedback?rating=2&category=balance')).json();
assert.equal(list.items.length, 1);
list = await (await admin('/api/feedback?since=' + (1790000000000 + (all.length - 2) * 1000))).json();
assert.equal(list.items.length, 2, 'since keeps only newer feedback');
list = await (await admin('/api/feedback?since=2027-01-01')).json();
assert.equal(list.items.length, 0, 'since also takes an ISO date');

// CSV export: download headers, quoting, and spreadsheet formula neutralising.
sqlite.prepare('UPDATE feedback SET message = ? WHERE id = ?').run('=HYPERLINK("http://x","click") and "quotes", commas', clientId);
r = await admin('/api/feedback.csv?status=read');
assert.equal(r.status, 200);
assert.match(r.headers.get('Content-Type'), /^text\/csv/);
assert.match(r.headers.get('Content-Disposition'), /attachment; filename="riftborn-feedback-\d{4}-\d{2}-\d{2}\.csv"/);
assert.match(r.headers.get('Access-Control-Expose-Headers'), /Content-Disposition/);
const csv = await r.text();
const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
assert.equal(lines[0], 'id,created_at,status,category,rating,source,build,message,contact,context_json');
assert.equal(lines.length, 2);
assert.ok(lines[1].includes(`"'=HYPERLINK(""http://x"",""click"") and ""quotes"", commas"`), 'Formulas are neutralised and quotes doubled');
assert.equal((await call('/api/feedback.csv')).status, 401);

// ---- the score route is untouched ---------------------------------------------------------
r = await worker.fetch(new Request('https://api.test/api/scores', { headers: { Origin: ORIGIN } }), env);
assert.equal(r.status, 200);
assert.deepEqual((await r.json()).scores, []);
r = await worker.fetch(new Request('https://api.test/api/scores', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
assert.equal(r.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS', 'Score CORS is unchanged');
assert.equal((await worker.fetch(new Request('https://api.test/elsewhere'), env)).status, 404);

console.log('PASS feedback: validation, honeypot, rate limit, no IPs, Discord ping, admin auth, filters, paging, status, CSV, CORS.');
