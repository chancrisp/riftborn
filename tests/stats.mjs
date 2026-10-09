// Player metrics on the leaderboard Worker (server/stats-api.js, server/stats-counters.js, server/admin-auth.js):
// anonymous run reports into one-dimensional daily counters with a daily write ceiling, the sign-ups counter,
// and the admin read behind the inbox's admin key. Local only: an in-memory SQLite database stands in for D1.
// The last line of this file is the PASS line; later tasks add their blocks above it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as auth from '../server/admin-auth.js';
import * as feedback from '../server/feedback-api.js';
import { createD1, openDatabase } from '../server/d1-sqlite.mjs';
import { DIM_PATTERN, STATS_BODY_MAX, STATS_METRICS, reportRows, validateReport } from '../server/stats-api.js';
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

console.log('PASS stats: the inbox admin helpers live in server/admin-auth.js and feedback-api.js still exports ADMIN_LIMIT.');
