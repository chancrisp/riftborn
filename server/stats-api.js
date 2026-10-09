// Anonymous player metrics on the leaderboard Worker: the game sends one small report when a real run ends (a
// coarse allow-list of values, never a name, account, IP address, score, exact time or timestamp), and this module
// turns it into one-dimensional daily counters (server/stats-counters.js). This part holds the pure functions only:
// the strict validation of a report and the counter rows it makes. The route, the limiter and the admin read follow.
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
