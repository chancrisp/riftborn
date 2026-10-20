// The CoopRoom Durable Object (server/coop-room.js): the game's shared room core behind the WebSocket Hibernation API.
// Local only: a fake `ctx` (storage with an alarm, acceptWebSocket, getWebSockets) and fake sockets stand in for the Workers runtime.
//   - the two shared files equal the game's; two sockets join, start and relay commands; a rebuilt room keeps its lobby;
//   - the alarm closes an expired lobby and frees the code; an upgrade into a room never created is a 404; a second create is a 409;
//   - a started room rebuilt after an eviction answers closed (error); a signed-in seat and the ranking go through coopDeps;
//   - the real session check, the coop_runs ranking and the CO-OP board (Task 5.3), on an in-memory SQLite stand-in for D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CoopRoom, coopDeps } from '../server/coop-room.js';
import worker from '../cloudflare/worker.js';
import { handleCoop, coopOrigin, insertCoopRun, coopBoard, ensureCoopTables } from '../server/coop-api.js';
import { ensureAccountTables, nameSkeleton, randomToken, scoreAccounts, sessionHash } from '../server/accounts-api.js';
import { createD1, openDatabase } from '../server/d1-sqlite.mjs';
import { PROTOCOL_VERSION, validCode } from '../server/coop/protocol.js';
import { HELLO_MS, LOBBY_MS } from '../server/coop/room-core.js';

// ---- the shared files ----------------------------------------------------------------------------------------------
// Compared when the game source is found: COOP_GAME_SRC (the game's src/net folder) or ../riftborn/src/net next to this repo;
// skipped otherwise (CI). Line endings are normalised first, so a CRLF checkout on one side does not count as a change.
const gameNet = process.env.COOP_GAME_SRC ? new URL(`file:///${process.env.COOP_GAME_SRC.replace(/\\/g, '/').replace(/\/?$/, '/')}`) : new URL('../../riftborn/src/net/', import.meta.url);
const text = url => fs.readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
if (fs.existsSync(new URL('room-core.js', gameNet)) && fs.existsSync(new URL('protocol.js', gameNet))) {
  for (const name of ['room-core.js', 'protocol.js']) {
    assert.equal(text(new URL(`../server/coop/${name}`, import.meta.url)), text(new URL(name, gameNet)), `server/coop/${name} differs from the game's src/net/${name}: copy the game file over it unchanged`);
  }
  console.log("PASS coop-room: the shared files equal the game's.");
} else {
  console.log('SKIP coop-room: shared file comparison: the game source (src/net) was not found (set COOP_GAME_SRC).');
}

// ---- the fakes -----------------------------------------------------------------------------------------------------
const BUILD = 'b1';
const CODE = 'ABCD23';
const clock = { t: 1000000 };
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

const DEFAULT_DEPS = { sessionForToken: coopDeps.sessionForToken, rank: coopDeps.rank };

// The runtime pieces that do not exist in node: the clock, the socket pair and the 101 response.
coopDeps.now = () => clock.t;
coopDeps.socketPair = () => {
  const server = fakeSocket();
  return { client: { peer: server }, server };
};
coopDeps.upgradeResponse = client => ({ status: 101, webSocket: client });

function fakeSocket() {
  let attachment = null;
  return {
    sent: [],
    closed: null,
    send(data) {
      if (this.closed) throw new Error('the socket is closed');
      this.sent.push(JSON.parse(data));
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
    serializeAttachment(value) {
      attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return structuredClone(attachment);
    },
    // The messages heard since the last take.
    take() {
      return this.sent.splice(0);
    },
  };
}

function fakeCtx() {
  const data = new Map();
  const sockets = [];
  const ctx = {
    data,
    puts: 0,
    alarm: null,
    storage: {
      async get(key) {
        if (Array.isArray(key)) return new Map(key.filter(k => data.has(k)).map(k => [k, structuredClone(data.get(k))]));
        return data.has(key) ? structuredClone(data.get(key)) : undefined;
      },
      async put(key, value) {
        ctx.puts++;
        if (typeof key === 'string') data.set(key, structuredClone(value));
        else for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v));
      },
      async deleteAll() {
        data.clear();
      },
      async setAlarm(at) {
        ctx.alarm = at;
      },
      async getAlarm() {
        return ctx.alarm;
      },
      async deleteAlarm() {
        ctx.alarm = null;
      },
    },
    acceptWebSocket(ws) {
      sockets.push(ws);
    },
    getWebSockets() {
      return sockets.filter(ws => !ws.closed);
    },
    blockConcurrencyWhile: fn => fn(),
    waitUntil() {},
  };
  return ctx;
}

const create = (room, body = { code: CODE, build: BUILD, proto: PROTOCOL_VERSION, live: false }) =>
  room.fetch(new Request('https://room/create', { method: 'POST', body: JSON.stringify(body) }));
const upgrade = room => room.fetch(new Request('https://room/ws', { headers: { Upgrade: 'websocket' } }));
const connect = async room => {
  const res = await upgrade(room);
  assert.equal(res.status, 101);
  return res.webSocket.peer;
};
const say = (room, ws, msg) => room.webSocketMessage(ws, JSON.stringify(msg));
const types = ws => ws.take().map(m => m.type);

const hello = (name, extra = {}) => ({ type: 'hello', proto: PROTOCOL_VERSION, build: BUILD, name, ...extra });
const lobbyOf = (loadout, look, ready, ping = 5) => ({ type: 'lobby', loadout, look, ready, ping });
const HOST = lobbyOf(['rift-pistol', 'arc-lance'], 'default', true);
const GUEST = lobbyOf(['scatter', 'nova-ring'], 'ember-2', true);
const config = () => ({
  kind: 'expedition',
  proto: PROTOCOL_VERSION,
  build: BUILD,
  stamp: 'expedition-1',
  lockstep: true,
  seed: 123456789,
  world: 3,
  heroes: [
    { seat: 0, name: 'Host', loadout: ['rift-pistol', 'arc-lance'], look: 'default' },
    { seat: 1, name: 'Guest', loadout: ['scatter', 'nova-ring'], look: 'ember-2' },
  ],
});
const cmd = (t, count) => ({ type: 'cmd', t, n: t + count - 1, c: Array.from({ length: count }, () => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) });

// A created room with the host and the guest connected and ready (not started).
async function lobbyRoom(extra = {}, helloExtra = [{}, {}]) {
  const ctx = fakeCtx();
  const room = new CoopRoom(ctx, {});
  assert.equal((await create(room, { code: CODE, build: BUILD, proto: PROTOCOL_VERSION, live: false, ...extra })).status, 200);
  const a = await connect(room);
  const b = await connect(room);
  await say(room, a, hello('Host', helloExtra[0]));
  await say(room, b, hello('Guest', helloExtra[1]));
  await say(room, a, HOST);
  await say(room, b, GUEST);
  a.take();
  b.take();
  return { ctx, room, a, b };
}

// ---- two sockets join, start and relay commands ----------------------------------------------------------------------
{
  const ctx = fakeCtx();
  const room = new CoopRoom(ctx, {});
  assert.equal((await create(room)).status, 200);
  assert.equal(ctx.alarm, clock.t + LOBBY_MS, 'the lobby timer is the first alarm');
  assert.equal(ctx.data.get('meta').build, BUILD);

  const a = await connect(room);
  const b = await connect(room);
  assert.equal(ctx.alarm, clock.t + HELLO_MS, 'two sockets that have not said hello bring the alarm forward');
  await say(room, a, hello('Host'));
  await say(room, b, hello('Guest'));
  const welcomeA = a.take()[0];
  const welcomeB = b.take()[0];
  assert.deepEqual([welcomeA.type, welcomeA.seat, welcomeB.seat], ['welcome', 0, 1]);
  assert.match(welcomeA.secret, /^[A-Za-z0-9_-]{22}$/, '16 random bytes, base64url');
  assert.notEqual(welcomeA.secret, welcomeB.secret);
  assert.equal(a.deserializeAttachment().seat, 0, 'the seat is kept in the socket attachment');
  assert.equal(ctx.data.get('room').seats[1].secret, welcomeB.secret, 'the seats are saved');

  await say(room, a, HOST);
  await say(room, b, GUEST);
  assert.deepEqual(types(a), ['peer']);
  assert.deepEqual(types(b), ['peer']);
  await say(room, a, { type: 'config', config: config() });
  assert.deepEqual(types(b), ['config', 'start']);
  assert.deepEqual(types(a), ['start']);
  assert.equal(ctx.data.get('room').started, true, 'a start is saved');
  assert.equal(ctx.alarm, clock.t + 30000, 'the next alarm is the seat timeout');

  // Commands go to the partner and are not saved; neither are hashes and pings.
  const puts = ctx.puts;
  await say(room, a, cmd(0, 3));
  await say(room, a, { type: 'hash', t: 0, h: 7 });
  await say(room, a, { type: 'ping', id: 9 });
  assert.deepEqual(b.take(), [{ type: 'cmd', t: 0, n: 2, c: cmd(0, 3).c }]);
  assert.deepEqual(a.take(), [{ type: 'pong', id: 9 }]);
  assert.equal(ctx.puts, puts, 'cmd, hash and ping save nothing');
  await say(room, b, cmd(0, 1));
  assert.deepEqual(a.take().map(m => m.t), [0]);
  assert.equal(ctx.puts, puts);
  await say(room, a, { type: 'leave' });
  assert.ok(ctx.puts > puts, 'any other message saves the room');
  assert.deepEqual(b.take(), [{ type: 'peerGone', t: 3 }]);
  console.log('PASS coop-room: two sockets join, start and relay commands.');
}

// ---- a rebuilt room keeps its lobby ----------------------------------------------------------------------------------
{
  const { ctx, a, b } = await lobbyRoom();
  assert.equal(ctx.data.get('room').seats[0].ready, true);
  clock.t += 4000;
  const rebuilt = new CoopRoom(ctx, {}); // the same ctx: the storage and the sockets survived, the object did not
  assert.equal((await create(rebuilt)).status, 409, 'the rebuilt room still holds its code');
  // The sockets are the same seats: the host's lobby change reaches the guest through the new object.
  await say(rebuilt, a, lobbyOf(['rift-pistol', 'arc-lance'], 'default', false, 21));
  assert.deepEqual(b.take(), [{ type: 'peer', name: 'Host', loadout: ['rift-pistol', 'arc-lance'], look: 'default', ready: false, connected: true, ping: 21 }]);
  await say(rebuilt, a, lobbyOf(['rift-pistol', 'arc-lance'], 'default', true));
  b.take();
  await say(rebuilt, a, { type: 'config', config: config() });
  assert.deepEqual(types(b), ['config', 'start'], 'the rebuilt lobby starts as before');
  // A third socket is still turned away: both seats are held.
  const lobby2 = await lobbyRoom();
  const rebuilt2 = new CoopRoom(lobby2.ctx, {});
  const c = await connect(rebuilt2);
  await say(rebuilt2, c, hello('Third'));
  assert.deepEqual(c.take(), [{ type: 'closed', reason: 'full' }]);
  assert.deepEqual(c.closed, { code: 1008, reason: 'full' });
  clock.t -= 4000;
  console.log('PASS coop-room: a rebuilt room keeps its lobby.');
}

// ---- the alarm closes an expired lobby and frees the code ----------------------------------------------------------
{
  const { ctx, room, a, b } = await lobbyRoom();
  assert.equal(ctx.alarm, clock.t + 30000, 'the seats, not the lobby, are due first');
  const start = clock.t;
  while (clock.t < start + LOBBY_MS - 1) {
    clock.t = Math.min(clock.t + 20000, start + LOBBY_MS - 1);
    await say(room, a, { type: 'ping', id: 1 });
    await say(room, b, { type: 'ping', id: 1 });
  }
  a.take();
  b.take();
  clock.t = start + LOBBY_MS;
  await room.alarm();
  assert.deepEqual(a.take(), [{ type: 'closed', reason: 'expired' }]);
  assert.deepEqual(b.take(), [{ type: 'closed', reason: 'expired' }]);
  assert.deepEqual(a.closed, { code: 1000, reason: 'expired' });
  assert.equal(ctx.data.size, 0, 'the storage is cleared');
  assert.equal(ctx.alarm, null, 'the alarm is cleared');
  assert.equal((await upgrade(room)).status, 404, 'the closed room takes no one');
  assert.equal((await create(room)).status, 200, 'the code can be drawn again');
  clock.t = start;
  console.log('PASS coop-room: the alarm closes an expired lobby and frees the code.');
}

// ---- an upgrade into a room never created, and a second create ----------------------------------------------------
{
  const room = new CoopRoom(fakeCtx(), {});
  assert.equal((await upgrade(room)).status, 404);
  assert.equal((await room.fetch(new Request('https://room/ws'))).status, 404, 'a plain request to a room never created is a 404 as well');
  assert.equal((await create(room, { code: 'nope', build: BUILD, proto: PROTOCOL_VERSION, live: false })).status, 400);
  assert.equal((await create(room, { code: CODE, build: 5, proto: PROTOCOL_VERSION, live: false })).status, 400);
  assert.equal((await create(room)).status, 200);
  assert.equal((await create(room)).status, 409, 'a second create on an open room');
  assert.equal((await room.fetch(new Request('https://room/ws'))).status, 426, 'a room that exists wants a WebSocket upgrade');
  console.log('PASS coop-room: an upgrade into a room never created gets 404.');
  console.log('PASS coop-room: a second create on an open room gets 409.');
}

// ---- a started room rebuilt after an eviction answers closed (error) ---------------------------------------------------
{
  const { ctx, room, a, b } = await lobbyRoom();
  await say(room, a, { type: 'config', config: config() });
  a.take();
  b.take();
  assert.equal(ctx.data.get('room').started, true);
  const rebuilt = new CoopRoom(ctx, {}); // evicted mid-run: the command logs are gone
  await say(rebuilt, a, { type: 'ping', id: 1 });
  assert.deepEqual(a.take(), [{ type: 'closed', reason: 'error' }], 'the seat is told closed (error), not answered the ping');
  assert.deepEqual(b.take(), [{ type: 'closed', reason: 'error' }], 'and so is the partner');
  assert.deepEqual(a.closed, { code: 1008, reason: 'error' });
  assert.equal(ctx.data.size, 0, 'the lost room clears its storage');
  assert.equal(ctx.alarm, null);
  // A socket the object has no room for is answered the same way.
  const stray = fakeSocket();
  stray.serializeAttachment({ conn: 'zz', seat: 0 });
  await rebuilt.webSocketMessage(stray, JSON.stringify({ type: 'ping', id: 2 }));
  assert.deepEqual(stray.take(), [{ type: 'closed', reason: 'error' }]);
  assert.deepEqual(stray.closed, { code: 1008, reason: 'error' });
  assert.equal((await create(rebuilt)).status, 200, 'the code is free again');
  console.log('PASS coop-room: a started room rebuilt after an eviction answers closed (error).');
}

// ---- a socket going away, and the seat timeout on an alarm -------------------------------------------------------------
{
  const { ctx, room, a, b } = await lobbyRoom();
  await room.webSocketClose(a, 1006, '', false);
  assert.deepEqual(b.take(), [{ type: 'peer', name: 'Host', loadout: ['rift-pistol', 'arc-lance'], look: 'default', ready: true, connected: false, ping: 5 }]);
  assert.deepEqual(a.closed, { code: 1000, reason: '' }, 'the close is answered (1006 cannot be sent)');
  await room.webSocketError(b, new Error('reset'));
  assert.ok(ctx.data.get('room'), 'a dropped seat can come back: the room is still saved');
  clock.t += 30000;
  await room.alarm();
  assert.equal(ctx.data.size, 0, 'both seats timed out, so the room closed idle');
  clock.t -= 30000;
  console.log('PASS coop-room: dropped sockets and the seat timeout.');
}

// ---- a signed-in seat and the ranking go through coopDeps ----------------------------------------------------------------
{
  const rows = [];
  const seen = [];
  coopDeps.sessionForToken = async (token, env) => {
    seen.push([token, env.tag]);
    return token === 'ta' ? { id: 11, username: 'Ann' } : token === 'tb' ? { id: 22, username: 'Bob' } : { unauthorized: true };
  };
  coopDeps.rank = async (row, env) => {
    rows.push([row, env.tag]);
    return { ok: true };
  };
  const ctx = fakeCtx();
  const room = new CoopRoom(ctx, { tag: 'env' });
  await create(room, { code: CODE, build: BUILD, proto: PROTOCOL_VERSION, live: true });
  const a = await connect(room);
  const b = await connect(room);
  await say(room, a, hello('Host', { token: 'ta' }));
  await say(room, b, hello('Guest', { token: 'tb' }));
  await settle();
  assert.deepEqual(seen, [['ta', 'env'], ['tb', 'env']], 'the session check gets the token and the Worker env');
  const savedSeats = ctx.data.get('room').seats;
  assert.deepEqual([savedSeats[0].accountId, savedSeats[1].accountId], [11, 22], 'the accounts are saved once the check answers');
  assert.equal(savedSeats[0].username, 'Ann');
  await say(room, a, HOST);
  await say(room, b, GUEST);
  await say(room, a, { type: 'config', config: config() });
  for (const ws of [a, b]) {
    await say(room, ws, cmd(0, 60));
    await say(room, ws, cmd(60, 40));
  }
  const result = { type: 'result', t: 100, outcome: 'cleared', clearTicks: 100, kills: 5, crystals: 3, h: 99 };
  await say(room, a, result);
  await say(room, b, result);
  await settle();
  assert.equal(rows.length, 1, 'the row is ranked once');
  assert.equal(rows[0][1], 'env');
  assert.equal(rows[0][0].a.username, 'Ann');
  assert.equal(rows[0][0].clearMs, Math.round((100 * 1000) / 60));
  assert.deepEqual(a.sent.filter(m => m.type === 'ranked'), [{ type: 'ranked', ok: true }]);
  const saved = ctx.data.get('room');
  assert.deepEqual(saved.answer, { type: 'ranked', ok: true }, 'the answer is saved after the board write');
  assert.ok(saved.doneUntil > 0 && ctx.alarm !== null && ctx.alarm <= saved.doneUntil, 'and the finished room is due to close');
  Object.assign(coopDeps, DEFAULT_DEPS);
  console.log('PASS coop-room: sessions and ranking go through coopDeps.');
}

// ---- the defaults with no database behind them: every seat is a guest, nothing ranks -------------------------------------
{
  const { ctx } = await lobbyRoom({}, [{ token: 'anything' }, {}]);
  await settle();
  assert.equal(ctx.data.get('room').seats[0].accountId, null);
  assert.deepEqual(await coopDeps.rank({}, {}), { ok: false, reason: 'unavailable' });
  console.log('PASS coop-room: with no database every seat is a guest and nothing ranks.');
}

// ---- Task 5.3: the real session check, the ranking into coop_runs and the board ---------------------------------------------
// An in-memory SQLite database stands in for D1. Sessions are seeded the way accounts-api.js stores them (a keyed hash of the token).
const KEY = 'test-signing-key-0123456789-abcdefghijklmnop';
const newDb = async () => {
  const DB = createD1(openDatabase(':memory:'));
  await ensureAccountTables(DB);
  return DB;
};
async function seedAccount(DB, id, username, { expiresIn = 86400000 } = {}) {
  const token = randomToken();
  const now = Date.now();
  await DB.prepare('INSERT INTO accounts (id, username, username_skeleton, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, username, nameSkeleton(username), now, now).run();
  await DB.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)').bind(await sessionHash(KEY, token), id, now, now + expiresIn, now).run();
  return token;
}
const tableRows = (DB, table = 'coop_runs') => (DB.sqlite.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(table) ? DB.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all() : []);
const quietly = async fn => {
  const log = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = log;
  }
};

{
  const DB = await newDb();
  const env = { DB, AUTH_SIGNING_KEY: KEY };
  const ann = await seedAccount(DB, 'acc-ann', 'Ann');
  const old = await seedAccount(DB, 'acc-old', 'Olga', { expiresIn: -1000 });
  assert.deepEqual(await scoreAccounts.sessionForToken(ann, env), { id: 'acc-ann', username: 'Ann' }, 'a live token gives its account');
  assert.deepEqual(await scoreAccounts.sessionForToken(old, env), { unauthorized: true }, 'an expired token is unauthorized');
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?').get('acc-old').n, 0, 'and its session is deleted, as for any request');
  assert.deepEqual(await scoreAccounts.sessionForToken(randomToken(), env), { unauthorized: true }, 'an unknown token is unauthorized');
  for (const bad of ['ta', '', ann + 'x', ann.slice(1), 'a b'.padEnd(43, 'c'), null, undefined, 42, {}]) {
    assert.deepEqual(await scoreAccounts.sessionForToken(bad, env), { unauthorized: true }, `a malformed token is unauthorized: ${String(bad)}`);
  }
  assert.deepEqual(await scoreAccounts.sessionForToken(ann, { DB }), { unavailable: true }, 'no signing key: unavailable');
  assert.deepEqual(await scoreAccounts.sessionForToken(ann, { AUTH_SIGNING_KEY: KEY }), { unavailable: true }, 'no database: unavailable');
  const broken = { prepare() { throw new Error('D1 down'); }, batch() { throw new Error('D1 down'); } };
  assert.deepEqual(await quietly(() => scoreAccounts.sessionForToken(ann, { DB: broken, AUTH_SIGNING_KEY: KEY })), { unavailable: true }, 'a database error: unavailable');
  // session(request) reads the header and answers the same shapes through it.
  const asked = headers => scoreAccounts.session(new Request('https://api.riftborn.us/x', { headers }), env);
  assert.equal(await asked({}), null, 'no header is a guest');
  assert.deepEqual(await asked({ Authorization: 'Bearer ' + ann }), { id: 'acc-ann', username: 'Ann' });
  assert.deepEqual(await asked({ Authorization: 'Bearer nope' }), { unauthorized: true });
  assert.deepEqual(await asked({ Authorization: ann }), { unauthorized: true }, 'only a Bearer header counts');
  console.log('PASS accounts: sessionForToken gives the account for a live token, unauthorized for a bad or expired one, unavailable without keys.');
}

// A pair in a room played to a cleared run. `tokens` are the two hello tokens; `second` changes the partner's result.
async function playCleared({ env, live = true, tokens = [undefined, undefined], second = {} }) {
  const ctx = fakeCtx();
  const room = new CoopRoom(ctx, env);
  await create(room, { code: CODE, build: BUILD, proto: PROTOCOL_VERSION, live });
  const a = await connect(room);
  const b = await connect(room);
  await say(room, a, hello('Host', tokens[0] === undefined ? {} : { token: tokens[0] }));
  await say(room, b, hello('Guest', tokens[1] === undefined ? {} : { token: tokens[1] }));
  await settle();
  await say(room, a, HOST);
  await say(room, b, GUEST);
  await say(room, a, { type: 'config', config: config() });
  for (const ws of [a, b]) {
    await say(room, ws, cmd(0, 60));
    await say(room, ws, cmd(60, 40));
  }
  await say(room, a, { type: 'result', t: 100, outcome: 'cleared', clearTicks: 100, kills: 5, crystals: 3, h: 99 });
  await say(room, b, { type: 'result', t: 100, outcome: 'cleared', clearTicks: 100, kills: 5, crystals: 3, h: 99, ...second });
  await settle();
  await settle();
  return { ctx, room, a, b, ranked: a.sent.filter(m => m.type === 'ranked') };
}

{
  const DB = await newDb();
  const env = { DB, AUTH_SIGNING_KEY: KEY };
  const ann = await seedAccount(DB, 'acc-ann', 'Ann');
  const bob = await seedAccount(DB, 'acc-bob', 'Bob');
  assert.equal(DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'coop_runs'").get(), undefined, 'no coop_runs table before the first write');
  const before = Date.now();
  const played = await playCleared({ env, tokens: [ann, bob] });
  assert.deepEqual(played.ranked, [{ type: 'ranked', ok: true }], 'both seats hear the run was ranked');
  const rows = tableRows(DB);
  assert.equal(rows.length, 1, 'one row');
  const { id, created_at: createdAt, ...row } = rows[0];
  assert.ok(createdAt >= before && createdAt <= Date.now(), 'created_at is the time of the write');
  assert.deepEqual(row, { version: BUILD, stamp: 'expedition-1', world: 3, seed: 123456789, clear_ms: 1667, kills: 5, a_account: 'acc-ann', a_name: 'Ann', b_account: 'acc-bob', b_name: 'Bob', room: CODE, hash: '00000063' });
  assert.equal(id, 1);
  console.log('PASS coop-rank: a matching cleared run from two signed-in seats in a live room writes one row.');
}

{
  const DB = await newDb();
  const env = { DB, AUTH_SIGNING_KEY: KEY };
  const ann = await seedAccount(DB, 'acc-ann', 'Ann');
  const bob = await seedAccount(DB, 'acc-bob', 'Bob');
  const ranked = async options => (await playCleared({ env, ...options })).ranked;
  assert.deepEqual(await ranked({ live: false, tokens: [ann, bob] }), [{ type: 'ranked', ok: false, reason: 'dev' }], 'a dev room');
  assert.deepEqual(await ranked({ tokens: [ann, undefined] }), [{ type: 'ranked', ok: false, reason: 'guest' }], 'a guest seat');
  assert.deepEqual(await ranked({ tokens: [ann, randomToken()] }), [{ type: 'ranked', ok: false, reason: 'guest' }], 'a token that proves nothing is a guest seat');
  assert.deepEqual(await ranked({ tokens: [ann, ann] }), [{ type: 'ranked', ok: false, reason: 'guest' }], 'one account in both seats');
  assert.deepEqual(await ranked({ tokens: [ann, bob], second: { kills: 6 } }), [{ type: 'ranked', ok: false, reason: 'mismatch' }], 'a mismatch');
  assert.deepEqual(await ranked({ tokens: [ann, bob], second: { outcome: 'lost' } }), [{ type: 'ranked', ok: false, reason: 'mismatch' }], 'another outcome');
  assert.equal(tableRows(DB).length, 0, 'none of them wrote a row');
  console.log('PASS coop-rank: a dev room, a guest seat or a mismatch writes none.');
}

{
  const DB = await newDb();
  const ann = await seedAccount(DB, 'acc-ann', 'Ann');
  const bob = await seedAccount(DB, 'acc-bob', 'Bob');
  // The sessions are read from the real database; only the coop_runs statements fail.
  const failing = {
    prepare: sql => {
      if (/coop_runs/.test(sql)) throw new Error('D1 down');
      return DB.prepare(sql);
    },
    batch: statements => DB.batch(statements),
    sqlite: DB.sqlite
  };
  const played = await quietly(() => playCleared({ env: { DB: failing, AUTH_SIGNING_KEY: KEY }, tokens: [ann, bob] }));
  assert.deepEqual(played.ranked, [{ type: 'ranked', ok: false, reason: 'unavailable' }], 'a database error answers unavailable');
  assert.deepEqual(await quietly(() => insertCoopRun({ DB: failing }, { code: CODE })), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await insertCoopRun({}, { code: CODE }), { ok: false, reason: 'unavailable' }, 'no database: unavailable');
  assert.deepEqual(await quietly(() => insertCoopRun({ DB }, { code: CODE })), { ok: false, reason: 'unavailable' }, 'a row missing its fields never throws');
  console.log('PASS coop-rank: a database error answers unavailable.');
}

// ---- the board ----------------------------------------------------------------------------------------------------------
const runRow = (clearMs, kills, a, b, extra = {}) => ({
  code: CODE, build: BUILD, stamp: 'expedition-1', world: 3, seed: 123456789, clearMs, kills,
  a: { accountId: a, username: 'stored-' + a }, b: { accountId: b, username: 'stored-' + b }, hash: '00000063', ...extra
});
const addAccount = (DB, id, name) => DB.prepare('INSERT INTO accounts (id, username, username_skeleton, created_at) VALUES (?, ?, ?, ?)').bind(id, name, nameSkeleton(name), 1).run();

{
  const DB = await newDb();
  const env = { DB };
  assert.deepEqual(await coopBoard(env, null), { rows: [], me: null }, 'an empty board (the table is created on first use)');
  for (const [id, name] of [['p1', 'Pia'], ['p2', 'Quin'], ['p3', 'Rex'], ['p4', 'Sol']]) await addAccount(DB, id, name);
  // Tie on time: more kills first; tie on both: the older run first. Other stamps are not on this board.
  await insertCoopRun(env, runRow(90000, 10, 'p1', 'p2'));
  await insertCoopRun(env, runRow(80000, 10, 'p3', 'p4'));
  await insertCoopRun(env, runRow(80000, 12, 'p1', 'p3'));
  await insertCoopRun(env, runRow(80000, 12, 'p2', 'p4'));
  await insertCoopRun(env, runRow(1000, 99, 'p1', 'p2', { stamp: 'expedition-2' }));
  const board = await coopBoard(env, null);
  assert.deepEqual(board.rows.map(r => [r.rank, r.clearMs, r.kills, r.a, r.b]), [
    [1, 80000, 12, 'Pia', 'Rex'], [2, 80000, 12, 'Quin', 'Sol'], [3, 80000, 10, 'Rex', 'Sol'], [4, 90000, 10, 'Pia', 'Quin']
  ], 'ordered by clear time, then kills (most first), then age; current account names');
  assert.deepEqual(Object.keys(board.rows[0]), ['rank', 'a', 'b', 'world', 'clearMs', 'kills', 'date']);
  assert.equal(board.rows[0].world, 3);
  assert.match(board.rows[0].date, /^\d{4}-\d{2}-\d{2}$/, 'the date is a UTC day');
  assert.equal(board.me, null, 'no account, no me');
  assert.equal(/"p\d"/.test(JSON.stringify(board)), false, 'no account id is ever returned');
  assert.deepEqual((await coopBoard(env, 'p4')).me, board.rows[1], 'my best row, with its rank');
  assert.equal((await coopBoard(env, 'p1')).me.rank, 1, 'either seat counts, and the best row wins');
  assert.equal((await coopBoard(env, 'p3')).me.rank, 1);
  assert.equal((await coopBoard(env, 'nobody')).me, null, 'an account with no run');

  // 60 more runs: the board caps at 50; a player below the cut is pinned with a rank past 50.
  for (let i = 0; i < 60; i++) await insertCoopRun(env, runRow(100000 + i * 10, 1, 'f' + i, 'g' + i));
  const full = await coopBoard(env, 'f59');
  assert.equal(full.rows.length, 50, 'capped at 50');
  assert.deepEqual(full.rows.map(r => r.rank), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(full.rows.at(-1).clearMs, 100000 + 45 * 10, 'the 50th row is the 46th slow run');
  assert.equal(full.me.rank, 4 + 60, 'pinned below the cut with its real rank');
  assert.equal(full.me.clearMs, 100590);
  assert.equal(full.me.a, 'stored-f59', 'an account that is not in the accounts table keeps the name stored with the run');
  console.log('PASS coop-board: orders by clear time then kills, caps at 50, pins me.');
}

{
  const DB = await newDb();
  const env = { DB };
  await addAccount(DB, 'p1', 'Pia');
  await addAccount(DB, 'p2', 'Quin');
  await insertCoopRun(env, runRow(80000, 10, 'p1', 'p2'));
  assert.deepEqual((await coopBoard(env, 'p1')).rows.map(r => [r.a, r.b]), [['Pia', 'Quin']]);
  await DB.prepare('UPDATE accounts SET username = ? WHERE id = ?').bind('Pia the Bold', 'p1').run();
  const renamed = await coopBoard(env, 'p1');
  assert.deepEqual(renamed.rows.map(r => [r.a, r.b]), [['Pia the Bold', 'Quin']], 'a renamed account shows its new name');
  assert.equal(renamed.me.a, 'Pia the Bold', 'and so does the pinned row');
  assert.equal(DB.sqlite.prepare('SELECT a_name FROM coop_runs').get().a_name, 'stored-p1', 'the stored name is only the fallback');
  // No accounts table at all (a bare database): the stored names are shown.
  const bare = { DB: createD1(openDatabase(':memory:')) };
  await insertCoopRun(bare, runRow(80000, 10, 'p1', 'p2'));
  assert.deepEqual((await coopBoard(bare, null)).rows.map(r => [r.a, r.b]), [['stored-p1', 'stored-p2']]);
  console.log('PASS coop-board: a renamed account shows its new name.');
}

{
  // The table and index are created lazily, and drizzle 0007 builds the same ones.
  const lazy = createD1(openDatabase(':memory:'));
  await ensureCoopTables(lazy);
  await ensureCoopTables(lazy);
  const migrated = createD1(openDatabase(':memory:', 'drizzle', fs));
  const shape = db => ({
    columns: db.sqlite.prepare("PRAGMA table_info('coop_runs')").all().map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
    indexes: db.sqlite.prepare("PRAGMA index_list('coop_runs')").all().filter(i => i.origin === 'c').map(i => [i.name, db.sqlite.prepare(`PRAGMA index_info('${i.name}')`).all().map(c => c.name)])
  });
  assert.deepEqual(shape(migrated), shape(lazy), 'the migration and the lazy bootstrap build the same table');
  assert.deepEqual(shape(lazy).columns.map(c => c[0]), ['id', 'created_at', 'version', 'stamp', 'world', 'seed', 'clear_ms', 'kills', 'a_account', 'a_name', 'b_account', 'b_name', 'room', 'hash']);
  assert.deepEqual(shape(lazy).indexes, [['coop_runs_board', ['stamp', 'clear_ms', 'kills']]]);
  assert.doesNotThrow(() => migrated.sqlite.exec(fs.readFileSync('drizzle/0007_coop_runs.sql', 'utf8').replaceAll('--> statement-breakpoint', '')), 'the migration is re-runnable');
  const journal = JSON.parse(fs.readFileSync('drizzle/meta/_journal.json', 'utf8')).entries.at(-1);
  assert.deepEqual([journal.idx, journal.tag], [7, '0007_coop_runs']);
  const snapshot = JSON.parse(fs.readFileSync('drizzle/meta/0007_snapshot.json', 'utf8'));
  const previous = JSON.parse(fs.readFileSync('drizzle/meta/0006_snapshot.json', 'utf8'));
  assert.equal(snapshot.prevId, previous.id);
  assert.notEqual(snapshot.id, previous.id);
  assert.deepEqual(Object.keys(snapshot.tables.coop_runs.columns), shape(lazy).columns.map(c => c[0]));
  assert.ok(snapshot.tables.daily_stats && snapshot.tables.scores, 'the other tables carry over');
  console.log('PASS coop-runs: the lazy table and drizzle 0007 agree.');
}

// ---- a finished room rebuilt keeps its done window (a started room with no answer is buried, above) ----------------------
{
  const origin = clock.t;
  const { ctx, room, a, b } = await lobbyRoom();
  const secretA = ctx.data.get('room').seats[0].secret;
  await say(room, a, { type: 'config', config: config() });
  const done = { type: 'result', t: 100, outcome: 'cleared', clearTicks: 100, kills: 5, crystals: 3, h: 99 };
  await say(room, a, done);
  await say(room, b, done);
  assert.deepEqual(a.sent.filter(m => m.type === 'ranked'), [{ type: 'ranked', ok: false, reason: 'dev' }], 'a dev room answers at once');
  const saved = ctx.data.get('room');
  assert.deepEqual(saved.answer, { type: 'ranked', ok: false, reason: 'dev' });
  assert.ok(saved.doneUntil > clock.t, 'the done window is saved');

  const rebuilt = new CoopRoom(ctx, {});
  await rebuilt.ready;
  assert.deepEqual(ctx.data.get('room'), saved, 'a finished room is not buried by the rebuild');
  assert.ok(ctx.alarm !== null && ctx.alarm <= saved.doneUntil);
  assert.equal((await create(rebuilt)).status, 409, 'it still holds its code');
  // The host comes back on a new socket with its secret and takes its seat over from the old one.
  const c = await connect(rebuilt);
  await say(rebuilt, c, hello('Host', { resume: secretA, got: -1 }));
  assert.deepEqual(types(c), ['welcome', 'config', 'start', 'ranked']);
  assert.deepEqual(a.closed, { code: 1008, reason: 'error' }, 'the old socket is let go');
  // The window runs out as before: closed done, storage cleared.
  while (clock.t < saved.doneUntil - 1) {
    clock.t = Math.min(clock.t + 20000, saved.doneUntil - 1);
    await say(rebuilt, c, { type: 'ping', id: 1 });
    await say(rebuilt, b, { type: 'ping', id: 1 });
  }
  b.take();
  c.take();
  clock.t = saved.doneUntil;
  await rebuilt.alarm();
  assert.deepEqual(b.take(), [{ type: 'closed', reason: 'done' }]);
  assert.equal(ctx.data.size, 0);
  assert.equal(ctx.alarm, null);
  clock.t = origin;
  console.log('PASS coop-room: a finished room rebuilt keeps its done window.');
}

// ---- the alarm is never later than the core's next deadline, and an early alarm is harmless ---------------------------------
{
  const origin = clock.t;
  const { ctx, room, a, b } = await lobbyRoom();
  await say(room, a, { type: 'config', config: config() });
  a.take();
  b.take();
  let fired = 0;
  for (let step = 0; step < 100; step++) {
    clock.t = origin + (step + 1) * 1500; // 150 s: five seat timeouts' worth
    if (ctx.alarm !== null && clock.t >= ctx.alarm) {
      await room.alarm();
      fired++;
    }
    const puts = ctx.puts;
    const before = ctx.alarm;
    await say(room, a, { type: 'ping', id: step });
    await say(room, b, { type: 'ping', id: step });
    await say(room, a, cmd(step, 1));
    await say(room, a, { type: 'hash', t: step * 60, h: 1 });
    assert.equal(ctx.puts, puts, 'cmd, hash and ping write nothing');
    assert.ok(ctx.alarm <= room.core.nextDeadline(), `the alarm (${ctx.alarm}) is never later than the deadline (${room.core.nextDeadline()})`);
    assert.ok(ctx.alarm <= before, 'and hot messages never move it later');
    a.take();
    b.take();
  }
  assert.ok(fired >= 4 && fired <= 8, `the alarm woke the room about once per seat timeout (${fired})`);
  assert.equal(room.core.closedReason, null, 'the room stayed open');
  // A stale alarm that is later than the deadline is pulled back by the next hot message.
  ctx.alarm = room.alarmAt = room.core.nextDeadline() + 50000;
  await say(room, a, { type: 'ping', id: 1000 });
  assert.ok(ctx.alarm <= room.core.nextDeadline(), 'a hot message pulls a too-late alarm back');
  a.take();
  // An alarm that fires before anything is due changes nothing and sets the right one.
  const state = JSON.stringify(ctx.data.get('room'));
  await room.alarm();
  assert.equal(room.core.closedReason, null);
  assert.deepEqual([a.take(), b.take()], [[], []], 'nobody is told anything');
  assert.equal(JSON.stringify(ctx.data.get('room')), state, 'and nothing saved changes');
  assert.equal(ctx.alarm, room.core.nextDeadline(), 'the alarm is set again, exactly');
  clock.t = origin;
  console.log('PASS coop-room: the alarm is never later than the next deadline; an early alarm is harmless.');
}

// ---- the review's smaller fixes -------------------------------------------------------------------------------------------
{
  // A takeover clears the old socket's attachment, so a rebuild gives the seat to the new socket.
  const { ctx, room, a, b } = await lobbyRoom();
  const c = await connect(room);
  await say(room, c, hello('Host', { resume: ctx.data.get('room').seats[0].secret }));
  b.take();
  assert.equal(a.deserializeAttachment().seat, null, 'the old socket no longer claims the seat');
  assert.equal(c.deserializeAttachment().seat, 0);
  const rebuilt = new CoopRoom(ctx, {});
  await say(rebuilt, c, lobbyOf(['rift-pistol', 'arc-lance'], 'default', false, 3));
  assert.deepEqual(types(b), ['peer'], 'the new socket holds the seat after a rebuild');

  // A rebuild puts a lost alarm back.
  ctx.alarm = null;
  const again = new CoopRoom(ctx, {});
  await again.ready;
  assert.equal(ctx.alarm, again.core.nextDeadline());

  // A failed create leaves nothing behind; a failed upgrade leaves no socket behind.
  const broken = fakeCtx();
  const fresh = new CoopRoom(broken, {});
  const realPut = broken.storage.put;
  broken.storage.put = async () => {
    throw new Error('storage failed');
  };
  await assert.rejects(create(fresh), /storage failed/);
  broken.storage.put = realPut;
  assert.equal((await upgrade(fresh)).status, 404, 'no room was left in memory');
  assert.equal((await create(fresh)).status, 200);
  const realSet = broken.storage.setAlarm;
  broken.storage.setAlarm = async () => {
    throw new Error('alarm failed');
  };
  let server = null;
  const makePair = coopDeps.socketPair;
  coopDeps.socketPair = () => {
    const pair = makePair();
    server = pair.server;
    return pair;
  };
  await assert.rejects(upgrade(fresh), /alarm failed/);
  coopDeps.socketPair = makePair;
  broken.storage.setAlarm = realSet;
  assert.ok(server.closed, 'the server half of a socket nobody got is closed');

  // A message that changes nothing writes nothing.
  const same = await lobbyRoom();
  const puts = same.ctx.puts;
  await say(same.room, same.a, HOST);
  assert.equal(same.ctx.puts, puts, 'the same lobby message again saves nothing');
  console.log('PASS coop-room: takeover attachments, alarm re-armed on rebuild, failed create and upgrade, unchanged saves.');
}

// ---- the HTTP routes in front of the room (server/coop-api.js) --------------------------------------------------------
// A fake env stands in for the Worker bindings: COOP_ROOM (a namespace whose rooms answer create like the real object) and the
// rate limiter. Nothing here touches Cloudflare.
{
  const ORIGIN = { live: 'https://riftborn.us', dev: 'https://dev.riftborn.us', preview: 'https://v3-0-0-coop.riftborn-dev.pages.dev', foreign: 'https://evil.example' };
  const calls = { names: [], creates: [], forwarded: [], limits: [] };
  const apiEnv = ({ busy = () => false, limit = () => true, ...extra } = {}) => {
    let draws = 0;
    return {
      ENVIRONMENT: 'production',
      COOP_RATE_LIMITER: {
        async limit({ key }) {
          calls.limits.push(key);
          return { success: limit(calls.limits.length) };
        }
      },
      COOP_ROOM: {
        idFromName(name) {
          calls.names.push(name);
          return { name };
        },
        get(id) {
          return {
            async fetch(input, init) {
              if (input instanceof Request) {
                calls.forwarded.push({ id, request: input });
                return { status: 101, webSocket: {} };
              }
              const body = JSON.parse(init.body);
              calls.creates.push({ id, url: input, method: init.method, body });
              draws++;
              return busy(draws) ? new Response(JSON.stringify({ error: 'this code is in use' }), { status: 409 }) : new Response(JSON.stringify({ ok: true, code: body.code }), { status: 200 });
            }
          };
        }
      },
      ...extra
    };
  };
  const reset = () => Object.values(calls).forEach(list => (list.length = 0));
  const post = (origin, body = { build: BUILD, proto: PROTOCOL_VERSION }, headers = {}) =>
    new Request('https://api.riftborn.us/coop/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const ws = (code, origin, upgrade = true) =>
    new Request(`https://api.riftborn.us/coop/rooms/${code}/ws`, { headers: { ...(origin ? { Origin: origin } : {}), ...(upgrade ? { Upgrade: 'websocket' } : {}) } });
  const standard = (response, origin) => {
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Vary'), 'Origin');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin, `CORS for ${origin}`);
  };

  // The origin classes.
  assert.equal(coopOrigin(ORIGIN.live), 'live');
  assert.equal(coopOrigin(ORIGIN.dev), 'test');
  assert.equal(coopOrigin(ORIGIN.preview), 'test');
  for (const bad of [null, undefined, '', ORIGIN.foreign, 'http://riftborn.us', 'https://riftborn.us.evil.example', 'https://evil.example/https://riftborn.us', 'https://riftborn-dev.pages.dev', 'https://a.b.riftborn-dev.pages.dev', 'https://x.riftborn-dev.pages.dev.evil.example', 'https://X.riftborn-dev.pages.dev', 'https://chancrisp.github.io', 'https://feedback.riftborn.us']) {
    assert.equal(coopOrigin(bad), null, String(bad));
  }
  assert.equal(await handleCoop(new Request('https://api.riftborn.us/api/scores'), apiEnv()), null, 'a path outside /coop/ is not ours');

  // A create returns a valid code, from a live page, with the standard headers; the room is named for it.
  {
    reset();
    const response = await handleCoop(post(ORIGIN.live), apiEnv());
    assert.equal(response.status, 201);
    standard(response, ORIGIN.live);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    const { code, ...rest } = await response.json();
    assert.deepEqual(rest, {}, 'only the code comes back');
    assert.ok(validCode(code), `a valid room code (${code})`);
    assert.deepEqual(calls.names, ['room:' + code]);
    assert.equal(calls.creates.length, 1);
    assert.equal(calls.creates[0].method, 'POST');
    assert.equal(new URL(calls.creates[0].url).pathname, '/create');
    assert.deepEqual(calls.creates[0].body, { code, build: BUILD, proto: PROTOCOL_VERSION, live: true });
    // A different draw each time: 20 creates are not all one code.
    const codes = new Set();
    for (let i = 0; i < 20; i++) codes.add((await (await handleCoop(post(ORIGIN.dev), apiEnv())).json()).code);
    assert.ok(codes.size > 15, 'the codes are random');
    console.log('PASS coop-api: a create returns a valid code.');
  }

  // The 11th create in a minute gets 429 (a fake limiter that allows ten), keyed by something that is not the address.
  {
    reset();
    const env = apiEnv({ limit: n => n <= 10 });
    for (let i = 0; i < 10; i++) assert.equal((await handleCoop(post(ORIGIN.live, undefined, { 'CF-Connecting-IP': '203.0.113.9' }), env)).status, 201, `create ${i + 1}`);
    const refused = await handleCoop(post(ORIGIN.live, undefined, { 'CF-Connecting-IP': '203.0.113.9' }), env);
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { error: 'rate_limited' });
    assert.equal(refused.headers.get('Retry-After'), '60');
    standard(refused, ORIGIN.live);
    assert.equal(calls.creates.length, 10, 'the refused create made no room');
    assert.ok(calls.limits.length === 11 && calls.limits.every(key => key === calls.limits[0] && typeof key === 'string' && key.length > 0), 'one key per sender');
    // With a signing key the key is a keyed hash, never the address.
    reset();
    const keyed = apiEnv({ AUTH_SIGNING_KEY: 'k'.repeat(40) });
    await handleCoop(post(ORIGIN.live, undefined, { 'CF-Connecting-IP': '203.0.113.9' }), keyed);
    assert.ok(!calls.limits[0].includes('203.0.113.9'), 'the address is not the limiter key');
    // No limiter or no namespace bound: closed, nothing created.
    reset();
    const noLimiter = apiEnv();
    delete noLimiter.COOP_RATE_LIMITER;
    assert.equal((await handleCoop(post(ORIGIN.live), noLimiter)).status, 503);
    assert.equal(calls.creates.length, 0);
    assert.equal((await handleCoop(post(ORIGIN.live), apiEnv({ COOP_ROOM: undefined }))).status, 503);
    console.log('PASS coop-api: the 11th create in a minute gets 429.');
  }

  // A busy code is redrawn, up to five times.
  {
    reset();
    const response = await handleCoop(post(ORIGIN.live), apiEnv({ busy: draw => draw <= 2 }));
    assert.equal(response.status, 201);
    assert.equal(calls.creates.length, 3, 'two busy codes, then one that took');
    assert.equal(new Set(calls.names).size, 3, 'each draw names its own room');
    assert.equal((await response.json()).code, calls.creates[2].body.code, 'the code returned is the one that took');
    reset();
    const allBusy = await handleCoop(post(ORIGIN.live), apiEnv({ busy: () => true }));
    assert.equal(allBusy.status, 503);
    assert.deepEqual(await allBusy.json(), { error: 'busy' });
    assert.equal(calls.creates.length, 5, 'five tries, no more');
    // A room that fails is not retried and not described.
    reset();
    const env = apiEnv();
    env.COOP_ROOM.get = () => ({ fetch: async () => new Response('boom', { status: 500 }) });
    const failed = await handleCoop(post(ORIGIN.live), env);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'unavailable' });
    console.log('PASS coop-api: a busy code is redrawn.');
  }

  // Bad code 400, foreign origin 403, missing upgrade 426; a good upgrade is forwarded as it came.
  {
    reset();
    const env = apiEnv();
    const bad = await handleCoop(ws('abc123', ORIGIN.live), env);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'bad_code' });
    assert.equal((await handleCoop(ws('abcd23', ORIGIN.live), env)).status, 400, 'a code is upper case');
    assert.equal((await handleCoop(ws('ABCDI1', ORIGIN.live), env)).status, 400, 'no I, O, 0 or 1');
    for (const origin of [ORIGIN.foreign, null, 'http://riftborn.us']) {
      const refused = await handleCoop(ws(CODE, origin), env);
      assert.equal(refused.status, 403, String(origin));
      assert.equal(refused.headers.get('Access-Control-Allow-Origin'), null, 'no CORS for a foreign origin');
      assert.equal(refused.headers.get('Cache-Control'), 'no-store');
    }
    const plain = await handleCoop(ws(CODE, ORIGIN.dev, false), env);
    assert.equal(plain.status, 426);
    standard(plain, ORIGIN.dev);
    assert.equal(calls.forwarded.length, 0, 'nothing reached a room yet');
    for (const origin of [ORIGIN.live, ORIGIN.dev, ORIGIN.preview]) {
      reset();
      const request = ws(CODE, origin);
      const answer = await handleCoop(request, env);
      assert.equal(answer.status, 101, `${origin} upgrades`);
      assert.deepEqual(calls.names, ['room:' + CODE]);
      assert.equal(calls.forwarded.length, 1);
      assert.equal(calls.forwarded[0].request, request, 'the request is forwarded unchanged');
    }
    // The room's own refusal (an unknown code) keeps its status and gets the standard headers.
    const missing = apiEnv();
    missing.COOP_ROOM.get = () => ({ fetch: async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }) });
    const gone = await handleCoop(ws(CODE, ORIGIN.live), missing);
    assert.equal(gone.status, 404);
    standard(gone, ORIGIN.live);
    // The same gates guard a create.
    for (const origin of [ORIGIN.foreign, null]) assert.equal((await handleCoop(post(origin), env)).status, 403, `create from ${origin}`);
    // Bad bodies make no room.
    reset();
    for (const body of ['not json', '[]', 'null', { build: 5, proto: 1 }, { build: '', proto: 1 }, { build: 'x'.repeat(41), proto: 1 }, { build: BUILD, proto: 'one' }, { build: BUILD }]) {
      assert.equal((await handleCoop(post(ORIGIN.live, body), env)).status, 400, JSON.stringify(body));
    }
    assert.equal((await handleCoop(post(ORIGIN.live, 'x'.repeat(2000)), env)).status, 413);
    assert.equal((await handleCoop(post(ORIGIN.live, undefined, { 'Content-Type': 'text/plain' }), env)).status, 400);
    assert.equal(calls.creates.length, 0, 'no bad body made a room');
    console.log('PASS coop-api: bad code 400, foreign origin 403, missing upgrade 426.');
  }

  // Only a riftborn.us page in the production Worker makes a live room.
  {
    for (const [origin, environment, live] of [[ORIGIN.live, 'production', true], [ORIGIN.live, 'staging', false], [ORIGIN.live, undefined, false], [ORIGIN.dev, 'production', false], [ORIGIN.preview, 'production', false]]) {
      reset();
      assert.equal((await handleCoop(post(origin), apiEnv({ ENVIRONMENT: environment }))).status, 201);
      assert.equal(calls.creates[0].body.live, live, `${origin} in ${environment}`);
    }
    console.log('PASS coop-api: a preview or dev room is not live; a riftborn.us room in production is.');
  }

  // The entry (cloudflare/worker.js) hands a room's 101 to the client intact: its HSTS wrapper used to rebuild every answer, which
  // throws on a 101 and loses the webSocket.
  {
    reset();
    const webSocket = { peer: 'client half' };
    const room = { status: 101, statusText: 'Switching Protocols', headers: new Headers(), body: null, webSocket };
    const env = apiEnv();
    env.COOP_ROOM.get = () => ({ fetch: async () => room });
    const answer = await worker.fetch(ws(CODE, ORIGIN.live), env, { waitUntil() {} });
    assert.equal(answer, room, 'the same answer comes back through worker.fetch');
    assert.equal(answer.status, 101);
    assert.equal(answer.webSocket, webSocket, 'with its webSocket');
    // ...and an ordinary answer on the same route still gets the HSTS header.
    const plain = await worker.fetch(ws(CODE, ORIGIN.live, false), env, { waitUntil() {} });
    assert.equal(plain.status, 426);
    assert.equal(plain.headers.get('Strict-Transport-Security'), 'max-age=31536000');
    console.log('PASS coop-api: a room\'s 101 reaches the client through the Worker entry untouched.');
  }

  // A limiter that fails answers 503 with the standard headers; the back-off headers are readable cross-origin; with no signing key
  // the limiter key buckets IPv6 by its /64 like the hashed key does.
  {
    reset();
    const broken = apiEnv();
    broken.COOP_RATE_LIMITER.limit = async () => {
      throw new Error('binding down');
    };
    const down = await handleCoop(post(ORIGIN.live), broken);
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { error: 'unavailable' });
    standard(down, ORIGIN.live);
    assert.equal(calls.creates.length, 0);
    const limited = await handleCoop(post(ORIGIN.live), apiEnv({ limit: () => false }));
    assert.equal(limited.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
    const busy = await handleCoop(post(ORIGIN.live), apiEnv({ busy: () => true }));
    assert.equal(busy.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
    reset();
    const env = apiEnv();
    await handleCoop(post(ORIGIN.live, undefined, { 'CF-Connecting-IP': '2001:db8:1:2:aaaa::1' }), env);
    await handleCoop(post(ORIGIN.live, undefined, { 'CF-Connecting-IP': '2001:db8:1:2:bbbb::9' }), env);
    assert.equal(calls.limits[0], calls.limits[1], 'one /64 is one sender');
    console.log('PASS coop-api: a failing limiter answers 503, Retry-After is exposed, the unkeyed fallback buckets IPv6 by /64.');
  }

  // The preflight, the other methods and unknown paths.
  {
    const preflight = await handleCoop(new Request('https://api.riftborn.us/coop/rooms', { method: 'OPTIONS', headers: { Origin: ORIGIN.preview } }), apiEnv());
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN.preview);
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
    assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization', 'the board takes the sign-in token');
    assert.equal(preflight.headers.get('Vary'), 'Origin');
    assert.equal((await handleCoop(new Request('https://api.riftborn.us/coop/rooms', { method: 'OPTIONS', headers: { Origin: ORIGIN.foreign } }), apiEnv())).status, 403);
    const wrongMethod = await handleCoop(new Request('https://api.riftborn.us/coop/rooms', { headers: { Origin: ORIGIN.live } }), apiEnv());
    assert.equal(wrongMethod.status, 405);
    standard(wrongMethod, ORIGIN.live);
    const unknown = await handleCoop(new Request('https://api.riftborn.us/coop/nothing', { headers: { Origin: ORIGIN.live } }), apiEnv());
    assert.equal(unknown.status, 404);
    standard(unknown, ORIGIN.live);
    console.log('PASS coop-api: preflight, methods and unknown paths.');
  }

    // The board: a co-op origin only, { rows, me } with the standard headers, me from the Bearer token (null for none or a bad one).
    {
      const DB = await newDb();
      const ann = await seedAccount(DB, 'acc-ann', 'Ann');
      await seedAccount(DB, 'acc-bob', 'Bob');
      const env = apiEnv({ DB, AUTH_SIGNING_KEY: KEY });
      const get = (origin, token, method = 'GET') =>
        new Request('https://api.riftborn.us/coop/board', { method, headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
      const empty = await handleCoop(get(ORIGIN.live), env);
      assert.equal(empty.status, 200);
      assert.deepEqual(await empty.json(), { rows: [], me: null });
      standard(empty, ORIGIN.live);
      assert.equal(empty.headers.get('Content-Type'), 'application/json');
      await insertCoopRun(env, runRow(80000, 10, 'acc-ann', 'acc-bob'));
      const anon = await (await handleCoop(get(ORIGIN.dev), env)).json();
      assert.deepEqual(anon.rows.map(r => [r.rank, r.a, r.b, r.clearMs, r.kills]), [[1, 'Ann', 'Bob', 80000, 10]]);
      assert.equal(anon.me, null, 'no token: me is null');
      const mine = await handleCoop(get(ORIGIN.preview, ann), env);
      assert.equal(mine.status, 200);
      standard(mine, ORIGIN.preview);
      assert.deepEqual((await mine.json()).me, anon.rows[0], 'my best row with its rank');
      for (const token of ['nope', randomToken()]) {
        const bad = await handleCoop(get(ORIGIN.live, token), env);
        assert.equal(bad.status, 200, 'a bad token is not an error');
        assert.equal((await bad.json()).me, null);
      }
      for (const origin of [ORIGIN.foreign, null]) {
        const refused = await handleCoop(get(origin), env);
        assert.equal(refused.status, 403, `board from ${origin}`);
        assert.deepEqual(await refused.json(), { error: 'forbidden_origin' });
        assert.equal(refused.headers.get('Access-Control-Allow-Origin'), null);
        assert.equal(refused.headers.get('Cache-Control'), 'no-store');
      }
      const wrong = await handleCoop(get(ORIGIN.live, undefined, 'POST'), env);
      assert.equal(wrong.status, 405);
      assert.equal(wrong.headers.get('Allow'), 'GET, OPTIONS');
      standard(wrong, ORIGIN.live);
      const noDb = await handleCoop(get(ORIGIN.live), apiEnv());
      assert.equal(noDb.status, 503);
      assert.deepEqual(await noDb.json(), { error: 'unavailable' });
      standard(noDb, ORIGIN.live);
      const broken = apiEnv({ DB: { prepare() { throw new Error('D1 down'); }, batch() { throw new Error('D1 down'); } }, AUTH_SIGNING_KEY: KEY });
      const down = await quietly(() => handleCoop(get(ORIGIN.live), broken));
      assert.equal(down.status, 503);
      assert.deepEqual(await down.json(), { error: 'unavailable' });
      console.log('PASS coop-api: the board answers { rows, me } to co-op origins only, with me from the Bearer token.');
    }
}

console.log('PASS coop-room: all checks.');
