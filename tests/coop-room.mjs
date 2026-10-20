// The CoopRoom Durable Object (server/coop-room.js): the game's shared room core behind the WebSocket Hibernation API.
// Local only: a fake `ctx` (storage with an alarm, acceptWebSocket, getWebSockets) and fake sockets stand in for the Workers runtime.
//   - the two shared files equal the game's; two sockets join, start and relay commands; a rebuilt room keeps its lobby;
//   - the alarm closes an expired lobby and frees the code; an upgrade into a room never created is a 404; a second create is a 409;
//   - a started room rebuilt after an eviction answers closed (error); a signed-in seat and the ranking go through coopDeps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CoopRoom, coopDeps } from '../server/coop-room.js';
import { PROTOCOL_VERSION } from '../server/coop/protocol.js';
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

// ---- the defaults: every seat is a guest, nothing ranks ---------------------------------------------------------------
{
  const { ctx } = await lobbyRoom({}, [{ token: 'anything' }, {}]);
  await settle();
  assert.equal(ctx.data.get('room').seats[0].accountId, null);
  assert.deepEqual(await coopDeps.rank({}, {}), { ok: false, reason: 'unavailable' });
  console.log('PASS coop-room: without the 5.3 functions every seat is a guest.');
}

console.log('PASS coop-room: all checks.');
