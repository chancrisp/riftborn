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
