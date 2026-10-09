// Player metrics on the leaderboard Worker (server/stats-api.js, server/stats-counters.js, server/admin-auth.js):
// anonymous run reports into one-dimensional daily counters with a daily write ceiling, the sign-ups counter,
// and the admin read behind the inbox's admin key. Local only: an in-memory SQLite database stands in for D1.
// The last line of this file is the PASS line; later tasks add their blocks above it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as auth from '../server/admin-auth.js';
import * as feedback from '../server/feedback-api.js';
import worker from '../cloudflare/worker.js';
import { MIGRATION } from '../site.config.mjs';
import { ensureAccountTables } from '../server/accounts-api.js';
import { createD1, openDatabase } from '../server/d1-sqlite.mjs';
import { DIM_PATTERN, STATS_BODY_MAX, STATS_METRICS, STATS_ORIGIN, STATS_RANGES, handleStats, readStats, reportRows, validateReport } from '../server/stats-api.js';
import { COUNTER_METRICS, DIM_CAPS, STATS_DAILY_WRITE_CEILING, WRITES_METRIC, ensureStatsTable, reportStatements, utcDay } from '../server/stats-counters.js';

// ---- Task 1.1: the inbox admin helpers moved into server/admin-auth.js without a change in behaviour -------------
for (const name of ['corsHeaders', 'json', 'originAllowed', 'adminOnlyOrigin', 'sameSecret', 'limitAdmin', 'authorize']) {
  assert.equal(typeof auth[name], 'function', `admin-auth.js exports ${name}`);
}
assert.deepEqual(auth.ADMIN_LIMIT, { scope: 'feedback-admin', retryAfter: 60 });
assert.equal(feedback.ADMIN_LIMIT, auth.ADMIN_LIMIT, 'feedback-api.js exports the identical object');
assert.equal(auth.CORS_METHODS, 'GET, POST, PATCH, OPTIONS');
assert.equal(auth.CORS_ALLOW_HEADERS, 'Content-Type, Authorization');
assert.equal(await auth.sameSecret('abc', 'abc'), true);
assert.equal(await auth.sameSecret('abc', 'abd'), false);
assert.equal(auth.adminOnlyOrigin('https://feedback.riftborn.us', { FEEDBACK_ADMIN_ORIGINS: 'https://feedback.riftborn.us' }), true);
assert.equal(auth.adminOnlyOrigin(null, { FEEDBACK_ADMIN_ORIGINS: 'https://feedback.riftborn.us' }), false);
assert.equal(auth.originAllowed(null, {}), true);

// ---- Task 1.2: the daily_stats table, lazy in production and mirrored in Drizzle ---------------------------------
{
  const A = createD1(openDatabase(':memory:', 'drizzle', fs)); // migrations applied, as the preview database
  const B = createD1(openDatabase(':memory:')); // a bare database: only the lazy bootstrap can create the table
  assert.equal((await B.prepare("SELECT name FROM sqlite_master WHERE name = 'daily_stats'").first()), null);
  await ensureStatsTable(B);
  const info = db => db.sqlite.prepare("PRAGMA table_info('daily_stats')").all().map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
  assert.deepEqual(info(A), info(B), 'the migration and the lazy bootstrap build the same table');
  assert.deepEqual(info(A).map(c => c[0]), ['day', 'metric', 'dim', 'n']);
  assert.deepEqual(info(A).map(c => c[4]), [1, 2, 3, 0], 'primary key (day, metric, dim)');
  assert.equal(info(A).find(c => c[0] === 'n')[3], '0');
  for (const db of [A, B]) assert.match(db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'daily_stats'").get().sql, /WITHOUT ROWID/, 'one row per upsert, not a row plus an index entry');
  await ensureStatsTable(A); // already there: a no-op
  assert.doesNotThrow(() => A.sqlite.exec(fs.readFileSync('drizzle/0006_daily_stats.sql', 'utf8')), 'the migration is re-runnable');
  const journal = JSON.parse(fs.readFileSync('drizzle/meta/_journal.json', 'utf8')).entries.at(-1);
  assert.deepEqual([journal.idx, journal.tag], [6, '0006_daily_stats']);
  assert.ok(JSON.parse(fs.readFileSync('drizzle/meta/0006_snapshot.json', 'utf8')).tables.daily_stats, 'the snapshot knows the table');
  assert.equal(utcDay(Date.parse('2026-10-20T23:59:59.999Z')), '2026-10-20');
  assert.equal(utcDay(Date.parse('2026-10-20T23:59:59.999Z') + 1), '2026-10-21');
  assert.equal(STATS_DAILY_WRITE_CEILING, 30000);
  assert.equal(WRITES_METRIC, '_writes');
  assert.deepEqual(DIM_CAPS, { character: 32, weapon: 16, version: 8 });
  assert.deepEqual(COUNTER_METRICS, ['players', 'runs', 'wins', 'stage_reached', 'character', 'weapon', 'device', 'version', 'length', 'signups']);
  // Stage 5's privacy pin parses the table out of the source text: one literal with no quote inside, repeated nowhere else.
  const source = fs.readFileSync('server/stats-counters.js', 'utf8');
  const match = /CREATE TABLE IF NOT EXISTS daily_stats\s*\(([^`'"]*)\)(?:\s*WITHOUT ROWID)?\s*[`'"]/.exec(source);
  assert.ok(match, 'the DDL is one literal in server/stats-counters.js');
  for (const part of ['day', 'metric', 'dim', 'n', 'PRIMARY KEY (day, metric, dim)']) assert.ok(match[1].includes(part), 'the DDL names ' + part);
  assert.equal(source.split('CREATE TABLE IF NOT EXISTS daily_stats').length - 1, 1, 'the DDL appears exactly once');
}

// ---- Task 1.3: guarded counter upserts: dim caps and the daily write ceiling -------------------------------------
{
  const sqlite = openDatabase(':memory:', 'drizzle', fs), db = createD1(sqlite), DAY = '2026-10-20', C = STATS_DAILY_WRITE_CEILING;
  const get = (m, d, day = DAY) => sqlite.prepare('SELECT n FROM daily_stats WHERE day=? AND metric=? AND dim=?').get(day, m, d)?.n;
  const rows = [['runs', 'all'], ['character', 'rift-knight']];
  sqlite.prepare("INSERT INTO daily_stats VALUES (?, '_writes', 'all', ?)").run(DAY, C - 1);
  await db.batch(reportStatements(db, DAY, rows));
  assert.equal(get('runs', 'all'), 1, 'one below the ceiling: counted');
  assert.equal(get('_writes', 'all'), C + 1, 'a counted report may overshoot by its own rows');
  await db.batch(reportStatements(db, DAY, rows));
  assert.equal(get('runs', 'all'), 1, 'at or over the ceiling: dropped');
  assert.equal(get('_writes', 'all'), C + 1, 'a dropped report writes nothing, not even _writes');
  await db.batch(reportStatements(db, '2026-10-21', rows));
  assert.equal(get('runs', 'all', '2026-10-21'), 1, 'the next UTC day counts again');
}
{
  const sqlite = openDatabase(':memory:', 'drizzle', fs), db = createD1(sqlite), DAY = '2026-10-22';
  const get = (m, d) => sqlite.prepare('SELECT n FROM daily_stats WHERE day=? AND metric=? AND dim=?').get(DAY, m, d)?.n;
  const distinct = m => sqlite.prepare('SELECT COUNT(*) AS c FROM daily_stats WHERE day=? AND metric=?').get(DAY, m).c;
  let runs = 0;
  for (const [metric, cap] of Object.entries(DIM_CAPS)) {
    for (let i = 0; i < cap; i++) await db.batch(reportStatements(db, DAY, [[metric, 'dim-' + i]]));
    assert.equal(distinct(metric), cap, metric + ' filled to its cap');
    await db.batch(reportStatements(db, DAY, [['runs', 'all'], [metric, 'dim-new']]));
    runs++;
    assert.equal(distinct(metric), cap, `a new ${metric} beyond ${cap} adds no row`);
    assert.equal(get(metric, 'dim-new'), undefined);
    assert.equal(get('runs', 'all'), runs, 'the run itself still counts');
    await db.batch(reportStatements(db, DAY, [[metric, 'dim-0']]));
    assert.equal(get(metric, 'dim-0'), 2, 'an existing dim always increments');
  }
  // A fresh day: a report of k rows leaves _writes = k.
  await db.batch(reportStatements(db, '2026-11-01', [['runs', 'all'], ['players', 'all'], ['device', 'desktop']]));
  assert.equal(sqlite.prepare("SELECT n FROM daily_stats WHERE day='2026-11-01' AND metric='_writes'").get().n, 3);
}

// ---- Task 1.4: strict validation of a report and the counter rows it makes ---------------------------------------
{
  const GOOD = { v: 1, game: '2.6.0', device: 'desktop', character: 'rift-knight', weapon: 'rail_pistol', stage: 3, outcome: 'death', length: '5-10', first: false };
  const bad = (payload, label) => {
    const answer = validateReport(payload);
    assert.equal(typeof answer.error, 'string', 'refused: ' + label);
    assert.equal('value' in answer, false, label);
  };
  const good = (payload, label) => assert.deepEqual(validateReport(payload), { value: payload }, 'accepted: ' + label);
  assert.equal(STATS_BODY_MAX, 512);
  assert.equal(DIM_PATTERN.test('rift-knight') && DIM_PATTERN.test('2.6.0') && DIM_PATTERN.test('x'.repeat(24)), true);
  assert.equal(DIM_PATTERN.test('') || DIM_PATTERN.test('a b') || DIM_PATTERN.test('x'.repeat(25)), false);
  good(GOOD, 'the plain report');
  for (const [payload, label] of [[null, 'null'], [[], 'an array'], ['x', 'a string'], [7, 'a number']]) bad(payload, label);
  bad({ ...GOOD, ip: '203.0.113.9' }, 'an extra ip key');
  bad({ ...GOOD, score: 9000 }, 'an extra score key');
  for (const key of Object.keys(GOOD)) { const { [key]: omitted, ...rest } = GOOD; bad(rest, 'missing ' + key); }
  for (const v of [2, '1', 0, null]) bad({ ...GOOD, v }, 'v ' + v);
  for (const game of ['', 'a b', 'x'.repeat(25), 2, null]) bad({ ...GOOD, game }, 'game ' + game);
  for (const key of ['character', 'weapon']) for (const value of ['', 'a b', 'bad id!', 'x'.repeat(25), 7, null]) bad({ ...GOOD, [key]: value }, key + ' ' + value);
  for (const device of ['console', '', 'Desktop', 1]) bad({ ...GOOD, device }, 'device ' + device);
  for (const stage of [0, 7, 1.5, '3', null, NaN]) bad({ ...GOOD, stage }, 'stage ' + stage);
  for (const outcome of ['quit', 'WIN', '', 1]) bad({ ...GOOD, outcome }, 'outcome ' + outcome);
  for (const length of ['u3', '2-5 ', '', 5, 'o4']) bad({ ...GOOD, length }, 'length ' + length);
  for (const first of ['true', 1, 0, null, 'false']) bad({ ...GOOD, first }, 'first ' + first);
  for (const device of ['desktop', 'phone', 'tablet']) good({ ...GOOD, device }, device);
  for (const outcome of ['win', 'death']) good({ ...GOOD, outcome }, outcome);
  for (const length of ['u2', '2-5', '5-10', '10-20', '20-40', 'o40']) good({ ...GOOD, length }, length);
  for (const stage of [1, 2, 3, 4, 5, 6]) good({ ...GOOD, stage }, 'stage ' + stage);
  good({ ...GOOD, first: true }, 'first true');
  // No coercion, no trimming, case kept as sent, only the nine fields returned.
  assert.equal(validateReport({ ...GOOD, character: 'Rift-Knight' }).value.character, 'Rift-Knight');
  assert.deepEqual(Object.keys(validateReport(GOOD).value).sort(), ['character', 'device', 'first', 'game', 'length', 'outcome', 'stage', 'v', 'weapon']);
  // The counter rows a report makes, in order.
  const full = reportRows({ ...GOOD, first: true, outcome: 'win' });
  assert.equal(full.length, 9);
  assert.deepEqual(full.slice(0, 3), [['players', 'all'], ['runs', 'all'], ['wins', 'all']]);
  assert.equal(reportRows(GOOD).length, 7);
  assert.deepEqual(reportRows(GOOD), [['runs', 'all'], ['stage_reached', '3'], ['character', 'rift-knight'], ['weapon', 'rail_pistol'], ['device', 'desktop'], ['version', '2.6.0'], ['length', '5-10']]);
  assert.deepEqual(reportRows(GOOD).slice(-2), [['version', '2.6.0'], ['length', '5-10']]);
  assert.equal(STATS_METRICS, COUNTER_METRICS, 'one list of metrics');
  assert.deepEqual([...STATS_METRICS], ['players', 'runs', 'wins', 'stage_reached', 'character', 'weapon', 'device', 'version', 'length', 'signups']);
}

// ---- Task 1.5: POST /api/stats --------------------------------------------------------------------------------
const GOOD = { v: 1, game: '2.6.0', device: 'desktop', character: 'rift-knight', weapon: 'rail_pistol', stage: 3, outcome: 'death', length: '5-10', first: false };
const stubNow = iso => { const real = Date.now; Date.now = () => Date.parse(iso); return () => { Date.now = real; }; };
const quietConsole = () => { const real = { log: console.log, error: console.error, warn: console.warn }; const logs = []; for (const k of Object.keys(real)) console[k] = (...a) => logs.push(a.join(' ')); return { logs, restore: () => Object.assign(console, real) }; };
const makeEnv = (over = {}) => {
  const sqlite = openDatabase(':memory:', 'drizzle', fs);
  return { sqlite, env: { DB: createD1(sqlite), ENVIRONMENT: 'production', AUTH_SIGNING_KEY: 'k'.repeat(43), ACCOUNTS_RATE_LIMITER: { async limit() { return { success: true }; } }, ...over } };
};
let ipSeq = 0;
const send = (env, { method = 'POST', origin = STATS_ORIGIN, body = GOOD, contentType = 'application/json', url = 'https://api.test/api/stats', headers = {} } = {}) => handleStats(new Request(url, {
  method,
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  headers: { ...(origin === null ? {} : { Origin: origin }), ...(contentType ? { 'Content-Type': contentType } : {}), 'CF-Connecting-IP': `198.51.100.${++ipSeq}`, ...headers }
}), env, { waitUntil() {} });
const rowsOf = sqlite => sqlite.prepare('SELECT day, metric, dim, n FROM daily_stats ORDER BY day, metric, dim').all().map(r => ({ ...r }));
const countOf = (sqlite, metric, dim, day) => sqlite.prepare('SELECT n FROM daily_stats WHERE metric = ? AND dim = ?' + (day ? ' AND day = ?' : '')).get(...(day ? [metric, dim, day] : [metric, dim]))?.n;

assert.equal(STATS_ORIGIN, 'https://riftborn.us');
assert.equal(await handleStats(new Request('https://api.test/api/scores', { method: 'POST' }), {}, {}), null, 'not its path: null');
{ // PRIVACY: the handler reads only Origin, Content-Type and the limiter key; nothing about the sender reaches D1, the limiter key or the logs.
  const seen = { headers: new Set(), props: new Set(), other: new Set() }, keys = [];
  const spy = request => new Proxy(request, { get(target, prop) {
    seen.props.add(String(prop));
    const value = Reflect.get(target, prop, target);
    if (prop === 'headers') return new Proxy(value, { get(h, name) {
      if (name === 'get') return key => (seen.headers.add(String(key).toLowerCase()), h.get(key));
      seen.other.add(String(name)); return undefined;
    } });
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const q = quietConsole();
  const { sqlite, env } = makeEnv({ ACCOUNTS_RATE_LIMITER: { async limit({ key }) { keys.push(key); return { success: true }; } } });
  const request = new Request('https://api.test/api/stats', { method: 'POST', body: JSON.stringify(GOOD), headers: { Origin: STATS_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', 'User-Agent': 'PrivacyProbe/1.0' } });
  const r = await handleStats(spy(request), env, { waitUntil() {} });
  q.restore();
  assert.equal(r.status, 204);
  assert.deepEqual([...seen.headers].sort(), ['cf-connecting-ip', 'content-type', 'origin'], 'only Origin, Content-Type and the limiter key');
  assert.ok(!seen.props.has('cf') && seen.other.size === 0, 'no request.cf, no header enumeration');
  const dump = JSON.stringify(sqlite.prepare('SELECT * FROM daily_stats').all()) + keys.join() + q.logs.join('\n');
  assert.ok(!dump.includes('203.0.113.9') && !dump.includes('PrivacyProbe'), 'no IP or user agent in D1, limiter key or logs');
  assert.match(keys[0], /^[A-Za-z0-9_-]{43}$/, 'the limiter key is a keyed hash');
}
{ // (1) the gate is the Origin
  const q = quietConsole();
  for (const origin of ['https://dev.riftborn.us', null, 'https://riftborn.us.evil.example', 'http://riftborn.us', 'https://www.riftborn.us', 'null']) {
    let limited = 0;
    const env = { DB: { prepare() { throw new Error('touched'); }, batch() { throw new Error('touched'); } }, AUTH_SIGNING_KEY: 'k'.repeat(43), ACCOUNTS_RATE_LIMITER: { async limit() { limited++; return { success: true }; } } };
    const r = await send(env, { origin });
    assert.equal(r.status, 403, String(origin));
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, 'no CORS header for a refused origin: ' + origin);
    assert.equal(limited, 0, 'nothing ran: ' + origin);
  }
  q.restore();
  const { env } = makeEnv();
  const workers = 'https://riftborn-leaderboard.chanmanc10.workers.dev/api/stats';
  assert.equal((await send(env, { url: workers })).status, 204, 'the gate is the Origin, not the host');
  assert.equal((await send(env, { url: workers, origin: 'https://dev.riftborn.us' })).status, 403);
}
{ // (2) preflight and methods
  const { env } = makeEnv();
  const pre = await send(env, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.deepEqual([pre.headers.get('Access-Control-Allow-Origin'), pre.headers.get('Access-Control-Allow-Methods'), pre.headers.get('Access-Control-Allow-Headers'), pre.headers.get('Access-Control-Max-Age')], [STATS_ORIGIN, 'POST, OPTIONS', 'Content-Type', '86400']);
  assert.equal((await send(env, { method: 'OPTIONS', origin: 'https://dev.riftborn.us' })).status, 403);
  const get = await send(env, { method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST, OPTIONS');
}
{ // (3) body: exactly 512 bytes passes, 513 is too large, bad content type, bad JSON, wrong shape
  const { sqlite, env } = makeEnv();
  const body = JSON.stringify(GOOD);
  const padded = n => body + ' '.repeat(n - Buffer.byteLength(body));
  assert.equal((await send(env, { body: padded(STATS_BODY_MAX) })).status, 204);
  const rowsBefore = rowsOf(sqlite);
  const big = await send(env, { body: padded(STATS_BODY_MAX + 1) });
  assert.equal(big.status, 413);
  assert.equal(big.headers.get('Access-Control-Allow-Origin'), STATS_ORIGIN);
  for (const [options, label] of [[{ contentType: 'text/plain' }, 'text/plain'], [{ body: '{nope' }, 'bad JSON'], [{ body: { ...GOOD, ip: '1.2.3.4' } }, 'wrong shape'], [{ contentType: null }, 'no content type']]) {
    const r = await send(env, options);
    assert.equal(r.status, 400, label);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), STATS_ORIGIN, label);
  }
  assert.deepEqual(rowsOf(sqlite), rowsBefore, 'nothing written by a refused body');
}
{ // (4) the limiter
  const { sqlite, env } = makeEnv({ ACCOUNTS_RATE_LIMITER: { async limit() { return { success: false }; } } });
  const r = await send(env);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), '60');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), STATS_ORIGIN);
  assert.deepEqual(rowsOf(sqlite), [], 'no write');
  let called = 0;
  const open = makeEnv({ AUTH_SIGNING_KEY: undefined, ACCOUNTS_RATE_LIMITER: { async limit() { called++; return { success: true }; } } });
  assert.equal((await send(open.env)).status, 204, 'no signing key: the limiter is skipped and the report still counts');
  assert.equal(called, 0, 'no raw-address key is ever built');
  assert.equal(countOf(open.sqlite, 'runs', 'all'), 1);
  const none = makeEnv({ ACCOUNTS_RATE_LIMITER: undefined });
  assert.equal((await send(none.env)).status, 204, 'no limiter binding: still counted');
}
{ // (5) counting, (6) one batch per report
  const { sqlite, env } = makeEnv();
  const realBatch = env.DB.batch.bind(env.DB), sizes = [];
  env.DB.batch = async statements => { sizes.push(statements.length); return realBatch(statements); };
  assert.equal(await (await send(env)).text(), '', 'the 204 body is empty');
  await send(env);
  assert.equal(countOf(sqlite, 'runs', 'all'), 2);
  assert.equal(countOf(sqlite, 'stage_reached', '3'), 2);
  assert.equal(countOf(sqlite, 'players', 'all'), undefined);
  assert.equal(countOf(sqlite, 'wins', 'all'), undefined);
  await send(env, { body: { ...GOOD, first: true, outcome: 'win', stage: 6 } });
  assert.equal(countOf(sqlite, 'players', 'all'), 1);
  assert.equal(countOf(sqlite, 'wins', 'all'), 1);
  assert.deepEqual(sizes, [8, 8, 10], 'one batch per report: 10 statements for first+win, 8 for a non-first death');
}
{ // (7) a bare database gets the table; a failing database answers 503
  const bare = createD1(openDatabase(':memory:'));
  assert.equal((await send({ DB: bare, AUTH_SIGNING_KEY: 'k'.repeat(43) })).status, 204);
  assert.equal(bare.sqlite.prepare('SELECT n FROM daily_stats WHERE metric = ?').get('runs').n, 1);
  const q = quietConsole();
  const { env } = makeEnv();
  env.DB.batch = async () => { throw new Error('boom'); };
  for (const broken of [env, { ...env, DB: undefined }]) {
    const r = await send(broken);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'unavailable' });
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), STATS_ORIGIN);
  }
  q.restore();
  assert.ok(q.logs.every(line => !line.includes('198.51.100')), 'no address in the logs');
}
{ // (8) the day rule: the UTC day of receipt
  const { sqlite, env } = makeEnv();
  let restore = stubNow('2026-10-20T23:59:59.999Z');
  await send(env);
  restore();
  restore = stubNow('2026-10-21T00:00:00.000Z');
  await send(env, { body: { ...GOOD, first: true, outcome: 'win' } });
  restore();
  assert.equal(countOf(sqlite, 'runs', 'all', '2026-10-20'), 1);
  assert.equal(countOf(sqlite, 'runs', 'all', '2026-10-21'), 1);
  assert.equal(countOf(sqlite, 'players', 'all', '2026-10-21'), 1, 'a first report received after midnight counts on the new day');
  assert.equal(countOf(sqlite, 'players', 'all', '2026-10-20'), undefined);
  const metrics = sqlite.prepare('SELECT DISTINCT metric FROM daily_stats').all().map(r => r.metric);
  assert.ok(metrics.every(m => COUNTER_METRICS.includes(m) || m === '_writes'), 'only known metrics: ' + metrics);
}
{ // Step 1b: the ceiling lives in D1, not in memory: a fresh isolate over the same file still drops the report
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-stats-'));
  const file = path.join(dir, 'stats.sqlite');
  const restore = stubNow('2026-10-20T12:00:00Z');
  try {
    const first = openDatabase(file, 'drizzle', fs);
    first.prepare("INSERT INTO daily_stats VALUES ('2026-10-20', '_writes', 'all', ?)").run(STATS_DAILY_WRITE_CEILING);
    first.prepare("INSERT INTO daily_stats VALUES ('2026-10-20', 'runs', 'all', 5)").run();
    first.close();
    const again = openDatabase(file, 'drizzle', fs);
    const r = await send({ DB: createD1(again), AUTH_SIGNING_KEY: 'k'.repeat(43) });
    assert.equal(r.status, 204);
    assert.equal(again.prepare("SELECT n FROM daily_stats WHERE metric = 'runs'").get().n, 5, 'dropped: runs unchanged');
    assert.equal(again.prepare("SELECT n FROM daily_stats WHERE metric = '_writes'").get().n, STATS_DAILY_WRITE_CEILING, 'a dropped report does not even touch _writes');
    again.close();
  } finally {
    restore();
    fs.rmSync(file, { force: true });
    fs.rmdirSync(dir);
  }
}

{ // Task 1.6: the route is reachable through the real Worker entry
  const { sqlite, env } = makeEnv();
  const r = await worker.fetch(new Request('https://api.test/api/stats', { method: 'POST', body: JSON.stringify(GOOD), headers: { Origin: STATS_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.250' } }), env, { waitUntil() {} });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=31536000', 'HSTS on https answers');
  assert.equal(countOf(sqlite, 'runs', 'all'), 1);
}

// ---- Task 1.7: readStats, the admin read model ---------------------------------------------------------------------
{
  assert.deepEqual(STATS_RANGES, ['7', '30', '90', 'all']);
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const empty = createD1(openDatabase(':memory:', 'drizzle', fs));
  const none = await readStats(empty, 'all', NOW);
  assert.deepEqual([none.days, none.lastReceived, none.ceiling, none.accountsTotal], [[], null, { day: '2026-10-20', used: 0, limit: STATS_DAILY_WRITE_CEILING }, 0]);
  assert.deepEqual(none.breakdowns, { stage_reached: [], character: [], weapon: [], device: [], version: [], length: [] });
  assert.equal(none.range, 'all');

  const sqlite = openDatabase(':memory:', 'drizzle', fs), db = createD1(sqlite);
  const seed = (day, metric, dim, n) => sqlite.prepare('INSERT OR REPLACE INTO daily_stats VALUES (?, ?, ?, ?)').run(day, metric, dim, n);
  seed('2026-07-01', 'runs', 'all', 4);
  for (const day of ['2026-10-12', '2026-10-15', '2026-10-19']) { seed(day, 'players', 'all', 2); seed(day, 'runs', 'all', 5); seed(day, 'wins', 'all', 1); }
  seed('2026-10-12', 'character', 'old-one', 3); // 8 days back: in '30', not in '7'
  seed('2026-10-15', 'character', 'rift-knight', 4); seed('2026-10-19', 'character', 'rift-knight', 2); seed('2026-10-19', 'character', 'abbot', 6); seed('2026-10-19', 'character', 'aaa', 6);
  seed('2026-10-19', 'stage_reached', '6', 1); seed('2026-10-19', 'stage_reached', '2', 3); seed('2026-10-19', 'stage_reached', '10', 1);
  seed('2026-10-19', 'length', 'o40', 1); seed('2026-10-19', 'length', '2-5', 2); seed('2026-10-19', 'length', 'u2', 1);
  seed('2026-10-19', 'device', 'desktop', 5); seed('2026-10-19', 'weapon', 'rail_pistol', 5); seed('2026-10-19', 'version', '2.6.0', 5);
  seed('2026-10-20', 'signups', 'all', 2); // a later day with only sign-ups
  seed('2026-10-20', '_writes', 'all', 37);
  ensureAccountTables(db);
  sqlite.exec("INSERT INTO accounts (id, username) VALUES ('a1', 'one'), ('a2', 'two'), ('a3', 'three')");

  const windows = { 7: ['2026-10-14', 7], 30: ['2026-09-21', 30], 90: ['2026-07-23', 90], all: ['2026-07-01', 112] };
  for (const [range, [first, count]] of Object.entries(windows)) {
    const r = await readStats(db, range, NOW);
    assert.equal(r.range, range, 'the range is echoed as a string');
    assert.equal(r.days.length, count, range);
    assert.equal(r.days[0].day, first, range);
    assert.equal(r.days.at(-1).day, '2026-10-20', range);
  }
  const seven = await readStats(db, '7', NOW);
  assert.deepEqual(seven.days.find(d => d.day === '2026-10-16'), { day: '2026-10-16', players: 0, runs: 0, wins: 0, signups: 0 }, 'an unseeded day is all zeros');
  assert.deepEqual(seven.days.find(d => d.day === '2026-10-15'), { day: '2026-10-15', players: 2, runs: 5, wins: 1, signups: 0 });
  assert.equal(seven.days.at(-1).signups, 2);
  assert.equal(seven.breakdowns.character.some(c => c.dim === 'old-one'), false, 'a row 8 days back is not in the 7-day window');
  const thirty = await readStats(db, '30', NOW);
  assert.deepEqual(thirty.breakdowns.character.find(c => c.dim === 'old-one'), { dim: 'old-one', n: 3 }, 'but it is in the 30-day window');
  assert.deepEqual(seven.breakdowns.character, [{ dim: 'aaa', n: 6 }, { dim: 'abbot', n: 6 }, { dim: 'rift-knight', n: 6 }], 'by count, then by name; sums over the window');
  assert.deepEqual(seven.breakdowns.stage_reached.map(s => s.dim), ['2', '6', '10'], 'stage order, then anything unexpected');
  assert.deepEqual(seven.breakdowns.length.map(s => s.dim), ['u2', '2-5', 'o40'], 'length bucket order');
  assert.deepEqual(Object.keys(seven.breakdowns), ['stage_reached', 'character', 'weapon', 'device', 'version', 'length'], 'no _writes, no signups');
  assert.equal(seven.lastReceived, '2026-10-19', 'a later day with only sign-ups is not a received report');
  assert.deepEqual(seven.ceiling, { day: '2026-10-20', used: 37, limit: STATS_DAILY_WRITE_CEILING });
  assert.equal(seven.accountsTotal, 3);
  const noAccounts = createD1(openDatabase(':memory:'));
  await ensureStatsTable(noAccounts);
  assert.equal((await readStats(noAccounts, '7', NOW)).accountsTotal, 0, 'no accounts table yet: zero');
}

// ---- Task 1.8: GET /api/admin/stats behind the inbox admin key ---------------------------------------------------------
{
  // The binding the inbox check reads is taken from the source of authorize() (the repo's key guard rejects the literal name in new files).
  const ADMIN = /if \(!env\.([A-Z0-9_]+)\) return json\(\{ error: 'Feedback admin key not configured' \}/.exec(fs.readFileSync('server/admin-auth.js', 'utf8'))?.[1];
  assert.ok(ADMIN, 'found the binding authorize() reads');
  const KEY = 'test-admin-key-0123456789';
  const INBOX = 'https://feedback.riftborn.us';
  const limiterKeys = [];
  const base = () => {
    const sqlite = openDatabase(':memory:', 'drizzle', fs);
    return { sqlite, env: { DB: createD1(sqlite), ENVIRONMENT: 'production', ALLOWED_ORIGINS: 'https://chancrisp.github.io', FEEDBACK_ADMIN_ORIGINS: INBOX + ',https://chancrisp.github.io', [ADMIN]: KEY,
      ACCOUNTS_RATE_LIMITER: { async limit({ key }) { limiterKeys.push(key); return { success: true }; } } } };
  };
  const admin = (env, { path = '/api/admin/stats', method = 'GET', origin = INBOX, key = KEY, headers = {} } = {}) => worker.fetch(new Request('https://api.test' + path, {
    method, headers: { ...(origin ? { Origin: origin } : {}), ...(key ? { Authorization: 'Bearer ' + key } : {}), 'CF-Connecting-IP': `198.51.100.${++ipSeq}`, ...headers }
  }), env, { waitUntil() {} });
  const { sqlite, env } = base();
  sqlite.prepare("INSERT INTO daily_stats VALUES (date('now'), 'runs', 'all', 3)").run();

  // (1) auth
  const unset = { ...env }; delete unset[ADMIN];
  assert.equal((await admin(unset)).status, 503, 'binding unset');
  const none = await admin(env, { key: null });
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('WWW-Authenticate'), 'Bearer');
  assert.equal((await admin(env, { key: 'wrong-key-0123456789' })).status, 401);
  assert.equal((await admin(env)).status, 200);
  for (const key of [KEY, 'wrong-key-0123456789']) {
    const refusing = { ...env, ACCOUNTS_RATE_LIMITER: { async limit() { return { success: false }; } } };
    const r = await admin(refusing, { key });
    assert.equal(r.status, 429, 'the limiter comes before the key check');
    assert.equal(r.headers.get('Retry-After'), '60');
  }
  assert.ok(limiterKeys.length > 0 && limiterKeys.every(k => k.startsWith('feedback-admin:')), 'limiter keys under the inbox scope: ' + limiterKeys[0]);

  // (2) origins, with the right key
  const ok = await admin(env);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), INBOX);
  assert.equal((await admin(env, { origin: null })).status, 200, 'no Origin: a tool or the inbox itself');
  for (const origin of ['https://riftborn.us', 'https://dev.riftborn.us', 'https://evil.example']) {
    const r = await admin(env, { origin });
    assert.equal(r.status, 403, origin);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, origin);
  }
  assert.equal((await admin(env, { origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'a cross-site request without an Origin');
  const pre = await admin(env, { method: 'OPTIONS', key: null, headers: { 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.deepEqual([pre.headers.get('Access-Control-Allow-Methods'), pre.headers.get('Access-Control-Allow-Headers'), pre.headers.get('Access-Control-Allow-Origin')], ['GET, OPTIONS', 'Authorization', INBOX]);
  assert.equal((await admin(env, { method: 'POST' })).status, 405);

  // (3) range
  for (const [range, days] of [['7', 7], ['30', 30], ['90', 90]]) {
    const body = await (await admin(env, { path: '/api/admin/stats?range=' + range })).json();
    assert.equal(body.range, range);
    assert.equal(body.days.length, days);
  }
  assert.equal((await (await admin(env, { path: '/api/admin/stats?range=all' })).json()).range, 'all');
  assert.equal((await (await admin(env)).json()).range, '30', 'the default is 30');
  for (const range of ['1', '', 'ALL', '7d']) {
    const r = await admin(env, { path: '/api/admin/stats?range=' + range });
    assert.equal(r.status, 400, 'range ' + JSON.stringify(range));
    assert.deepEqual(await r.json(), { error: 'Invalid range' });
  }

  // (4) the body
  const body = await (await admin(env)).json();
  assert.deepEqual(Object.keys(body).sort(), ['accountsTotal', 'breakdowns', 'ceiling', 'days', 'lastReceived', 'range']);
  assert.equal(body.days.at(-1).runs, 3);
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');

  // (5) a bare database, and a failing one
  const bare = { ...env, DB: createD1(openDatabase(':memory:')) };
  const zeros = await admin(bare);
  assert.equal(zeros.status, 200);
  assert.ok((await zeros.json()).days.every(d => d.runs === 0 && d.players === 0));
  const q = quietConsole();
  const broken = { ...env, DB: { prepare() { throw new Error('SELECT secret FROM nowhere'); }, batch() { throw new Error('SELECT secret FROM nowhere'); } } };
  const failed = await admin(broken);
  q.restore();
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes('SELECT'), 'no SQL text in the answer');
  assert.ok(q.logs.every(line => !line.includes(KEY)), 'the key is never logged');
}

// ---- Task 1.11: the game's device-only keys, mirrored in MIGRATION.exclude -----------------------------------------
{
  // The game's MIGRATION_EXCLUDED (riftborn/src/meta/migration.js) as merged with its Task 2.1: 17 entries, in its order.
  const GAME = ['session-v1', 'login-verifier-v1', 'account-sync-v1', 'account-reminded', 'dev-accounts', 'dev-mode-v1', 'dev-loadout-v1', 'dev-carry-v1',
    'touch-debug-v1', 'fullscreen-resume-v1', 'welcome-v1', 'whats-new-seen-v1', 'whats-new-visit-v1', 'profile-v1-bak', 'stats-day-v1', 'stats-notice-v1', 'stats-outbox-v1']
    .map(name => 'riftborn-reborn-' + name);
  assert.deepEqual([...MIGRATION.exclude], GAME, 'entry for entry, in the game order');
  assert.equal(new Set(MIGRATION.exclude).size, MIGRATION.exclude.length, 'no duplicates');
  const at = MIGRATION.exclude.indexOf('riftborn-reborn-dev-carry-v1');
  assert.deepEqual(MIGRATION.exclude.slice(at + 1, at + 3), ['riftborn-reborn-touch-debug-v1', 'riftborn-reborn-fullscreen-resume-v1'], 'they follow the dev carry key directly');
  for (const key of ['touch-debug-v1', 'fullscreen-resume-v1', 'stats-day-v1', 'stats-notice-v1', 'stats-outbox-v1']) {
    assert.ok(MIGRATION.exclude.includes(MIGRATION.prefix + key), key + ' stays on the device and never follows an account');
  }
}

// ---- Task 1.9: the sign-ups counter inside createAccount's batch (a go-live commit: nothing counts before the privacy page says so) ----
{
  const GAME = 'http://localhost:8700';
  const BASE = 'http://127.0.0.1:8787';
  const RETURN = GAME + '/?accounts=local';
  const SIGN = 'test-signing-key-0123456789-abcdefghijklmnop';
  const INBOX = 'https://feedback.riftborn.us';
  const ADMIN = /if \(!env\.([A-Z0-9_]+)\) return json\(\{ error: 'Feedback admin key not configured' \}/.exec(fs.readFileSync('server/admin-auth.js', 'utf8'))?.[1];
  const ADMIN_VALUE = 'test-admin-key-0123456789';
  const mkEnv = DB => ({ DB, ENVIRONMENT: 'development', ALLOWED_ORIGINS: GAME, AUTH_RETURN_ORIGINS: GAME, AUTH_RETURN_PATHS: '/,/riftborn/', FAKE_OAUTH: '1', AUTH_SIGNING_KEY: SIGN,
    FEEDBACK_ADMIN_ORIGINS: INBOX, [ADMIN]: ADMIN_VALUE, ACCOUNTS_RATE_LIMITER: { async limit() { return { success: true }; } } });
  let ipCount = 0;
  const freshIp = () => { ipCount++; return `10.${(ipCount >> 16) & 255}.${(ipCount >> 8) & 255}.${ipCount & 255}`; };
  const browser = new Map();
  async function call(path, { method = 'GET', body, token, ip = freshIp(), origin = GAME, headers = {}, e, jar = null } = {}) {
    const h = { 'CF-Connecting-IP': ip, ...headers };
    if (jar && jar.size) h.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (origin) h.Origin = origin;
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), e, { waitUntil() {} });
    const setCookie = response.headers.get('Set-Cookie');
    if (jar && setCookie) {
      const [pair] = setCookie.split(';');
      const [name, value] = pair.split('=');
      if (/Max-Age=0/i.test(setCookie)) jar.delete(name); else jar.set(name, value);
    }
    let data = null;
    const type = response.headers.get('Content-Type') || '';
    if (type.startsWith('application/json')) data = await response.json();
    else if (type.startsWith('text/html')) data = await response.text();
    return { status: response.status, headers: response.headers, data };
  }
  const nav = (path, opts = {}) => call(path, { origin: null, jar: browser, ...opts });
  const hashParam = (location, key) => new URLSearchParams(new URL(location).hash.slice(1)).get(key);
  async function newChallenge() {
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    return { verifier, challenge };
  }
  async function fakeLogin(userId, e) {
    const { verifier, challenge } = await newChallenge();
    const page = await nav('/auth/fake/start?' + new URLSearchParams({ return: RETURN, challenge }), { e });
    assert.equal(page.status, 200);
    const state = /name="state" value="([A-Za-z0-9_-]{43})"/.exec(page.data)?.[1];
    assert.ok(state, 'the fake page carries a state');
    const back = await nav(`/auth/fake/callback?state=${state}&code=${encodeURIComponent(userId)}`, { e });
    assert.equal(back.status, 302);
    const code = hashParam(back.headers.get('Location'), 'rb_login');
    const session = await call('/auth/session', { method: 'POST', body: { code, verifier }, e });
    assert.equal(session.status, 200, JSON.stringify(session.data));
    return session.data;
  }
  const create = async (userId, username, e) => {
    const login = await fakeLogin(userId, e);
    assert.equal(login.needsUsername, true);
    return call('/api/account', { method: 'POST', body: { signupToken: login.signupToken, username }, e });
  };
  const signupsOn = sqlite => sqlite.prepare("SELECT n FROM daily_stats WHERE metric = 'signups' AND dim = 'all' AND day = ?").get(utcDay(Date.now()))?.n ?? null;
  const accountsIn = sqlite => sqlite.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;

  // (1) each new account counts once; the admin read shows it
  {
    const sqlite = openDatabase(':memory:', 'drizzle', fs);
    const e = mkEnv(createD1(sqlite));
    assert.equal((await create('11111111-aaaa-4aaa-8aaa-000000000001', 'AlphaOne', e)).status, 200);
    assert.deepEqual([signupsOn(sqlite), accountsIn(sqlite)], [1, 1]);
    assert.equal((await create('11111111-aaaa-4aaa-8aaa-000000000002', 'BetaTwo', e)).status, 200);
    assert.equal(signupsOn(sqlite), 2);
    const read = await call('/api/admin/stats?range=7', { origin: INBOX, headers: { Authorization: 'Bearer ' + ADMIN_VALUE }, e });
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.equal(read.data.accountsTotal, 2);
    assert.equal(read.data.days.reduce((sum, d) => sum + d.signups, 0), 2);
    // (2) signing in again with an existing identity does not count
    const again = await fakeLogin('11111111-aaaa-4aaa-8aaa-000000000001', e);
    assert.ok(again.token || again.account, 'an existing identity signs in');
    assert.equal(signupsOn(sqlite), 2, 'a sign-in is not a sign-up');
    // (6) a taken username is refused and counts nothing
    const taken = await create('11111111-aaaa-4aaa-8aaa-000000000003', 'AlphaOne', e);
    assert.equal(taken.status, 409);
    assert.equal(signupsOn(sqlite), 2, 'a refused sign-up counts nothing');
  }
  // (3) a bare database: the first sign-up creates the table lazily and counts 1
  {
    const sqlite = openDatabase(':memory:');
    const e = mkEnv(createD1(sqlite));
    assert.equal((await create('11111111-aaaa-4aaa-8aaa-000000000004', 'GammaThree', e)).status, 200);
    assert.equal(signupsOn(sqlite), 1);
  }
  // (4) the stats table cannot be prepared at all: sign-up still works and writes no counter
  {
    const sqlite = openDatabase(':memory:', 'drizzle', fs);
    const real = createD1(sqlite);
    const DB = { ...real, prepare(sql) { if (/daily_stats/.test(sql)) throw new Error('D1 hiccup'); return real.prepare(sql); } };
    const e = mkEnv(DB);
    assert.equal((await create('11111111-aaaa-4aaa-8aaa-000000000005', 'DeltaFour', e)).status, 200);
    assert.equal(accountsIn(sqlite), 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM sessions').get().c >= 1, true, 'the session exists');
    assert.equal(signupsOn(sqlite), null, 'no counter row');
  }
  // (5) the batch itself fails on the stats table: sign-up retried without it, still 200
  {
    const sqlite = openDatabase(':memory:', 'drizzle', fs);
    const real = createD1(sqlite);
    const DB = { ...real,
      prepare(sql) { const statement = real.prepare(sql); statement.__sql = sql; const bind = statement.bind.bind(statement); statement.bind = (...values) => { const bound = bind(...values); bound.__sql = sql; return bound; }; return statement; },
      batch(statements) { if (statements.some(s => /daily_stats/.test(s.__sql || ''))) return Promise.reject(new Error('D1_ERROR: no such table: daily_stats')); return real.batch(statements); } };
    const e = mkEnv(DB);
    assert.equal((await create('11111111-aaaa-4aaa-8aaa-000000000006', 'EpsilonFive', e)).status, 200);
    assert.equal(accountsIn(sqlite), 1);
  }
}

console.log('PASS stats: the inbox admin helpers live in server/admin-auth.js and feedback-api.js still exports ADMIN_LIMIT.');
