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
