// Anonymous player metrics on the leaderboard Worker: the game sends one small report when a real run ends (a
// coarse allow-list of values, never a name, account, IP address, score, exact time or timestamp), and this module
// turns it into one-dimensional daily counters (server/stats-counters.js). It holds the strict validation of a
// report, the counter rows it makes and the POST route (the admin read is added below it).
import { HOSTS } from '../site.hosts.mjs';
import { json } from './admin-auth.js';
import { ipLimitKey } from './accounts-api.js';
import { ensureStatsTable, reportStatements, utcDay } from './stats-counters.js';
export { COUNTER_METRICS as STATS_METRICS } from './stats-counters.js';

/** A report is refused above this many bytes (the real one is about 150). */
export const STATS_BODY_MAX = 512;
/** The shape of the free-text values (game version, character id, weapon id): short, plain, no spaces. */
export const DIM_PATTERN = /^[a-z0-9._-]{1,24}$/i;

const FIELDS = ['character', 'device', 'first', 'game', 'length', 'outcome', 'stage', 'v', 'weapon'];
const DEVICES = ['desktop', 'phone', 'tablet'];
const OUTCOMES = ['win', 'death'];
const LENGTHS = ['u2', '2-5', '5-10', '10-20', '20-40', 'o40'];
const isDim = value => typeof value === 'string' && DIM_PATTERN.test(value);

/**
 * Checks a parsed report exactly: the nine fields and no others, each of the right kind, nothing coerced or trimmed
 * (case is kept as sent). -> { value: Report } or { error }. Report = { v: 1, game, device, character, weapon,
 * stage (1 to 6), outcome ('win' | 'death'), length (a bucket), first (boolean) }.
 */
export function validateReport(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'Invalid report' };
  const keys = Object.keys(payload).sort();
  if (keys.length !== FIELDS.length || keys.some((key, i) => key !== FIELDS[i])) return { error: 'Invalid report fields' };
  if (payload.v !== 1) return { error: 'Invalid report version' };
  if (!isDim(payload.game)) return { error: 'Invalid game' };
  if (!DEVICES.includes(payload.device)) return { error: 'Invalid device' };
  if (!isDim(payload.character)) return { error: 'Invalid character' };
  if (!isDim(payload.weapon)) return { error: 'Invalid weapon' };
  if (!Number.isInteger(payload.stage) || payload.stage < 1 || payload.stage > 6) return { error: 'Invalid stage' };
  if (!OUTCOMES.includes(payload.outcome)) return { error: 'Invalid outcome' };
  if (!LENGTHS.includes(payload.length)) return { error: 'Invalid length' };
  if (typeof payload.first !== 'boolean') return { error: 'Invalid first flag' };
  const { v, game, device, character, weapon, stage, outcome, length, first } = payload;
  return { value: { v, game, device, character, weapon, stage, outcome, length, first } };
}

/** The counter rows [metric, dim] one valid report makes, in this order (players only on the day's first run, wins only on a win). */
export function reportRows(report) {
  const rows = [];
  if (report.first) rows.push(['players', 'all']);
  rows.push(['runs', 'all']);
  if (report.outcome === 'win') rows.push(['wins', 'all']);
  rows.push(['stage_reached', String(report.stage)], ['character', report.character], ['weapon', report.weapon], ['device', report.device], ['version', report.game], ['length', report.length]);
  return rows;
}

/** The one origin that may report: the live game. The gate is this Origin header, never the host the request came to. */
export const STATS_ORIGIN = HOSTS.live;
const PREFLIGHT = Object.freeze({ 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });

/** Reads a request body as text, stopping as soon as it passes max bytes (the declared length is never trusted). */
export async function readBodyCapped(request, max) {
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); // no Buffer: the Worker runtime has none without a compatibility flag
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return { text: new TextDecoder().decode(bytes) };
}

/**
 * POST /api/stats: counts one anonymous run report. Order, each step returning before the next: the Origin gate,
 * the preflight, the method, the per-IP limiter (a keyed hash; skipped when there is no signing key, never a raw
 * address), the content type, the capped body, strict validation, then ONE database batch. The only request data it
 * reads are the Origin, the Content-Type and, inside the limiter key, the sender's address; nothing about the sender
 * is stored, logged or returned. -> a Response, or null when the path is not ours.
 */
export async function handleStats(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/stats') return null;
  const origin = request.headers.get('Origin');
  if (origin !== STATS_ORIGIN) return json({ error: 'forbidden_origin' }, 403);
  const cors = { 'Access-Control-Allow-Origin': STATS_ORIGIN, Vary: 'Origin' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...PREFLIGHT } });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, STATS_ORIGIN, { Allow: 'POST, OPTIONS' });
  if (env.ACCOUNTS_RATE_LIMITER && typeof env.ACCOUNTS_RATE_LIMITER.limit === 'function') {
    const key = await ipLimitKey(request, env, 'stats');
    if (key && (await env.ACCOUNTS_RATE_LIMITER.limit({ key })).success === false) {
      return json({ error: 'rate_limited' }, 429, STATS_ORIGIN, { 'Retry-After': '60' });
    }
  }
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'bad_shape' }, 400, STATS_ORIGIN);
  const body = await readBodyCapped(request, STATS_BODY_MAX);
  if (body.tooLarge) return json({ error: 'too_large' }, 413, STATS_ORIGIN);
  let payload;
  try { payload = JSON.parse(body.text); } catch { return json({ error: 'bad_json' }, 400, STATS_ORIGIN); }
  const checked = validateReport(payload);
  if (checked.error) return json({ error: checked.error }, 400, STATS_ORIGIN);
  if (!env.DB) return json({ error: 'unavailable' }, 503, STATS_ORIGIN);
  try {
    await ensureStatsTable(env.DB);
    await env.DB.batch(reportStatements(env.DB, utcDay(Date.now()), reportRows(checked.value)));
  } catch (error) {
    console.error('Stats write failed', error?.message || 'unknown error');
    return json({ error: 'unavailable' }, 503, STATS_ORIGIN);
  }
  return new Response(null, { status: 204, headers: { ...cors, 'Cache-Control': 'no-store' } });
}
