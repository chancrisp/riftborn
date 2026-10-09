// The private stats page (metrics/): the pure parts, tested with fixtures in the Worker's exact answer shape. Local only.
// Period math and the headline figures (metrics/chart.js); chart geometry, the response parser, the page shell and the markup
// are added below by the later tasks of the dashboard stage. The last line of this file is the PASS line.
import assert from 'node:assert/strict';
import { addDays, compareFigures, fillDays, headlinePeriods, periodTotals } from '../metrics/chart.js';

// ---- Task 4.1: period math and headline figures -----------------------------------------------------------------------
{
  const mk = (from, n, players) => Array.from({ length: n }, (_, i) => ({ day: addDays(from, i), players, runs: 2 * players, wins: players / 2, signups: 1 }));
  assert.equal(addDays('2024-03-01', -1), '2024-02-29', 'leap day');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(fillDays([{ day: '2026-10-07', players: 4, runs: 0, wins: 0, signups: 0 }], '2026-10-08', 3).map(d => [d.day, d.players]), [['2026-10-06', 0], ['2026-10-07', 4], ['2026-10-08', 0]], 'ascending, gaps zero-filled');
  assert.deepEqual(fillDays([{ day: '2026-10-07', players: NaN, runs: 'x', wins: Infinity, signups: null }], '2026-10-07', 1)[0], { day: '2026-10-07', players: 0, runs: 0, wins: 0, signups: 0 }, 'non-finite numbers become 0');

  const days = [...mk('2026-10-06', 7, 10), ...mk('2026-10-13', 7, 20), { day: '2026-10-20', players: 3, runs: 5, wins: 0, signups: 0 }];
  const periods = headlinePeriods(days, '2026-10-20', 7);
  assert.deepEqual([periods.current[0].day, periods.current.at(-1).day, periods.current.length], ['2026-10-13', '2026-10-19', 7]);
  assert.deepEqual([periods.previous[0].day, periods.previous.at(-1).day, periods.previous.length], ['2026-10-06', '2026-10-12', 7]);
  assert.equal(periods.todayRow.players, 3, 'today is shown on its own, in no headline figure');
  assert.equal(periods.history, 'ok');
  const figures = compareFigures(periods.current, periods.previous);
  assert.deepEqual(figures.map(f => f.id), ['players', 'runs', 'winRate', 'signups']);
  assert.deepEqual(figures[0].change, { kind: 'percent', value: 1 });
  assert.deepEqual(figures[2].change, { kind: 'points', value: 0 });
  assert.equal(figures[3].value, 7, 'sign-ups are a sum');
  assert.equal(figures[0].value, 20, 'players are a per-day mean');
  assert.equal(figures[2].value, 0.25, 'the win rate is wins over runs');

  // One day short of 2N history: no change is shown.
  const short = headlinePeriods(days.slice(1), '2026-10-20', 7);
  assert.deepEqual([short.history, short.previous], ['short', null]);
  assert.equal(compareFigures(short.current, short.previous)[0].change, null);
  assert.equal(compareFigures(periods.current, null)[0].change, null);

  // 'all': the first data day to yesterday, no comparison. No data at all: history none.
  const all = headlinePeriods(days, '2026-10-20', 'all');
  assert.deepEqual([all.current[0].day, all.current.at(-1).day, all.previous, all.history], ['2026-10-06', '2026-10-19', null, 'none']);
  const none = headlinePeriods([], '2026-10-20', 30);
  assert.deepEqual([none.current.length, none.previous, none.history, none.todayRow.players], [30, null, 'none', 0]);

  // Totals, and the edge cases of the change figures.
  assert.deepEqual(periodTotals(periods.current), { n: 7, playersPerDay: 20, runsPerDay: 40, runs: 280, wins: 70, winRate: 0.25, signups: 7 });
  assert.equal(periodTotals([]).winRate, null, 'no runs: no win rate');
  const flat = [{ day: '2026-10-01', players: 0, runs: 0, wins: 0, signups: 0 }];
  assert.equal(compareFigures(periods.current, flat)[0].change, null, 'a percent change from zero is not shown');
  assert.equal(compareFigures(flat, periods.current)[2].change, null, 'no win rate, no change in points');
}

console.log('PASS stats page: period math and headline figures.');
