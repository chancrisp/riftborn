// The co-op room core (co-op Expedition spec 8 and 3.9, plan Task 4.2): everything one room does, with no transport. The Node dev relay
// (tests/tools/coop-relay.mjs) and the Cloudflare Worker's Durable Object both wrap it. The wrapper hands it connections (any object),
// the clock and a few services, and the core answers by calling send(conn, msg) and close(conn, reason); it owns no timer (the wrapper
// calls tick() on its alarm and the core calls it on every message; nextDeadline() says when the next alarm is due), reads no random
// source (randomSecret is injected) and imports only the protocol, so the Worker can share the file.
//
// One room is two seats (0 the host, 1 the guest). Each seat has a secret, so a dropped player can take the seat back with `hello.resume`.
// In a run, each seat's commands are kept in an ordered log in memory (never saved by toJSON; stored as ten 32-bit numbers a command, so
// 72000 commands, a 20-minute run, are about 3 MB) and passed on to the partner; the log is what a resume is repaired from. A log cannot
// run ahead of the clock: it may hold at most one tick per 1/60 s since the start, plus CLOCK_SLACK. The core also compares the seats'
// state hashes, declares a silent or leaving seat gone, applies the ranking rules, and closes the room on its timers.
//
// send(conn, msg) is given every message the core speaks; a close is the core's `closed` message followed by close(conn, reason). A
// send or close that throws (a socket already closed) is ignored: it must not stop the core halfway through telling the other seat.
import { MAX_BATCH, MAX_RATE, createRateLimit, decode } from "./protocol.js";

export const LOBBY_MS = 600000; // a lobby without START
export const DONE_MS = 60000; // a finished room, after both results
export const MAX_MS = 5400000; // any room
export const SEAT_TIMEOUT_MS = 30000; // a seat heard from for this long is gone (a copy of EXPEDITION.seatTimeout; the tests pin it)
export const HELLO_MS = 10000; // a connection that has not said hello by now is closed

const MAX_UNSEATED = 4; // connections that have not said hello yet
const MAX_PENDING_HASHES = 8192; // hashes of one seat the partner has not matched yet
const MAX_EVENT_COMMANDS = 2000; // commands of one seat that carry events (the log keeps those apart; a real run has a few hundred)
const CLOCK_SLACK = 600; // ticks a log may be ahead of the clock (input delay, a catch-up after a stall) and a relayed `n` may be past the log
const HASH_SLACK = 2; // hash pairs a result may lack (hashes go every 60 ticks: EXPEDITION.hashEvery)
const HASH_EVERY = 60;

// One seat's commands, in tick order: a growing Int32Array of ten numbers a command (the shape check bounds each to +-65535), with the
// rare event lists kept beside it by tick.
function createLog() {
  let data = new Int32Array(10 * 256);
  let length = 0;
  const events = new Map();
  return {
    get length() {
      return length;
    },
    get eventCount() {
      return events.size;
    },
    get bytes() {
      return data.byteLength;
    },
    push(c) {
      if ((length + 1) * 10 > data.length) {
        const bigger = new Int32Array(Math.ceil((data.length * 1.5) / 10) * 10);
        bigger.set(data);
        data = bigger;
      }
      for (let k = 0; k < 10; k++) data[length * 10 + k] = c[k];
      if (c.length === 11) events.set(length, c[10]);
      length++;
    },
    // The commands from tick `from` up to (not including) `to`, as the arrays that were pushed.
    slice(from, to = length) {
      const out = [];
      for (let i = Math.max(from, 0); i < Math.min(to, length); i++) {
        const c = Array.from(data.subarray(i * 10, i * 10 + 10));
        if (events.has(i)) c.push(events.get(i));
        out.push(c);
      }
      return out;
    },
  };
}

export function createRoomCore(opts) {
  const { code, build, proto, live, now, verify, rank, randomSecret, saved = null, onClosed = null } = opts;
  const send = (conn, msg) => {
    try {
      opts.send(conn, msg);
    } catch {
      /* the socket is gone */
    }
  };
  const close = (conn, reason) => {
    try {
      opts.close(conn, reason);
    } catch {
      /* the socket is gone */
    }
  };

  const seats = [null, null];
  const conns = new Map(); // conn -> { seat: 0 | 1 | null, limit, openedAt }
  const createdAt = saved ? saved.createdAt : now();
  let lobbyUntil = saved ? saved.lobbyUntil : createdAt + LOBBY_MS;
  const maxUntil = saved ? saved.maxUntil : createdAt + MAX_MS;
  let doneUntil = saved ? (saved.doneUntil ?? null) : null;
  let started = saved ? saved.started === true : false;
  let startedAt = saved ? (saved.startedAt ?? (saved.started ? now() : null)) : null;
  let config = saved ? saved.config : null;
  let unranked = saved ? saved.unranked === true : false;
  let answer = saved ? (saved.answer ?? null) : null; // the `ranked` message, once decided
  let ranking = false; // a result is being weighed (verifying seats, the board write)
  let matched = 0; // hash pairs the two seats agreed on
  let closedReason = null;

  const blankSeat = (name, secret) => ({
    conn: null,
    name,
    secret,
    accountId: null,
    username: null,
    verifying: null,
    loadout: null,
    look: null,
    ready: false,
    ping: 0,
    known: false, // the seat has sent a lobby message, so its loadout and look are known
    lastSeen: now(),
    gone: false,
    goneTick: 0,
    log: createLog(),
    n: 0,
    hashes: new Map(),
    result: null,
  });

  if (saved) {
    saved.seats.forEach((s, i) => {
      if (!s) return;
      const seat = blankSeat(s.name, s.secret);
      Object.assign(seat, {
        accountId: s.accountId,
        username: s.username,
        loadout: s.loadout && [...s.loadout],
        look: s.look,
        ready: s.ready,
        ping: s.ping,
        known: s.known,
        gone: s.gone === true,
        goneTick: s.goneTick ?? 0,
        result: s.result ?? null,
      });
      seats[i] = seat;
    });
  }

  const alive = (seat) => seat !== null && !seat.gone;
  const peerBody = (seat) => ({ name: seat.name, loadout: [...seat.loadout], look: seat.look, ready: seat.ready, connected: seat.conn !== null, ping: seat.ping });

  // Tells the other seat how seat `i` stands (its lobby and whether it is connected).
  function tellPeer(i) {
    const seat = seats[i];
    const other = seats[1 - i];
    if (closedReason || !seat || !seat.known || !other || !other.conn) return;
    send(other.conn, { type: "peer", ...peerBody(seat) });
  }

  // The seat's socket is gone (not the seat): the partner is told, and the seat can be taken back with its secret.
  function unbind(conn, info) {
    const i = info.seat;
    info.seat = null;
    if (i === null || seats[i].conn !== conn) return;
    seats[i].conn = null;
    if (!seats[i].gone) tellPeer(i);
  }

  // Closes one connection with `reason`: the `closed` message, then the close.
  function shut(conn, reason) {
    const info = conns.get(conn);
    if (info) {
      conns.delete(conn);
      unbind(conn, info);
    }
    send(conn, { type: "closed", reason });
    close(conn, reason);
  }

  function closeRoom(reason) {
    if (closedReason) return;
    closedReason = reason;
    doneUntil = null;
    const all = [...conns.keys()];
    conns.clear();
    for (const conn of all) {
      send(conn, { type: "closed", reason });
      close(conn, reason);
    }
    if (onClosed) {
      try {
        onClosed(reason);
      } catch {
        /* the wrapper's own cleanup failed; the room is closed all the same */
      }
    }
  }

  // ---- ranking (spec 8.4) ----

  function deliver(result) {
    ranking = false;
    if (closedReason || answer) return;
    answer = result.ok ? { type: "ranked", ok: true } : { type: "ranked", ok: false, reason: result.reason ?? "unavailable" };
    doneUntil ??= now() + DONE_MS;
    for (const seat of seats) if (seat && seat.conn) send(seat.conn, answer);
  }

  // Why the pair of results cannot be ranked, before the seats' accounts are looked at (null when they can).
  //
  // The last four checks are the room's own witness of the run: a clear cannot be longer than the commands both seats sent, nor lack
  // the state hashes the two machines traded on the way (one pair a second). They stop an invented result; they cannot replay the sim,
  // so the replay check (Stage 5) stays the final authority on a ranked run.
  function refusal(a, b) {
    if (a.outcome !== b.outcome || a.clearTicks !== b.clearTicks || a.kills !== b.kills || a.h !== b.h) return "mismatch";
    if (unranked) return "unranked";
    if (a.outcome !== "cleared") return "lost";
    if (!live) return "dev";
    if (a.clearTicks > seats[0].log.length || a.clearTicks > seats[1].log.length) return "mismatch";
    if (matched < Math.floor(a.clearTicks / HASH_EVERY) - HASH_SLACK) return "mismatch";
    return null;
  }

  function boardRow(a, b) {
    const [s0, s1] = seats;
    return {
      code,
      build,
      stamp: config.stamp,
      world: config.world,
      seed: config.seed,
      clearMs: Math.round((a.clearTicks * 1000) / 60),
      kills: a.kills,
      a: { accountId: s0.accountId, username: s0.username },
      b: { accountId: s1.accountId, username: s1.username },
      hash: a.h.toString(16).padStart(8, "0"),
    };
  }

  // Called when a result arrives or a seat goes: answers both seats once the outcome is known.
  function evaluate() {
    if (!started || answer || ranking || closedReason) return;
    const [s0, s1] = seats;
    if (!s0 || !s1) return;
    if (s0.result && s1.result) {
      const reason = refusal(s0.result, s1.result);
      if (reason) return deliver({ ok: false, reason });
      ranking = true;
      const go = () => {
        // One account in both seats is one person playing alone: not a co-op clear.
        if (s0.accountId === null || s1.accountId === null || s0.accountId === s1.accountId) return deliver({ ok: false, reason: "guest" });
        return Promise.resolve()
          .then(() => rank(boardRow(s0.result, s1.result)))
          .then(
            (r) => r,
            () => ({ ok: false, reason: "unavailable" }),
          )
          .then(deliver);
      };
      const waiting = [s0.verifying, s1.verifying].filter(Boolean);
      (waiting.length ? Promise.all(waiting).then(go) : Promise.resolve(go())).catch(() => {});
    } else if ((s0.result && s1.gone) || (s1.result && s0.gone)) {
      // The partner is gone without a result, so no second result is coming.
      deliver({ ok: false, reason: "unranked" });
    }
  }

  // ---- seats going ----

  function markGone(i, why) {
    const seat = seats[i];
    if (!seat || seat.gone) return;
    seat.gone = true;
    seat.goneTick = seat.log.length;
    if (why === "timeout" && seat.conn) {
      // A socket that has said nothing for the whole timeout is let go.
      const conn = seat.conn;
      seat.conn = null;
      const info = conns.get(conn);
      if (info) {
        info.seat = null;
        conns.delete(conn);
      }
      send(conn, { type: "closed", reason: "idle" });
      close(conn, "idle");
    }
    const other = seats[1 - i];
    if (!answer) {
      // A seat that had already sent its result and then left does not unrank the run: the two results decide it.
      if (!seat.result) unranked = true;
      if (other && !other.gone && other.conn) send(other.conn, { type: "peerGone", t: seat.goneTick });
    }
    evaluate();
    const present = seats.filter(Boolean);
    if (!closedReason && present.length > 0 && present.every((s) => s.gone)) closeRoom("idle");
  }

  function tick() {
    if (closedReason) return;
    const t = now();
    if (t >= maxUntil) return closeRoom("expired");
    if (doneUntil !== null && t >= doneUntil) {
      if (!answer) deliver({ ok: false, reason: "unavailable" }); // the board write or a session check never answered
      return closeRoom("done");
    }
    if (!started && t >= lobbyUntil) return closeRoom("expired");
    for (const [conn, info] of [...conns]) if (info.seat === null && t - info.openedAt >= HELLO_MS) shut(conn, "idle");
    for (let i = 0; i < 2 && !closedReason; i++) {
      const seat = seats[i];
      if (alive(seat) && t - seat.lastSeen >= SEAT_TIMEOUT_MS) markGone(i, "timeout");
    }
  }

  function nextDeadline() {
    if (closedReason) return null;
    let next = maxUntil;
    if (doneUntil !== null) next = Math.min(next, doneUntil);
    if (!started) next = Math.min(next, lobbyUntil);
    for (const seat of seats) if (alive(seat)) next = Math.min(next, seat.lastSeen + SEAT_TIMEOUT_MS);
    for (const info of conns.values()) if (info.seat === null) next = Math.min(next, info.openedAt + HELLO_MS);
    return next;
  }

  // ---- messages ----

  function hello(conn, info, m) {
    if (info.seat !== null) return shut(conn, "error"); // a second hello
    if (m.proto !== proto || m.build !== build) return shut(conn, "version");
    let i = m.resume === undefined ? -1 : seats.findIndex((s) => s && s.secret === m.resume);
    const resumed = i >= 0;
    let seat;
    if (resumed) {
      seat = seats[i];
      if (seat.gone) return shut(conn, "error"); // a gone seat is not given back
      if (seat.conn) {
        // The old socket has not been noticed dropping yet: the new one takes the seat over.
        const old = seat.conn;
        seat.conn = null;
        const oldInfo = conns.get(old);
        if (oldInfo) {
          oldInfo.seat = null;
          conns.delete(old);
        }
        send(old, { type: "closed", reason: "error" });
        close(old, "error");
      }
    } else {
      i = seats.findIndex((s) => s === null);
      if (i < 0) return shut(conn, "full");
      seat = blankSeat(m.name, randomSecret());
      seats[i] = seat;
    }
    seat.conn = conn;
    seat.lastSeen = now();
    info.seat = i;
    if (m.token !== undefined) {
      // The session check runs on its own; a failed check leaves the seat a guest (or as it was, on a resume).
      const check = Promise.resolve()
        .then(() => verify(m.token))
        .then(
          (account) => account,
          () => null,
        )
        .then((account) => {
          if (account && seat.verifying === check) {
            seat.accountId = account.accountId;
            seat.username = account.username;
          }
        });
      seat.verifying = check;
    }

    const other = seats[1 - i];
    const welcome = { type: "welcome", seat: i, code, secret: seat.secret };
    if (other && other.known) welcome.peer = peerBody(other);
    welcome.have = seat.log.length - 1;
    send(conn, welcome);
    // A resume before the seat has any partner command may have missed the config or the start: both are said again (a client that is
    // already running ignores the repeat).
    if (resumed && started && (m.got ?? -1) === -1) {
      send(conn, { type: "config", config });
      send(conn, { type: "start" });
    }
    if (other) {
      // The partner's commands after the last tick this client holds, in batches.
      const from = Math.max((m.got ?? -1) + 1, 0);
      const missing = other.log.slice(from);
      for (let k = 0; k < missing.length; k += MAX_BATCH) {
        const c = missing.slice(k, k + MAX_BATCH);
        send(conn, { type: "cmd", t: from + k, n: Math.max(other.n, other.log.length), c });
      }
      if (other.gone && !answer) send(conn, { type: "peerGone", t: other.goneTick });
    }
    if (answer) send(conn, answer);
    tellPeer(i);
  }

  function lobbyMessage(i, seat, m) {
    if (started) return;
    seat.loadout = m.loadout;
    seat.look = m.look;
    seat.ready = m.ready;
    seat.ping = m.ping;
    seat.known = true;
    tellPeer(i);
  }

  // The run config as the room will pass it on: the known keys only, and only when it is this room's build and describes the two
  // heroes as they sent themselves (hello name, lobby loadout and look). Null when it is not.
  function checkedConfig(c) {
    if (c.build !== build || c.proto !== proto) return null;
    const heroes = [];
    for (let i = 0; i < 2; i++) {
      const h = c.heroes[i];
      const seat = seats[i];
      if (h.seat !== i || h.name !== seat.name || h.look !== seat.look || h.loadout[0] !== seat.loadout[0] || h.loadout[1] !== seat.loadout[1]) return null;
      heroes.push({ seat: i, name: h.name, loadout: [h.loadout[0], h.loadout[1]], look: h.look });
    }
    return { kind: "expedition", proto: c.proto, build: c.build, stamp: c.stamp, lockstep: true, seed: c.seed, world: c.world, heroes };
  }

  function configMessage(i, m) {
    const [s0, s1] = seats;
    if (started || i !== 0 || !s0 || !s1 || !s0.ready || !s1.ready || !s0.conn || !s1.conn || s0.gone || s1.gone) return;
    const checked = checkedConfig(m.config);
    if (!checked) return;
    started = true;
    startedAt = now();
    lobbyUntil = null;
    config = checked;
    s0.lastSeen = s1.lastSeen = startedAt;
    send(s1.conn, { type: "config", config });
    send(s0.conn, { type: "start" });
    send(s1.conn, { type: "start" });
  }

  function cmdMessage(conn, i, seat, m) {
    const have = seat.log.length;
    if (m.t > have) return shut(conn, "error"); // a gap: the batch starts after the end of the log
    const fresh = m.c.slice(have - m.t);
    if (fresh.length === 0) return;
    // The log cannot run ahead of the clock.
    if (have + fresh.length > Math.floor(((now() - startedAt) * 60) / 1000) + CLOCK_SLACK) return shut(conn, "error");
    const withEvents = fresh.reduce((count, c) => count + (c.length === 11 ? 1 : 0), 0);
    if (seat.log.eventCount + withEvents > MAX_EVENT_COMMANDS) return shut(conn, "error");
    for (const c of fresh) seat.log.push(c);
    // `n`, the sender's current tick, is passed on only inside what the log allows, so a partner can trust it.
    const length = seat.log.length;
    const n = Math.min(Math.max(m.n, length - 1), length + CLOCK_SLACK);
    seat.n = Math.max(seat.n, n);
    const other = seats[1 - i];
    if (alive(other) && other.conn) send(other.conn, { type: "cmd", t: have, n, c: fresh });
  }

  function hashMessage(conn, i, seat, m) {
    const other = seats[1 - i];
    if (!alive(other)) return;
    if (other.hashes.has(m.t)) {
      const theirs = other.hashes.get(m.t);
      other.hashes.delete(m.t);
      if (theirs === m.h) matched++;
      else {
        unranked = true;
        for (const s of seats) if (s && s.conn) send(s.conn, { type: "desync", t: m.t });
      }
      return;
    }
    if (seat.hashes.size >= MAX_PENDING_HASHES) return shut(conn, "error");
    seat.hashes.set(m.t, m.h);
  }

  function message(conn, text) {
    tick();
    if (closedReason) return;
    const info = conns.get(conn);
    if (!info) return;
    if (!info.limit.allow()) return shut(conn, "error");
    const m = decode(text, "client");
    if (!m) return shut(conn, "error");
    if (m.type === "hello") return hello(conn, info, m);
    if (info.seat === null) return shut(conn, "error"); // anything but a hello first
    const i = info.seat;
    const seat = seats[i];
    if (seat.gone) return;
    seat.lastSeen = now();
    if ((m.type === "cmd" || m.type === "hash" || m.type === "result") && !started) return shut(conn, "error");
    switch (m.type) {
      case "lobby":
        return lobbyMessage(i, seat, m);
      case "config":
        return configMessage(i, m);
      case "cmd":
        return cmdMessage(conn, i, seat, m);
      case "hash":
        return hashMessage(conn, i, seat, m);
      case "ping":
        return send(conn, { type: "pong", id: m.id });
      case "result":
        if (seat.result) return;
        seat.result = m;
        if (seats[0] && seats[1] && seats[0].result && seats[1].result) doneUntil ??= now() + DONE_MS;
        return evaluate();
      case "leave":
        return markGone(i, "leave");
    }
  }

  return {
    // A connection arrived. (A room that is already closed turns it away with the reason it closed for; one with too many connections
    // that have not said hello turns the extra away as full.)
    open(conn) {
      tick();
      conns.set(conn, { seat: null, limit: createRateLimit({ max: MAX_RATE, now }), openedAt: now() });
      if (closedReason) return shut(conn, closedReason);
      let unseated = 0;
      for (const info of conns.values()) if (info.seat === null) unseated++;
      if (unseated > MAX_UNSEATED) shut(conn, "full");
    },
    message,
    // Hands back a connection that outlived a rebuild of the wrapper (a socket that hibernated), with the seat it held (null when it had
    // not said hello). The seat itself comes from `saved`. A seat another connection holds already is not taken over: this connection
    // comes back unseated, and the hello timeout deals with it.
    attach(conn, seat = null) {
      const held = seat === 0 || seat === 1 ? seats[seat] : null;
      const takes = held !== null && held.conn === null;
      conns.set(conn, { seat: takes ? seat : null, limit: createRateLimit({ max: MAX_RATE, now }), openedAt: now() });
      if (takes) held.conn = conn;
    },
    // The connection's transport went away.
    dropped(conn) {
      const info = conns.get(conn);
      if (info) {
        conns.delete(conn);
        unbind(conn, info);
      }
      tick();
    },
    tick,
    nextDeadline,
    // 0 or 1 for the seat this connection holds, else null.
    seatOf(conn) {
      const info = conns.get(conn);
      return info ? info.seat : null;
    },
    get closedReason() {
      return closedReason;
    },
    // Bytes the two command logs hold (for the tests and the soak).
    get logBytes() {
      return seats.reduce((sum, s) => sum + (s ? s.log.bytes : 0), 0);
    },
    // Everything a restore needs except the command logs, the pending hashes and the connections: seats, names, accounts, secrets,
    // loadouts, ready flags, results and whether a seat is gone, the config, the answer and the timers.
    toJSON() {
      return {
        code,
        createdAt,
        lobbyUntil,
        maxUntil,
        doneUntil,
        startedAt,
        started,
        config,
        unranked,
        answer,
        seats: seats.map((s) =>
          s
            ? {
                name: s.name,
                accountId: s.accountId,
                username: s.username,
                secret: s.secret,
                loadout: s.loadout && [...s.loadout],
                look: s.look,
                ready: s.ready,
                ping: s.ping,
                known: s.known,
                gone: s.gone,
                goneTick: s.goneTick,
                result: s.result,
              }
            : null,
        ),
      };
    },
  };
}
