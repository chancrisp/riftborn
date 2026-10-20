// The co-op relay's HTTP face on the leaderboard Worker (Task 5.2): who may open a room, how fast, and the hand-off into the
// CoopRoom Durable Object (server/coop-room.js). Every answer is JSON with Cache-Control: no-store and Vary: Origin; CORS is
// offered to co-op origins only. No token is ever echoed, and no address is stored (the rate limit key is a keyed hash, as for
// scores and stats; the raw address only when the Worker holds no signing key).
//   OPTIONS *                       the preflight (co-op origins)
//   POST /coop/rooms { build, proto }   opens a room -> 201 { code }
//   GET  /coop/rooms/:code/ws          the WebSocket upgrade, forwarded to the room unchanged
//   GET  /coop/board                   the Expedition board (Task 5.3); 501 until then
import { HOSTS } from '../site.hosts.mjs';
import { ipLimitKey, ipSubject } from './accounts-api.js';
import { readBodyCapped } from './stats-api.js';
import { randomCode, validCode } from './coop/protocol.js';

/** A create request is refused above this many bytes (the real one is about 40). */
export const COOP_CREATE_BODY_MAX = 512;
/** A busy code is redrawn this many times before the create gives up. */
export const COOP_CREATE_TRIES = 5;

const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.riftborn-dev\.pages\.dev$/;
const PREFLIGHT = Object.freeze({ 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });

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
    return reply({ error: 'not yet' }, 501, origin); // Task 5.3
  }
  if (route === 'rooms') {
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, origin, { Allow: 'POST, OPTIONS' });
    if (!kind) return reply({ error: 'forbidden_origin' }, 403, null);
    return createRoom(request, env, origin, kind);
  }
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405, origin, { Allow: 'GET, OPTIONS' });
  return openSocket(request, env, origin, socket[1]);
}
