// The CoopRoom Durable Object (co-op Expedition spec 8.4 and 9, plan Task 5.1): one room of the co-op Expedition. The room's rules are
// the game's shared core (server/coop/room-core.js, a byte-identical copy of riftborn/src/net/room-core.js); this class is only its
// transport: the WebSocket Hibernation API for the sockets, the Durable Object's storage for the lobby, and its alarm for every deadline.
//
// What lives where. The core's state without the command logs (toJSON: seats, secrets, accounts, loadouts, ready flags, results, the
// config, the answer and the timers) is saved under `room` after every message that can change it, and the room's fixed settings
// (code, build, proto, live) under `meta`. Command logs live only in memory: the clients ping every second, so a room in a run never
// hibernates, and a started room that is rebuilt anyway (an eviction mid-run) has lost the logs it would be repaired and ranked from. It
// turns every socket away with `closed { reason: "error" }`, clears its storage, and its code is free again. A lobby, or a finished room
// waiting for its 60 s to pass, is rebuilt whole: the sockets come back through the core's attach(), each with the seat kept in its
// attachment.
//
// The routes, the origin checks and the Durable Object binding are the Worker's (5.2). This class answers two things: `POST /create`
// with { code, build, proto, live }, and a WebSocket upgrade.

import { createRoomCore } from './coop/room-core.js';
import { encode, validCode } from './coop/protocol.js';
import { scoreAccounts } from './accounts-api.js';
import { insertCoopRun } from './coop-api.js';

/**
 * What the room needs from outside, in one place so the later tasks (and the tests) replace it without touching the class.
 *  - sessionForToken(token, env): the account behind a sign-in token, as scoreAccounts.sessionForToken answers:
 *    { id, username }, or anything else (unauthorized, unavailable) for a guest seat.
 *  - rank(row, env): writes a cleared run to the CO-OP board (insertCoopRun) and answers { ok: true } or
 *    { ok: false, reason: 'unavailable' }; the core only asks for a row after its own checks (live room, two signed-in seats, matching results).
 *  - now, socketPair, upgradeResponse: the clock and the two Workers-runtime pieces, so the tests can run the class in node.
 */
export const coopDeps = {
  sessionForToken: (token, env) => scoreAccounts.sessionForToken(token, env),
  rank: (row, env) => insertCoopRun(env, row),
  now: () => Date.now(),
  socketPair: () => {
    const pair = new WebSocketPair();
    return { client: pair[0], server: pair[1] };
  },
  upgradeResponse: client => new Response(null, { status: 101, webSocket: client }),
};

/** A room that ended in the ordinary way closes its sockets normally; one that turned a socket away is a policy close. */
const NORMAL_CLOSE = new Set(['done', 'expired', 'idle']);
/** The messages that change nothing the room saves: a command, a state hash and a ping. */
const HOT = new Set(['cmd', 'hash', 'ping']);
/** The longest body of /create (the real one is about 70 bytes). */
const CREATE_BODY_MAX = 1024;

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = length => base64url(crypto.getRandomValues(new Uint8Array(length)));

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

// The type of a message text, read the way the core reads it (JSON.parse), so a text is "hot" exactly when the core takes it for one.
function typeOf(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text)?.type ?? null;
  } catch {
    return null;
  }
}

// Tells a socket its room is gone (or was never there) and closes it. The socket may already be closed.
function turnAway(ws) {
  try {
    ws.send(encode({ type: 'closed', reason: 'error' }));
  } catch {
    /* the socket is gone */
  }
  try {
    ws.close(1008, 'error');
  } catch {
    /* the socket is gone */
  }
}

export class CoopRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.core = null; // null while no room is held (never created, closed, or lost to an eviction)
    this.conns = new Map(); // attachment id -> { id, ws, seat }; the core's `conn`
    this.alarmAt = null; // the alarm as last set
    this.lastSaved = null; // the `room` text as last written, so a message that changed nothing writes nothing
    this.settling = false;
    // Everything below waits for the saved state to be read; the runtime holds other events back until it is (and the handlers wait too).
    this.ready = ctx.blockConcurrencyWhile(() => this.load());
  }

  // ---- rebuilding after hibernation or an eviction ----

  async load() {
    const { storage } = this.ctx;
    const stored = await storage.get(['meta', 'room']);
    this.alarmAt = (await storage.getAlarm()) ?? null;
    const meta = stored.get('meta');
    const saved = stored.get('room');
    if (!meta || !saved) {
      if (meta || saved) await this.bury(); // half a room cannot be built
      return;
    }
    if (saved.started && !saved.answer) {
      // A run was under way and the object was evicted: its command logs are gone, so it can neither be repaired nor ranked.
      for (const ws of this.ctx.getWebSockets()) turnAway(ws);
      await this.bury();
      return;
    }
    this.core = this.makeCore(meta, saved);
    for (const ws of this.ctx.getWebSockets()) {
      const kept = ws.deserializeAttachment();
      if (!kept || typeof kept.conn !== 'string') {
        turnAway(ws);
        continue;
      }
      const conn = { id: kept.conn, ws, seat: kept.seat === 0 || kept.seat === 1 ? kept.seat : null };
      this.conns.set(conn.id, conn);
      this.core.attach(conn, conn.seat);
    }
    // The alarm is checked against the core's deadline on every rebuild, so a room whose alarm was lost still ends.
    await this.after(false);
  }

  makeCore(meta, saved) {
    return createRoomCore({
      code: meta.code,
      build: meta.build,
      proto: meta.proto,
      live: meta.live,
      now: () => coopDeps.now(),
      send: (conn, msg) => conn.ws.send(encode(msg)),
      close: (conn, reason) => conn.ws.close(NORMAL_CLOSE.has(reason) ? 1000 : 1008, reason),
      verify: token => this.verify(token),
      rank: row => this.rank(row),
      randomSecret: () => randomToken(16),
      saved,
    });
  }

  // The core's session check: the account behind a token, or null (a guest seat) for anything but a good session.
  async verify(token) {
    try {
      const found = await coopDeps.sessionForToken(token, this.env);
      if (!found || found.unauthorized || found.unavailable || found.id === undefined || found.id === null || typeof found.username !== 'string') return null;
      return { accountId: found.id, username: found.username };
    } finally {
      this.later();
    }
  }

  async rank(row) {
    try {
      return await coopDeps.rank(row, this.env);
    } finally {
      this.later();
    }
  }

  // The core's promises (a session check, a board write) settle outside any message: once they have, the room is saved and its alarm
  // moved. The timer runs after the core's own continuation of the same promise.
  later() {
    if (this.settling) return;
    this.settling = true;
    setTimeout(() => {
      this.settling = false;
      this.ready.then(() => this.after(true)).catch(err => console.error('coop-room: settle', err));
    }, 0);
  }

  // ---- saving, the alarm, closing ----

  // After anything that ran the core: a closed room is cleared, otherwise it is saved (unless `hot`) and its alarm set to the core's
  // next deadline. A hot message (a command, a hash, a ping) saves nothing and only moves the alarm earlier, never later: an alarm that
  // fires early finds nothing due and sets the right one.
  async after(save, hot = false) {
    const core = this.core;
    if (!core) return;
    if (core.closedReason) return this.bury();
    if (save) {
      const state = core.toJSON();
      const text = JSON.stringify(state);
      if (text !== this.lastSaved) {
        await this.ctx.storage.put('room', state);
        if (this.core !== core) return;
        this.lastSaved = text;
      }
    }
    const at = core.nextDeadline();
    if (at === null) {
      if (this.alarmAt !== null) {
        this.alarmAt = null;
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }
    if (at === this.alarmAt) return;
    if (hot && this.alarmAt !== null && this.alarmAt > coopDeps.now() && this.alarmAt <= at) return;
    this.alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }

  // The room is over (closed, lost, or half-saved): its storage and alarm go, so its code can be drawn again.
  async bury() {
    this.core = null;
    this.conns.clear();
    this.alarmAt = null;
    this.lastSaved = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // The core's connection for a socket, by the id kept in its attachment (null when the object does not know it).
  connFor(ws) {
    const kept = ws.deserializeAttachment();
    return kept && typeof kept.conn === 'string' ? (this.conns.get(kept.conn) ?? null) : null;
  }

  // Keeps the seat a connection holds in its socket attachment, where a rebuilt object finds it.
  syncSeat(conn) {
    const seat = this.core ? this.core.seatOf(conn) : null;
    if (seat === conn.seat) return;
    conn.seat = seat;
    try {
      conn.ws.serializeAttachment({ conn: conn.id, seat });
    } catch {
      /* the socket is gone */
    }
  }

  // ---- the Durable Object's events ----

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/create') return this.create(request);
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() === 'websocket') return this.accept();
    return this.core ? reply(426, { error: 'a WebSocket upgrade is needed' }) : reply(404, { error: 'not found' });
  }

  // POST /create { code, build, proto, live }: starts the room. 409 while this name holds a room that has not closed.
  async create(request) {
    let body;
    try {
      const text = await request.text();
      if (text.length > CREATE_BODY_MAX) return reply(400, { error: 'bad request' });
      body = JSON.parse(text);
    } catch {
      return reply(400, { error: 'bad request' });
    }
    const ok = body && validCode(body.code) && typeof body.build === 'string' && body.build.length >= 1 && body.build.length <= 40 && Number.isSafeInteger(body.proto) && typeof body.live === 'boolean';
    if (!ok) return reply(400, { error: 'bad request' });
    if (this.core) return reply(409, { error: 'this code is in use' });
    const meta = { code: body.code, build: body.build, proto: body.proto, live: body.live };
    const core = this.makeCore(meta, null);
    const state = core.toJSON();
    await this.ctx.storage.put({ meta, room: state });
    this.core = core;
    this.lastSaved = JSON.stringify(state);
    await this.after(false);
    return reply(200, { ok: true, code: meta.code });
  }

  // A WebSocket upgrade: accepted with the Hibernation API, kept as { conn } in its attachment, handed to the core.
  async accept() {
    const core = this.core;
    if (!core) return reply(404, { error: 'not found' });
    const { client, server } = coopDeps.socketPair();
    this.ctx.acceptWebSocket(server);
    const conn = { id: randomToken(9), ws: server, seat: null };
    server.serializeAttachment({ conn: conn.id, seat: null });
    this.conns.set(conn.id, conn);
    this.run(conn, () => core.open(conn));
    try {
      await this.after(false);
    } catch (err) {
      // The client never gets this socket, so the server half must not be left behind.
      this.conns.delete(conn.id);
      this.run(conn, () => core.dropped(conn));
      turnAway(server);
      throw err;
    }
    return coopDeps.upgradeResponse(client);
  }

  // Runs something on the core. A bug in the core must not take the object down: that socket is cut.
  run(conn, fn) {
    try {
      fn();
    } catch (err) {
      console.error('coop-room: core', err);
      try {
        conn.ws.close(1011, 'error');
      } catch {
        /* the socket is gone */
      }
      try {
        this.core?.dropped(conn);
      } catch {
        /* the core is beyond help for this socket */
      }
    }
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    const conn = this.connFor(ws);
    if (!this.core || !conn) return turnAway(ws);
    this.run(conn, () => this.core.message(conn, message));
    // A seat the core took from another connection (a resume) is cleared from that socket's attachment too.
    for (const other of this.conns.values()) this.syncSeat(other);
    const hot = HOT.has(typeOf(message));
    await this.after(!hot, hot);
  }

  async webSocketClose(ws, code) {
    await this.ready;
    // 1005, 1006 and 1015 only ever describe a close; they cannot be sent back. The peer's reason is not echoed (123-byte limit).
    try {
      ws.close(code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1000, '');
    } catch {
      /* already closed */
    }
    await this.dropped(ws);
  }

  async webSocketError(ws) {
    await this.ready;
    await this.dropped(ws);
  }

  async dropped(ws) {
    const conn = this.connFor(ws);
    if (!conn) return;
    this.conns.delete(conn.id);
    if (!this.core) return;
    this.run(conn, () => this.core.dropped(conn));
    await this.after(true);
  }

  async alarm() {
    await this.ready;
    this.alarmAt = null;
    if (!this.core) return;
    try {
      this.core.tick();
    } catch (err) {
      console.error('coop-room: tick', err);
    }
    await this.after(true);
  }
}
