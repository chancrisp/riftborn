// The private stats page, the pure half (no DOM, no fetch, no storage): UTC day arithmetic, zero-filled day lists, the period
// totals and the headline comparison of a window against the one before it. The page (metrics.js) draws what this returns.
// A day is 'YYYY-MM-DD' (UTC); "today" is always given, never read from the clock.

const DAY_MS = 86400000;
const num = value => (Number.isFinite(Number(value)) && value !== null ? Number(value) : 0);
const dayMs = day => { const [y, m, d] = String(day).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const zeroDay = day => ({ day, players: 0, runs: 0, wins: 0, signups: 0 });
const cleanDay = row => ({ day: row.day, players: num(row.players), runs: num(row.runs), wins: num(row.wins), signups: num(row.signups) });
const hasCount = row => row.players > 0 || row.runs > 0 || row.wins > 0 || row.signups > 0;

/** The UTC day delta days after (or, negative, before) a day. */
export const addDays = (day, delta) => new Date(dayMs(day) + delta * DAY_MS).toISOString().slice(0, 10);

/** count consecutive days ending at endDay, oldest first: the rows given, gaps zero-filled, non-finite numbers read as 0. */
export function fillDays(rows, endDay, count) {
  const byDay = new Map((rows || []).map(row => [row.day, cleanDay(row)]));
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const day = addDays(endDay, -i);
    out.push(byDay.get(day) || zeroDay(day));
  }
  return out;
}

/** Sums and per-day means of a list of days. winRate is wins over runs (null with no runs). */
export function periodTotals(days) {
  const n = days.length;
  const sum = key => days.reduce((total, row) => total + num(row[key]), 0);
  const players = sum('players'), runs = sum('runs'), wins = sum('wins'), signups = sum('signups');
  return { n, playersPerDay: n ? players / n : 0, runsPerDay: n ? runs / n : 0, runs, wins, winRate: runs > 0 ? wins / runs : null, signups };
}

/**
 * The windows the headline compares. current = the N complete days before today (today is todayRow and is in no figure);
 * previous = the N days before that. history is 'short' (previous null) when the first day with any count is later than
 * 2N days back, and 'none' for range 'all' (current = the first data day to yesterday) or when there is no data at all.
 */
export function headlinePeriods(days, today, range) {
  const rows = (days || []).map(cleanDay);
  const todayRow = rows.find(row => row.day === today) || zeroDay(today);
  const first = rows.filter(hasCount).map(row => row.day).sort()[0] || null;
  if (range === 'all') {
    if (!first || first >= today) return { current: [], previous: null, todayRow, history: 'none' };
    const count = Math.round((dayMs(today) - dayMs(first)) / DAY_MS);
    return { current: fillDays(rows, addDays(today, -1), count), previous: null, todayRow, history: 'none' };
  }
  const n = Number(range);
  const current = fillDays(rows, addDays(today, -1), n);
  if (!first) return { current, previous: null, todayRow, history: 'none' };
  if (first > addDays(today, -2 * n)) return { current, previous: null, todayRow, history: 'short' };
  return { current, previous: fillDays(rows, addDays(today, -n - 1), n), todayRow, history: 'ok' };
}

/** The four headline figures with their change against the previous window (null when there is nothing to compare). */
export function compareFigures(current, previous) {
  const cur = periodTotals(current);
  const prev = previous ? periodTotals(previous) : null;
  const percent = (now, before) => (prev && Number.isFinite(before) && before !== 0 ? { kind: 'percent', value: (now - before) / before } : null);
  const winChange = cur.winRate !== null && prev && prev.winRate !== null ? { kind: 'points', value: (cur.winRate - prev.winRate) * 100 } : null;
  return [
    { id: 'players', value: cur.playersPerDay, change: percent(cur.playersPerDay, prev?.playersPerDay) },
    { id: 'runs', value: cur.runsPerDay, change: percent(cur.runsPerDay, prev?.runsPerDay) },
    { id: 'winRate', value: cur.winRate, change: winChange },
    { id: 'signups', value: cur.signups, change: percent(cur.signups, prev?.signups) }
  ];
}

// ---- chart geometry ---------------------------------------------------------------------------------------------------------

/** The five run-length buckets in order, and their labels. */
export const LENGTH_ORDER = Object.freeze(['u2', '2-5', '5-10', '10-20', '20-40', 'o40']);
export const LENGTH_LABELS = Object.freeze({ u2: 'Under 2 min', '2-5': '2-5 min', '5-10': '5-10 min', '10-20': '10-20 min', '20-40': '20-40 min', o40: 'Over 40 min' });

/** The smallest of 1, 2 or 5 times a power of ten that is at least v (1 for v <= 0): a round top for an axis. */
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 5, 10]) if (step * power >= v) return step * power;
  return 10 * power;
}

const fmt = value => String(Math.round(value * 10) / 10);
const linePath = points => points.map((p, i) => `${i ? 'L' : 'M'}${fmt(p.x)} ${fmt(p.y)}`).join('');

export const TREND_BOX = Object.freeze({ width: 640, height: 220, margin: Object.freeze({ top: 12, right: 12, bottom: 28, left: 44 }) });

/**
 * The points, line and ticks of a daily trend of players, runs or signups. With partialLast the last day (today, still
 * filling) is left out of line and joined to the last complete one by partialLine.
 */
export function trendGeometry(days, key, box = TREND_BOX, opts = {}) {
  const { margin } = box;
  const left = margin.left, right = box.width - margin.right, top = margin.top, bottom = box.height - margin.bottom;
  const values = days.map(row => num(row[key]));
  const max = niceMax(Math.max(0, ...values));
  const n = days.length;
  const xAt = i => (n === 1 ? (left + right) / 2 : left + (i * (right - left)) / (n - 1));
  const yAt = value => bottom - (value / max) * (bottom - top);
  const points = days.map((row, i) => ({ x: Math.round(xAt(i) * 10) / 10, y: Math.round(yAt(values[i]) * 10) / 10, day: row.day, value: values[i] }));
  const complete = opts.partialLast ? points.slice(0, -1) : points;
  const line = complete.length ? linePath(complete) : '';
  const partialLine = opts.partialLast && points.length >= 2 ? linePath(points.slice(-2)) : '';
  const yTicks = [0, max / 2, max].map(value => ({ y: Math.round(yAt(value) * 10) / 10, label: fmt(value) }));
  const tickIndexes = n <= 6 ? points.map((_, i) => i) : [...new Set(Array.from({ length: 6 }, (_, i) => Math.round((i * (n - 1)) / 5)))];
  const xTicks = tickIndexes.map(i => ({ x: points[i].x, label: String(days[i].day).slice(5) }));
  return { max, points, line, partialLine, yTicks, xTicks };
}

export const BAR_BOX = Object.freeze({ width: 640, rowHeight: 28, labelWidth: 150, valueWidth: 90 });

const titleCase = text => text.charAt(0).toUpperCase() + text.slice(1);
function labelOf(dim, kind) {
  if (dim === 'other') return 'Other';
  if (kind === 'stage') return `Stage ${dim}`;
  if (kind === 'length') return LENGTH_LABELS[dim] || dim;
  if (kind === 'device') return titleCase(dim);
  return dim.replace(/[-_]/g, ' ');
}

/**
 * Rows for a bar chart: sorted by count then name, everything past `top` merged into "other", shares on the total of all
 * rows, and every bucket of `order` kept (zero rows included) when an order is given. kind picks the label style:
 * 'stage', 'length', 'device', or plain text (ids with - and _ as spaces).
 */
export function barRows(rows, opts = {}) {
  const { order, top, kind = 'text' } = opts;
  const clean = (rows || []).map(row => ({ dim: String(row.dim), n: num(row.n) }));
  const total = clean.reduce((sum, row) => sum + row.n, 0);
  let list;
  if (order) {
    const byDim = new Map(clean.map(row => [row.dim, row]));
    list = [...order.map(dim => byDim.get(dim) || { dim, n: 0 }), ...clean.filter(row => !order.includes(row.dim)).sort(compareRows)];
  } else {
    list = [...clean].sort(compareRows);
    if (top && list.length > top) {
      const rest = list.slice(top);
      list = [...list.slice(0, top), { dim: 'other', n: rest.reduce((sum, row) => sum + row.n, 0) }];
    }
  }
  return list.map(row => ({ dim: row.dim, label: labelOf(row.dim, kind), n: row.n, share: total > 0 ? row.n / total : 0 }));
}
const compareRows = (a, b) => b.n - a.n || (a.dim < b.dim ? -1 : a.dim > b.dim ? 1 : 0);

/** Bar rectangles for rows (from barRows): the longest bar fills the room between the label and the value; a zero count is width 0. */
export function barGeometry(rows, box = BAR_BOX) {
  const room = box.width - box.labelWidth - box.valueWidth;
  const max = Math.max(0, ...rows.map(row => row.n));
  const bars = rows.map((row, i) => ({ x: box.labelWidth, y: i * box.rowHeight + 4, width: max > 0 ? (row.n / max) * room : 0, height: box.rowHeight - 8, dim: row.dim, label: row.label, n: row.n, share: row.share }));
  return { height: rows.length * box.rowHeight, bars };
}

/** How many runs reached each stage 1..6: a run that ended at stage k also reached every stage before it. Dims outside 1..6 are ignored. */
export function reachedCounts(stageReached) {
  const reached = [0, 0, 0, 0, 0, 0];
  for (const row of stageReached || []) {
    const stage = Number(row.dim);
    if (!Number.isInteger(stage) || stage < 1 || stage > 6) continue;
    for (let k = 0; k < stage; k++) reached[k] += num(row.n);
  }
  return reached;
}

/** The funnel: each stage's count, its share of stage 1, the loss against the previous stage, and the single biggest drop. */
export function funnelSteps(reached) {
  const steps = reached.map((count, i) => ({
    stage: i + 1,
    reached: count,
    share: reached[0] > 0 ? count / reached[0] : 0,
    lostShare: i > 0 && reached[i - 1] > 0 ? (reached[i - 1] - count) / reached[i - 1] : null,
    biggestDrop: false
  }));
  let best = 0, at = -1;
  steps.forEach((step, i) => { if (step.lostShare !== null && step.lostShare > best) { best = step.lostShare; at = i; } });
  if (at >= 0) steps[at].biggestDrop = true;
  return steps;
}

// ---- the answer of the Worker, and the view the page draws ----------------------------------------------------------------

const DIM = /^[a-z0-9._-]{1,24}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BREAKDOWN_KEYS = ['stage_reached', 'character', 'weapon', 'device', 'version', 'length'];
const UNEXPECTED = 'Unexpected answer from the Worker';

/**
 * Checks and cleans the answer of GET /api/admin/stats. Throws 'Unexpected answer from the Worker' when days is not an
 * array, a breakdown is missing, or ceiling.day is not YYYY-MM-DD; drops breakdown rows whose dim is not a plain id or whose
 * count is not a finite number of 0 or more; sorts the days ascending.
 */
export function parseStats(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.days) || !json.breakdowns || typeof json.breakdowns !== 'object') throw new Error(UNEXPECTED);
  if (!json.ceiling || typeof json.ceiling.day !== 'string' || !DAY.test(json.ceiling.day)) throw new Error(UNEXPECTED);
  const breakdowns = {};
  for (const key of BREAKDOWN_KEYS) {
    if (!Array.isArray(json.breakdowns[key])) throw new Error(UNEXPECTED);
    breakdowns[key] = json.breakdowns[key].filter(row => row && typeof row.dim === 'string' && DIM.test(row.dim) && Number.isFinite(row.n) && row.n >= 0).map(row => ({ dim: row.dim, n: row.n }));
  }
  const days = json.days.filter(row => row && typeof row.day === 'string' && DAY.test(row.day)).map(cleanDay).sort((a, b) => (a.day < b.day ? -1 : 1));
  return {
    range: String(json.range ?? '30'),
    days,
    breakdowns,
    accountsTotal: num(json.accountsTotal),
    lastReceived: typeof json.lastReceived === 'string' ? json.lastReceived : null,
    ceiling: { day: json.ceiling.day, used: num(json.ceiling.used), limit: num(json.ceiling.limit) }
  };
}

/** What each number on the page means, in plain words (shown under "What do these mean?"). */
export const DEFINITIONS = Object.freeze([
  { id: 'players', title: 'Players', text: 'Devices that finished a real run on a day, counted once per device per UTC day. The headline shows the average per day. Players who never finish a run, and anyone who opted out, are not counted.' },
  { id: 'runs', title: 'Runs', text: 'Finished real runs: a win, a death or END RUN. Practice, the tutorial, the demo and developer runs are never counted.' },
  { id: 'winRate', title: 'Win rate', text: 'Wins divided by runs in the same period.' },
  { id: 'signups', title: 'Sign-ups', text: 'Accounts created in the period.' },
  { id: 'accounts', title: 'Accounts', text: 'The total number of accounts today. It is not part of the daily counters.' },
  { id: 'stage', title: 'Stage reached', text: 'The furthest stage a run reached. A win counts as stage 6, "finished the route", whichever route was played. The funnel adds every run that reached a stage or went further.' },
  { id: 'length', title: 'Run length', text: 'How long a run lasted, in six buckets from under 2 minutes to over 40.' },
  { id: 'character', title: 'Character', text: 'The character worn when the run started.' },
  { id: 'weapon', title: 'Weapon', text: 'The weapon that did the most damage in the run.' },
  { id: 'device', title: 'Device', text: 'Desktop, phone or tablet, guessed from the screen and the pointer.' },
  { id: 'version', title: 'Game version', text: 'The version of the game the run was played on, newest first.' },
  { id: 'lowerBound', title: 'A lower bound', text: 'These counts are a lower bound: players who opt out, block the request, or never finish a run are not counted, and past the daily write ceiling counting stops until the next UTC day.' },
  { id: 'visits', title: 'Visits', text: "Page visits are counted by Cloudflare, not by this page. Open Cloudflare's own dashboard for them." }
]);

export const FIGURE_LABELS = Object.freeze({ players: 'Players per day', runs: 'Runs per day', winRate: 'Win rate', signups: 'Sign-ups', accounts: 'Accounts' });

/** Numeric dotted-version comparison, ascending (2.9.0 before 2.10.0); sort with (a, b) => compareVersions(b, a) for newest first. */
export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** How long ago the last report arrived, in words, and whether that is stale (over 36 hours, or never). last: an ISO time or a UTC day. */
export function ageText(last, nowMs) {
  if (!last) return { text: 'No reports received yet', stale: true };
  const then = Date.parse(last);
  if (!Number.isFinite(then)) return { text: 'Unknown', stale: true };
  const ms = Math.max(0, nowMs - then);
  const minutes = Math.floor(ms / 60000), hours = Math.floor(ms / 3600000), days = Math.floor(ms / 86400000);
  const text = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} minute${minutes === 1 ? '' : 's'} ago` : hours < 48 ? `${hours} hour${hours === 1 ? '' : 's'} ago` : `${days} days ago`;
  return { text, stale: ms > 36 * 3600000 };
}

/** How full today's write ceiling is: high from 80 percent, full at 100. */
export function ceilingStatus({ used, limit }) {
  const ratio = limit > 0 ? used / limit : 0;
  return { ratio, state: ratio >= 1 ? 'full' : ratio >= 0.8 ? 'high' : 'ok' };
}

/** A number for the page: thousands separators, whole numbers without decimals, others to one (or `decimals`); '—' when missing. */
export function formatNumber(n, decimals) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const places = decimals ?? (Number.isInteger(n) ? 0 : 1);
  return n.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
}

/** A change figure as text: +12%, -4%, +1.5 pts, 0%, or '—' when there is none. */
export function formatChange(change) {
  if (!change || !Number.isFinite(change.value)) return '—';
  if (change.kind === 'points') {
    const rounded = Math.round(change.value * 10) / 10;
    return rounded === 0 ? '0 pts' : `${rounded > 0 ? '+' : ''}${rounded} pts`;
  }
  const rounded = Math.round(change.value * 100);
  return rounded === 0 ? '0%' : `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/** CSV with CRLF line ends; fields with a comma, quote or line break are quoted; a text starting with = + - @ tab or CR gets a ' first (spreadsheet formulas). */
export function toCsv(rows) {
  const field = value => {
    let text = typeof value === 'number' ? String(value) : String(value ?? '');
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map(row => row.map(field).join(',') + '\r\n').join('');
}

const share = value => `${Math.round(value * 1000) / 10}%`;

/**
 * Everything the page draws, from the answer for the chosen window (main) and, for the comparison against the window before it,
 * an answer covering at least twice as many days (compare, or null). nowMs is the clock the page reads once.
 */
export function buildView({ main, compare = null, range, nowMs }) {
  const today = main.ceiling.day;
  const window = String(range) === 'all' ? 'all' : Number(range);
  const headline = headlinePeriods((compare || main).days, today, window);
  const periods = compare ? headline : { ...headline, previous: null, history: 'none' };
  const figures = [...compareFigures(periods.current, periods.previous), { id: 'accounts', value: main.accountsTotal, change: null }];
  const mainPeriods = headlinePeriods(main.days, today, window);
  const trend = { complete: mainPeriods.current, todayRow: mainPeriods.todayRow };
  const funnel = funnelSteps(reachedCounts(main.breakdowns.stage_reached));
  const versionOrder = [...main.breakdowns.version].map(row => row.dim).sort((a, b) => compareVersions(b, a));
  const breakdowns = {
    character: barRows(main.breakdowns.character, { top: 8 }),
    weapon: barRows(main.breakdowns.weapon, { top: 8 }),
    device: barRows(main.breakdowns.device, { kind: 'device' }),
    version: barRows(main.breakdowns.version, { order: versionOrder }),
    length: barRows(main.breakdowns.length, { order: LENGTH_ORDER, kind: 'length' })
  };
  const age = ageText(main.lastReceived, nowMs);
  const ceiling = { used: main.ceiling.used, limit: main.ceiling.limit, state: ceilingStatus(main.ceiling).state };
  const dayRows = [...trend.complete, trend.todayRow];
  const barTable = (id, title, first, rows) => ({ id, title, head: [first, 'Runs', 'Share'], rows: rows.map(row => [row.label, row.n, share(row.share)]) });
  const tables = [
    { id: 'days', title: 'Per day', head: ['Day', 'Players', 'Runs', 'Wins', 'Sign-ups'], rows: dayRows.map(row => [row.day, row.players, row.runs, row.wins, row.signups]) },
    { id: 'stage', title: 'Stage reached', head: ['Stage', 'Runs that got there', 'Share of stage 1'], rows: funnel.map(step => [`Stage ${step.stage}`, step.reached, share(step.share)]) },
    barTable('character', 'Character', 'Character', breakdowns.character),
    barTable('weapon', 'Weapon', 'Weapon', breakdowns.weapon),
    barTable('device', 'Device', 'Device', breakdowns.device),
    barTable('version', 'Game version', 'Version', breakdowns.version),
    barTable('length', 'Run length', 'Length', breakdowns.length)
  ];
  const csv = [['section', 'name', 'count']];
  for (const key of ['players', 'runs', 'wins', 'signups']) for (const row of dayRows) csv.push([key, row.day, row[key]]);
  for (const key of BREAKDOWN_KEYS) for (const row of main.breakdowns[key]) csv.push([key, row.dim, row.n]);
  return { range: main.range, today, figures, comparison: periods.history, trend, funnel, breakdowns, health: { last: age.text, stale: age.stale, ceiling }, tables, csv };
}
