// Anonymous player metrics on the leaderboard Worker: the game sends one small report when a real run ends (a
// coarse allow-list of values, never a name, account, IP address, score, exact time or timestamp), and this module
// turns it into one-dimensional daily counters (server/stats-counters.js). It holds the strict validation of a
// report, the counter rows it makes and the POST route (the admin read is added below it).
import { HOSTS } from '../site.hosts.mjs';
import { json } from './admin-auth.js';
import { ipLimitKey } from './accounts-api.js';
import { STATS_DAILY_WRITE_CEILING, WRITES_METRIC, ensureStatsTable, reportStatements, utcDay } from './stats-counters.js';
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

// ---- the admin read model ---------------------------------------------------------------------------------------

/** The windows the admin read offers: the last 7, 30 or 90 UTC days (today included), or everything. */
export const STATS_RANGES = ['7', '30', '90', 'all'];
const BREAKDOWNS = ['stage_reached', 'character', 'weapon', 'device', 'version', 'length'];
const FIXED_ORDER = { stage_reached: ['1', '2', '3', '4', '5', '6'], length: ['u2', '2-5', '5-10', '10-20', '20-40', 'o40'] };
const DAY_MS = 86400000;

/**
 * What the private stats page shows: per-day players, runs, wins and sign-ups (zero-filled, oldest first, ending
 * today, a partial UTC day); one-dimensional breakdowns summed over the window (only values with counts: stage in
 * stage order, length in bucket order, the rest by count then name); the account total; the newest day with a
 * report; and how much of today's write ceiling is used. now is milliseconds.
 */
export async function readStats(db, range, now) {
  const today = utcDay(now);
  const start = range === 'all' ? null : utcDay(Date.parse(today + 'T00:00:00Z') - (Number(range) - 1) * DAY_MS);
  const bound = start ? ' AND day >= ?' : '';
  const binds = start ? [start] : [];
  const [daily, breakdown, last, writes] = await db.batch([
    db.prepare(`SELECT day, metric, n FROM daily_stats WHERE metric IN ('players', 'runs', 'wins', 'signups') AND dim = 'all'${bound}`).bind(...binds),
    db.prepare(`SELECT metric, dim, SUM(n) AS n FROM daily_stats WHERE metric IN (${BREAKDOWNS.map(m => `'${m}'`).join(', ')})${bound} GROUP BY metric, dim`).bind(...binds),
    db.prepare("SELECT MAX(day) AS day FROM daily_stats WHERE metric = 'runs'"),
    db.prepare(`SELECT n FROM daily_stats WHERE day = ? AND metric = '${WRITES_METRIC}' AND dim = 'all'`).bind(today)
  ]);
  const byDay = new Map();
  for (const row of daily.results) byDay.set(row.day, { ...(byDay.get(row.day) || {}), [row.metric]: row.n });
  const first = start || [...byDay.keys()].sort()[0] || null;
  const days = [];
  if (first) {
    for (let ms = Date.parse(first + 'T00:00:00Z'); utcDay(ms) <= today; ms += DAY_MS) {
      const day = utcDay(ms), row = byDay.get(day) || {};
      days.push({ day, players: row.players || 0, runs: row.runs || 0, wins: row.wins || 0, signups: row.signups || 0 });
    }
  }
  const breakdowns = Object.fromEntries(BREAKDOWNS.map(metric => {
    const order = FIXED_ORDER[metric];
    const rows = breakdown.results.filter(row => row.metric === metric).map(row => ({ dim: row.dim, n: row.n }));
    rows.sort(order
      ? (a, b) => (order.indexOf(a.dim) < 0 ? order.length : order.indexOf(a.dim)) - (order.indexOf(b.dim) < 0 ? order.length : order.indexOf(b.dim)) || a.dim.localeCompare(b.dim)
      : (a, b) => b.n - a.n || (a.dim < b.dim ? -1 : a.dim > b.dim ? 1 : 0));
    return [metric, rows];
  }));
  let accountsTotal = 0;
  try {
    accountsTotal = (await db.prepare('SELECT COUNT(*) AS n FROM accounts').first('n')) || 0;
  } catch (error) {
    if (!/no such table/i.test(String(error?.message))) throw error;
  }
  return { range: String(range), days, breakdowns, accountsTotal, lastReceived: last.results[0]?.day ?? null, ceiling: { day: today, used: writes.results[0]?.n ?? 0, limit: STATS_DAILY_WRITE_CEILING } };
}
