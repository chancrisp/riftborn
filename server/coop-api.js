// The co-op relay's HTTP face on the leaderboard Worker (Task 5.2): who may open a room, how fast, and the hand-off into the
// CoopRoom Durable Object (server/coop-room.js). Every answer is JSON with Cache-Control: no-store and Vary: Origin; CORS is
// offered to co-op origins only. No token is ever echoed, and no address is stored (the rate limit key is a keyed hash, as for
// scores and stats; the raw address only when the Worker holds no signing key).
//   OPTIONS *                       the preflight (co-op origins)
//   POST /coop/rooms { build, proto }   opens a room -> 201 { code }
//   GET  /coop/rooms/:code/ws          the WebSocket upgrade, forwarded to the room unchanged
//   GET  /coop/board                   the Expedition board -> { rows, me } (co-op origins only; me from the Bearer token)
// The ranked runs live in the coop_runs table of the Worker's D1 database (created lazily, like the other tables; drizzle 0007 mirrors it).
import { HOSTS } from '../site.hosts.mjs';
import { ipLimitKey, ipSubject, scoreAccounts } from './accounts-api.js';
import { readBodyCapped } from './stats-api.js';
import { utcDay } from './stats-counters.js';
import { randomCode, validCode } from './coop/protocol.js';

/** A create request is refused above this many bytes (the real one is about 40). */
export const COOP_CREATE_BODY_MAX = 512;
/** A busy code is redrawn this many times before the create gives up. */
export const COOP_CREATE_TRIES = 5;

const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.riftborn-dev\.pages\.dev$/;
/** The board a run is ranked on (the room's config.stamp), and how many rows it shows. */
export const COOP_STAMP = 'expedition-1';
export const COOP_BOARD_ROWS = 50;

// The preflight allows Authorization: the board reads the player's sign-in token to pin their own row.
const PREFLIGHT = Object.freeze({ 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' });

/**
 * The ranked runs. The production database is out of reach of migrations, so the table is created on first use (as the accounts,
 * feedback and daily_stats tables are); drizzle/0007_coop_runs.sql and db/schema.ts mirror it for previews and tests.
 * A row is one cleared run by two signed-in players; the names are as they were then (the board shows the accounts' current ones).
 */
export const COOP_SCHEMA = Object.freeze([
  'CREATE TABLE IF NOT EXISTS coop_runs (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, version TEXT NOT NULL, stamp TEXT NOT NULL, world INTEGER NOT NULL, seed INTEGER NOT NULL, clear_ms INTEGER NOT NULL, kills INTEGER NOT NULL, a_account TEXT NOT NULL, a_name TEXT NOT NULL, b_account TEXT NOT NULL, b_name TEXT NOT NULL, room TEXT NOT NULL, hash TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS coop_runs_board ON coop_runs (stamp, clear_ms, kills)'
]);

const tablesReady = new WeakMap(); // DB binding -> Promise, once per isolate

/** Creates the coop_runs table and its index if they are not there yet (once per DB binding; a failed bootstrap retries next time). */
export function ensureCoopTables(db) {
  let promise = tablesReady.get(db);
  if (!promise) {
    promise = (async () => {
      if (typeof db.batch === 'function') await db.batch(COOP_SCHEMA.map(sql => db.prepare(sql)));
      else for (const sql of COOP_SCHEMA) await db.prepare(sql).run();
    })();
    tablesReady.set(db, promise);
    promise.catch(() => tablesReady.delete(db));
  }
  return promise;
}

const INSERT_RUN = 'INSERT INTO coop_runs (created_at, version, stamp, world, seed, clear_ms, kills, a_account, a_name, b_account, b_name, room, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/**
 * Writes a cleared run to the board. `row` is the room core's board row: { code, build, stamp, world, seed, clearMs, kills,
 * a: { accountId, username }, b: { accountId, username }, hash }. Never throws: -> { ok: true } or { ok: false, reason: 'unavailable' }.
 */
export async function insertCoopRun(env, row) {
  try {
    if (!env?.DB) return { ok: false, reason: 'unavailable' };
    await ensureCoopTables(env.DB);
    await env.DB.prepare(INSERT_RUN)
      .bind(Date.now(), row.build, row.stamp, row.world, row.seed, row.clearMs, row.kills, row.a.accountId, row.a.username, row.b.accountId, row.b.username, row.code, row.hash)
      .run();
    return { ok: true };
  } catch (error) {
    console.error('Coop run write failed', error?.message || 'unknown error');
    return { ok: false, reason: 'unavailable' };
  }
}

// The best time first, then the most kills, then the older run.
const BOARD_ORDER = 'r.clear_ms ASC, r.kills DESC, r.id ASC';
const BOARD_COLUMNS = 'r.id AS id, r.world AS world, r.clear_ms AS clear_ms, r.kills AS kills, r.created_at AS created_at';

/**
 * The Expedition board: { rows, me }. rows are the top 50 as { rank, a, b, world, clearMs, kills, date }, a and b being the accounts'
 * current usernames (joined at read time, as the score boards do, so a rename reaches old runs; a deleted account keeps the name
 * stored with its run). me is the account's best row with its real rank (it can be below the 50), or null. No account id is returned.
 * Throws when the database cannot be read; the route answers 503.
 */
export async function coopBoard(env, accountId) {
  const db = env.DB;
  await ensureCoopTables(db);
  const joined = await scoreAccounts.ready(env);
  const select = joined
    ? `SELECT ${BOARD_COLUMNS}, COALESCE(x.username, r.a_name) AS a, COALESCE(y.username, r.b_name) AS b FROM coop_runs r LEFT JOIN accounts x ON x.id = r.a_account LEFT JOIN accounts y ON y.id = r.b_account`
    : `SELECT ${BOARD_COLUMNS}, r.a_name AS a, r.b_name AS b FROM coop_runs r`;
  const shown = (row, rank) => ({ rank, a: row.a, b: row.b, world: row.world, clearMs: row.clear_ms, kills: row.kills, date: utcDay(row.created_at) });
  const top = await db.prepare(`${select} WHERE r.stamp = ? ORDER BY ${BOARD_ORDER} LIMIT ${COOP_BOARD_ROWS}`).bind(COOP_STAMP).all();
  const rows = top.results.map((row, i) => shown(row, i + 1));
  let me = null;
  if (typeof accountId === 'string' && accountId) {
    const best = await db.prepare(`${select} WHERE r.stamp = ? AND (r.a_account = ? OR r.b_account = ?) ORDER BY ${BOARD_ORDER} LIMIT 1`).bind(COOP_STAMP, accountId, accountId).first();
    if (best) {
      const ahead = await db.prepare('SELECT COUNT(*) AS n FROM coop_runs WHERE stamp = ? AND (clear_ms < ? OR (clear_ms = ? AND (kills > ? OR (kills = ? AND id < ?))))')
        .bind(COOP_STAMP, best.clear_ms, best.clear_ms, best.kills, best.kills, best.id).first();
      me = shown(best, Number(ahead?.n ?? 0) + 1);
    }
  }
  return { rows, me };
}

/**
 * Which kind of page this Origin is: 'live' (riftborn.us), 'test' (dev.riftborn.us and the branch previews of riftborn-dev), or
 * null (anything else, and no Origin at all). Only a 'live' page in the production Worker makes a live room.
 */
export function coopOrigin(origin) {
  if (typeof origin !== 'string') return null;
  if (origin === HOSTS.live) return 'live';
  if (origin === HOSTS.dev || PREVIEW_ORIGIN.test(origin)) return 'test';
  return null;
}

function reply(value, status, origin, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin',
      ...(coopOrigin(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
      ...extra
    }
  });
}

/** An unbiased integer below n from the runtime's random source (rejection sampling on a byte). */
function randomInt(n) {
  const limit = 256 - (256 % n);
  const byte = new Uint8Array(1);
  do crypto.getRandomValues(byte); while (byte[0] >= limit);
  return byte[0] % n;
}

// The room's own answer to a non-upgrade request, given the standard headers. A 101 (the socket) is handed back untouched.
async function relayed(response, origin) {
  if (response.status === 101) return response;
  let value;
  try { value = await response.json(); } catch { value = { error: 'unavailable' }; }
  return reply(value, response.status, origin);
}

async function createRoom(request, env, origin, kind) {
  if (!env.COOP_ROOM || !env.COOP_RATE_LIMITER || typeof env.COOP_RATE_LIMITER.limit !== 'function') return reply({ error: 'unavailable' }, 503, origin);
  // Without a signing key the key is the sender's network (IPv6 by its /64, as the hashed key is), not the full address.
  let limited;
  try {
    const key = (await ipLimitKey(request, env, 'coop')) || ipSubject(request.headers.get('CF-Connecting-IP'));
    limited = (await env.COOP_RATE_LIMITER.limit({ key })).success === false;
  } catch (error) {
    console.error('Coop rate limit failed', error?.message || 'unknown error');
    return reply({ error: 'unavailable' }, 503, origin);
  }
  if (limited) return reply({ error: 'rate_limited' }, 429, origin, { 'Retry-After': '60', 'Access-Control-Expose-Headers': 'Retry-After' });
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return reply({ error: 'bad_shape' }, 400, origin);
  const body = await readBodyCapped(request, COOP_CREATE_BODY_MAX);
  if (body.tooLarge) return reply({ error: 'too_large' }, 413, origin);
  let payload;
  try { payload = JSON.parse(body.text); } catch { return reply({ error: 'bad_json' }, 400, origin); }
  const ok = payload && typeof payload === 'object' && typeof payload.build === 'string' && payload.build.length >= 1 && payload.build.length <= 40 && Number.isSafeInteger(payload.proto);
  if (!ok) return reply({ error: 'bad_shape' }, 400, origin);
  const live = kind === 'live' && env.ENVIRONMENT === 'production';
  for (let attempt = 0; attempt < COOP_CREATE_TRIES; attempt++) {
    const code = randomCode(randomInt);
    const stub = env.COOP_ROOM.get(env.COOP_ROOM.idFromName('room:' + code));
    let made;
    try {
      made = await stub.fetch('https://coop-room/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, build: payload.build, proto: payload.proto, live })
      });
    } catch (error) {
      console.error('Coop create failed', error?.message || 'unknown error');
      return reply({ error: 'unavailable' }, 503, origin);
    }
    if (made.status === 409) continue;
    if (made.status === 400) return reply({ error: 'bad_shape' }, 400, origin);
    if (!made.ok) return reply({ error: 'unavailable' }, 503, origin);
    return reply({ code }, 201, origin);
  }
  return reply({ error: 'busy' }, 503, origin, { 'Retry-After': '1', 'Access-Control-Expose-Headers': 'Retry-After' });
}

async function openSocket(request, env, origin, code) {
  if (!validCode(code)) return reply({ error: 'bad_code' }, 400, origin);
  if (!coopOrigin(origin)) return reply({ error: 'forbidden_origin' }, 403, null);
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return reply({ error: 'upgrade_required' }, 426, origin, { Upgrade: 'websocket' });
  if (!env.COOP_ROOM) return reply({ error: 'unavailable' }, 503, origin);
  try {
    return await relayed(await env.COOP_ROOM.get(env.COOP_ROOM.idFromName('room:' + code)).fetch(request), origin);
  } catch (error) {
    console.error('Coop upgrade failed', error?.message || 'unknown error');
    return reply({ error: 'unavailable' }, 503, origin);
  }
}

// GET /coop/board: the rows, and the signed-in player's own row. A missing, bad or unverifiable token only means `me` is null.
async function boardAnswer(request, env, origin) {
  if (!env.DB) return reply({ error: 'unavailable' }, 503, origin);
  try {
    const session = await scoreAccounts.session(request, env);
    const accountId = session && !session.unauthorized && !session.unavailable && typeof session.id === 'string' ? session.id : null;
    return reply(await coopBoard(env, accountId), 200, origin);
  } catch (error) {
    console.error('Coop board failed', error?.message || 'unknown error');
    return reply({ error: 'unavailable' }, 503, origin);
  }
}

/** The /coop/ routes. -> a Response, or null when the path is not ours. */
export async function handleCoop(request, env, ctx) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/coop/')) return null;
  const origin = request.headers.get('Origin');
  const kind = coopOrigin(origin);
  const socket = url.pathname.match(/^\/coop\/rooms\/([^/]+)\/ws$/);
  const route = url.pathname === '/coop/rooms' ? 'rooms' : socket ? 'ws' : url.pathname === '/coop/board' ? 'board' : null;
  if (!route) return reply({ error: 'not_found' }, 404, origin);
  if (request.method === 'OPTIONS') {
    if (!kind) return reply({ error: 'forbidden_origin' }, 403, null);
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Cache-Control': 'no-store', ...PREFLIGHT } });
  }
  if (route === 'board') {
    if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405, origin, { Allow: 'GET, OPTIONS' });
    if (!kind) return reply({ error: 'forbidden_origin' }, 403, null);
    return boardAnswer(request, env, origin);
  }
  if (route === 'rooms') {
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, origin, { Allow: 'POST, OPTIONS' });
    if (!kind) return reply({ error: 'forbidden_origin' }, 403, null);
    return createRoom(request, env, origin, kind);
  }
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405, origin, { Allow: 'GET, OPTIONS' });
  return openSocket(request, env, origin, socket[1]);
}
