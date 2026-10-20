// The co-op relay protocol (co-op Expedition spec 8, PROTOCOL_VERSION 1): the JSON messages a client and the relay trade, the checks that
// turn a text from the wire into a message or null, the size and rate limits, the room codes and the check of the Expedition config. Every
// message is an object with a `type` (`t` is always a tick). The dev relay, the room client, the lockstep driver and the Cloudflare Worker
// all read this vocabulary, and the site keeps a byte-identical copy of this file for the Worker, so it has NO imports and no browser or Node
// API beyond TextEncoder (which both have) and plain ES. decode never throws: anything off the wire that is not exactly a known message
// comes back as null, and a message comes back as a fresh object holding only its own fields. The game's own range check of a command
// (validCommand, src/game/commands.js) runs in the client; here a command is checked for shape only.

export const PROTOCOL_VERSION = 1;

export const MAX_BYTES = 4096; // the longest message, in UTF-8 bytes
export const MAX_RATE = 40; // messages per second per socket (and the burst)
export const MAX_BATCH = 60; // commands in one cmd message

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0 or 1
export const CODE_LENGTH = 6;

const EXPEDITION_STAMP = "expedition-1"; // a copy of data/expedition.js: tests/protocol.test.mjs pins it
// A copy of the keys of EVENTS in game/commands.js (the run-changing UI actions a command can carry): the tests pin it as well.
const EVENT_NAMES = ["pick", "reroll", "banish", "choose", "resume", "speed", "skip", "leave"];
const MAX_EVENTS = 4;
const MAX_EVENT_ITEMS = 3; // an event is its name and at most two integers (the game's events take none or one)
const COMMAND_LIMIT = 65535; // the shape check's bound on each of a command's ten numbers
const ID = /^[a-z0-9-]{1,24}$/;
const OUTCOMES = ["cleared", "lost", "left", "desync"];
const CLOSE_REASONS = ["version", "full", "expired", "idle", "error", "done"];
const WORLDS = 6;
const UINT32 = 4294967295;

const isInt = (x) => Number.isSafeInteger(x);
const isIntFrom = (x, min) => Number.isSafeInteger(x) && x >= min;
const isIntIn = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;
const isUint32 = (x) => isIntIn(x, 0, UINT32);
const isText = (x, max) => typeof x === "string" && x.length <= max;
const isId = (x) => typeof x === "string" && ID.test(x);
const isLoadout = (x) => Array.isArray(x) && x.length === 2 && isId(x[0]) && isId(x[1]);
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// The length of a text in UTF-8 bytes. Under a third of the limit in characters is under the limit in bytes, so only a long text is measured.
function byteLength(text) {
  return text.length * 3 <= MAX_BYTES ? text.length : new TextEncoder().encode(text).length;
}

// A command, by shape only (spec 5.2): an array of 10 or 11 items, the first ten integers within +-65535, the eleventh (only when there
// are events) at most four arrays, each a known event name followed by integers. validCommand does the range of each slot.
export function isCommandShape(c) {
  if (!Array.isArray(c) || (c.length !== 10 && c.length !== 11)) return false;
  for (let i = 0; i < 10; i++) if (!isIntIn(c[i], -COMMAND_LIMIT, COMMAND_LIMIT)) return false;
  if (c.length === 10) return true;
  const events = c[10];
  if (!Array.isArray(events) || events.length > MAX_EVENTS) return false;
  for (const e of events) {
    if (!Array.isArray(e) || e.length > MAX_EVENT_ITEMS || !EVENT_NAMES.includes(e[0])) return false;
    for (let i = 1; i < e.length; i++) if (!isInt(e[i])) return false;
  }
  return true;
}

const isBatch = (c) => Array.isArray(c) && c.length >= 1 && c.length <= MAX_BATCH && c.every(isCommandShape);

// The config of an Expedition on the wire (spec 5.2 and 8): what the host hands over, which every machine completes the same way
// (expeditionRunConfig). Two heroes in seat order. The developer fields (heroes that take no damage, a ramp that starts late) never travel,
// whatever their value, so a relayed run is always a real one.
export function validConfig(c) {
  if (!isObject(c)) return false;
  if (c.kind !== "expedition" || c.proto !== PROTOCOL_VERSION || c.stamp !== EXPEDITION_STAMP || c.lockstep !== true) return false;
  if (Object.hasOwn(c, "devInvulnerable") || Object.hasOwn(c, "rampMinute")) return false;
  if (typeof c.build !== "string" || !isUint32(c.seed) || !isIntIn(c.world, 1, WORLDS)) return false;
  if (!Array.isArray(c.heroes) || c.heroes.length !== 2) return false;
  for (let seat = 0; seat < 2; seat++) {
    const h = c.heroes[seat];
    if (!isObject(h) || h.seat !== seat || !isText(h.name, 24) || !isLoadout(h.loadout) || !isId(h.look)) return false;
  }
  return true;
}

// The other seat's lobby and connection state: the body of a `peer` message and the optional `peer` of a `welcome`. `ping` is the
// partner's round trip to the relay (ms), passed on so the lobby shows both pings (spec 3.1).
const peerOk = (m) => isText(m.name, 24) && isLoadout(m.loadout) && isId(m.look) && typeof m.ready === "boolean" && typeof m.connected === "boolean" && isIntIn(m.ping, 0, 9999);
const peerOf = (m) => ({ name: m.name, loadout: [...m.loadout], look: m.look, ready: m.ready, connected: m.connected, ping: m.ping });

// Each message type: `ok(m)` checks the parsed object's fields and `pick(m)` builds the clean copy to return (optional fields only when
// present). The tables are the spec's 8.1 and 8.2 with the Stage 4 additions (`cmd.n`, `hello.got`, `closed: done`, the lobby pings).
const CLIENT = {
  hello: {
    ok: (m) => isInt(m.proto) && isText(m.build, 40) && isText(m.name, 24) && (m.token === undefined || isText(m.token, 64)) && (m.resume === undefined || isText(m.resume, 64)) && (m.got === undefined || isIntFrom(m.got, -1)),
    pick: (m) => {
      const out = { type: "hello", proto: m.proto, build: m.build, name: m.name };
      if (m.token !== undefined) out.token = m.token;
      if (m.resume !== undefined) out.resume = m.resume;
      if (m.got !== undefined) out.got = m.got;
      return out;
    },
  },
  lobby: {
    ok: (m) => isLoadout(m.loadout) && isId(m.look) && typeof m.ready === "boolean" && isIntIn(m.ping, 0, 9999),
    pick: (m) => ({ type: "lobby", loadout: [...m.loadout], look: m.look, ready: m.ready, ping: m.ping }),
  },
  config: { ok: (m) => validConfig(m.config), pick: (m) => ({ type: "config", config: m.config }) },
  cmd: {
    ok: (m) => isIntFrom(m.t, 0) && isIntFrom(m.n, 0) && isBatch(m.c),
    pick: (m) => ({ type: "cmd", t: m.t, n: m.n, c: m.c }),
  },
  hash: { ok: (m) => isIntFrom(m.t, 0) && isUint32(m.h), pick: (m) => ({ type: "hash", t: m.t, h: m.h }) },
  ping: { ok: (m) => isInt(m.id), pick: (m) => ({ type: "ping", id: m.id }) },
  result: {
    ok: (m) => isIntFrom(m.t, 0) && OUTCOMES.includes(m.outcome) && isIntFrom(m.clearTicks, 0) && isIntFrom(m.kills, 0) && isIntIn(m.crystals, 0, 3) && isUint32(m.h),
    pick: (m) => ({ type: "result", t: m.t, outcome: m.outcome, clearTicks: m.clearTicks, kills: m.kills, crystals: m.crystals, h: m.h }),
  },
  leave: { ok: () => true, pick: () => ({ type: "leave" }) },
};

const SERVER = {
  welcome: {
    ok: (m) => isIntIn(m.seat, 0, 1) && validCode(m.code) && isText(m.secret, 64) && (m.peer === undefined || (isObject(m.peer) && peerOk(m.peer))) && isIntFrom(m.have, -1),
    pick: (m) => {
      const out = { type: "welcome", seat: m.seat, code: m.code, secret: m.secret };
      if (m.peer !== undefined) out.peer = peerOf(m.peer);
      out.have = m.have;
      return out;
    },
  },
  peer: { ok: peerOk, pick: (m) => ({ type: "peer", ...peerOf(m) }) },
  config: CLIENT.config,
  start: { ok: () => true, pick: () => ({ type: "start" }) },
  // The partner's commands, in order. The relay may pass on the sender's `n` (its current tick); on a resume it sends everything after
  // the client's last tick, in batches.
  cmd: {
    ok: (m) => isIntFrom(m.t, 0) && (m.n === undefined || isIntFrom(m.n, 0)) && isBatch(m.c),
    pick: (m) => (m.n === undefined ? { type: "cmd", t: m.t, c: m.c } : { type: "cmd", t: m.t, n: m.n, c: m.c }),
  },
  pong: { ok: (m) => isInt(m.id), pick: (m) => ({ type: "pong", id: m.id }) },
  peerGone: { ok: (m) => isIntFrom(m.t, 0), pick: (m) => ({ type: "peerGone", t: m.t }) },
  desync: { ok: (m) => isIntFrom(m.t, 0), pick: (m) => ({ type: "desync", t: m.t }) },
  ranked: {
    ok: (m) => typeof m.ok === "boolean" && (m.reason === undefined || isText(m.reason, 120)),
    pick: (m) => (m.reason === undefined ? { type: "ranked", ok: m.ok } : { type: "ranked", ok: m.ok, reason: m.reason }),
  },
  closed: { ok: (m) => CLOSE_REASONS.includes(m.reason), pick: (m) => ({ type: "closed", reason: m.reason }) },
};

const TABLES = new Map([["client", new Map(Object.entries(CLIENT))], ["server", new Map(Object.entries(SERVER))]]);

// The text to send for a message. Throws when it is longer than MAX_BYTES (the receiver would refuse it).
export function encode(msg) {
  const text = JSON.stringify(msg);
  if (typeof text !== "string") throw new TypeError("protocol.encode: the message cannot be written as JSON");
  const bytes = byteLength(text);
  if (bytes > MAX_BYTES) throw new RangeError(`protocol.encode: the message is ${bytes} bytes, more than the ${MAX_BYTES} byte limit`);
  return text;
}

// The message in a text from the wire, or null: `from` is "client" (read by the relay) or "server" (read by a client). Null for a text
// that is not a string, is over MAX_BYTES, is not JSON, has an unknown `type` for that side, or has a missing or mistyped field.
export function decode(text, from) {
  const table = TABLES.get(from);
  // A text with more UTF-16 units than MAX_BYTES has at least that many UTF-8 bytes, so it is refused without being encoded.
  if (!table || typeof text !== "string" || text.length > MAX_BYTES || byteLength(text) > MAX_BYTES) return null;
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(m) || typeof m.type !== "string") return null;
  const entry = table.get(m.type);
  return entry && entry.ok(m) ? entry.pick(m) : null;
}

// A room code (spec 3.1): CODE_LENGTH characters of CODE_ALPHABET. `randomInt(n)` returns an integer below n (the relay's own source of
// randomness; this file holds none).
export function randomCode(randomInt) {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function validCode(s) {
  if (typeof s !== "string" || s.length !== CODE_LENGTH) return false;
  for (let i = 0; i < CODE_LENGTH; i++) if (!CODE_ALPHABET.includes(s[i])) return false;
  return true;
}

// A token bucket of `max` messages that refills `max` per second: a burst of `max`, then `max` a second. `now()` is the clock in ms
// (the relay passes its own; a clock that steps back refills nothing). allow() takes one token and says whether there was one.
export function createRateLimit({ max = MAX_RATE, now = () => Date.now() } = {}) {
  let tokens = max;
  let last = now();
  return {
    allow() {
      const at = now();
      if (at > last) {
        tokens = Math.min(max, tokens + ((at - last) * max) / 1000);
        last = at;
      }
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
