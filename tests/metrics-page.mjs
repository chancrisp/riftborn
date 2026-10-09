// The private stats page (metrics/): the pure parts, tested with fixtures in the Worker's exact answer shape. Local only.
// Period math and the headline figures (metrics/chart.js); chart geometry, the response parser, the page shell and the markup
// are added below by the later tasks of the dashboard stage. The last line of this file is the PASS line.
import assert from 'node:assert/strict';
import { BAR_BOX, LENGTH_LABELS, LENGTH_ORDER, TREND_BOX, addDays, barGeometry, barRows, compareFigures, fillDays, funnelSteps, headlinePeriods, niceMax, periodTotals, reachedCounts, trendGeometry } from '../metrics/chart.js';

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

// ---- Task 4.2: chart geometry ---------------------------------------------------------------------------------------------
{
  assert.deepEqual(TREND_BOX, { width: 640, height: 220, margin: { top: 12, right: 12, bottom: 28, left: 44 } });
  assert.deepEqual([0, 3, 7, 10, 120, 501, 1.5, -4].map(niceMax), [1, 5, 10, 10, 200, 1000, 2, 1]);
  const three = ['2026-10-05', '2026-10-06', '2026-10-07'].map((day, i) => ({ day, players: [0, 5, 10][i], runs: 0, wins: 0, signups: 0 }));
  const trend = trendGeometry(three, 'players');
  assert.equal(trend.max, 10);
  assert.deepEqual(trend.points.map(p => [p.x, p.y, p.day, p.value]), [[44, 192, '2026-10-05', 0], [336, 102, '2026-10-06', 5], [628, 12, '2026-10-07', 10]]);
  assert.equal(trend.line, 'M44 192L336 102L628 12');
  assert.equal(trendGeometry(three, 'players', undefined, { partialLast: true }).partialLine, 'M336 102L628 12');
  assert.equal(trendGeometry(three, 'players', undefined, { partialLast: true }).line, 'M44 192L336 102');
  assert.deepEqual(trend.yTicks.map(tick => [tick.y, tick.label]), [[192, '0'], [102, '5'], [12, '10']], 'ticks at 0, half and the maximum');
  assert.deepEqual(trend.xTicks.map(tick => [tick.x, tick.label]), [[44, '10-05'], [336, '10-06'], [628, '10-07']]);
  const empty = trendGeometry([], 'runs');
  assert.deepEqual([empty.points, empty.line, empty.partialLine], [[], '', '']);
  assert.equal(trendGeometry([three[1]], 'players').points[0].x, 336, 'one day sits at the horizontal centre');
  const many = Array.from({ length: 90 }, (_, i) => ({ day: addDays('2026-07-23', i), players: i, runs: 0, wins: 0, signups: 0 }));
  const ticks = trendGeometry(many, 'players').xTicks;
  assert.ok(ticks.length <= 6 && ticks[0].label === '07-23' && ticks.at(-1).label === '10-20', 'at most 6 ticks, first and last always');
  assert.equal(trendGeometry([{ day: '2026-10-05', players: 1.04, runs: 0, wins: 0, signups: 0 }, { day: '2026-10-06', players: 2, runs: 0, wins: 0, signups: 0 }], 'players').line.includes('.0'), false, 'no trailing .0');

  assert.deepEqual(reachedCounts([{ dim: '1', n: 5 }, { dim: '3', n: 2 }, { dim: '9', n: 7 }]), [7, 2, 2, 0, 0, 0], 'a run that ended at stage k also reached every stage before it; dims outside 1..6 are ignored');
  const funnel = funnelSteps([100, 60, 30, 27, 9, 3]);
  assert.equal(funnel.length, 6);
  assert.deepEqual([funnel[0].share, funnel[0].lostShare, funnel[1].share], [1, null, 0.6]);
  assert.deepEqual(funnel.map(s => s.biggestDrop), [false, false, false, false, true, false], 'the tie between stage 5 and 6 goes to the earlier stage');
  assert.equal(funnelSteps([0, 0, 0, 0, 0, 0]).some(s => s.biggestDrop || Number.isNaN(s.share)), false, 'no runs: no drop, no NaN');

  assert.deepEqual(LENGTH_ORDER, ['u2', '2-5', '5-10', '10-20', '20-40', 'o40']);
  assert.deepEqual([LENGTH_LABELS.u2, LENGTH_LABELS['2-5'], LENGTH_LABELS.o40], ['Under 2 min', '2-5 min', 'Over 40 min']);
  const chars = [{ dim: 'rift-knight', n: 5 }, { dim: 'abbot', n: 5 }, { dim: 'a', n: 1 }, { dim: 'b', n: 2 }, { dim: 'c', n: 3 }];
  const top = barRows(chars, { top: 3 });
  assert.deepEqual(top.map(r => [r.dim, r.n]), [['abbot', 5], ['rift-knight', 5], ['c', 3], ['other', 3]], 'sorted by count then name; the remainder merges into other');
  assert.deepEqual([top[0].label, top[1].label, top.at(-1).label], ['abbot', 'rift knight', 'Other']);
  assert.equal(top[0].share, 5 / 16, 'shares are on the total of all rows');
  assert.deepEqual(barRows([{ dim: '3', n: 2 }], { kind: 'stage' })[0].label, 'Stage 3');
  assert.deepEqual(barRows([{ dim: 'desktop', n: 2 }], { kind: 'device' })[0].label, 'Desktop');
  const lengths = barRows([{ dim: '5-10', n: 4 }], { order: LENGTH_ORDER, kind: 'length' });
  assert.deepEqual(lengths.map(r => r.dim), LENGTH_ORDER, 'all six buckets, in order, zero rows kept');
  assert.equal(lengths[2].label, '5-10 min');
  const geometry = barGeometry([{ dim: 'a', n: 10 }, { dim: 'b', n: 0 }, { dim: 'c', n: 5 }].map(r => ({ ...r, label: r.dim, share: 0 })));
  assert.deepEqual(BAR_BOX, { width: 640, rowHeight: 28, labelWidth: 150, valueWidth: 90 });
  assert.equal(geometry.bars[0].width, 640 - 150 - 90, 'the longest bar fills the room');
  assert.equal(geometry.bars[1].width, 0, 'a zero count is width 0, never NaN');
  assert.equal(geometry.bars[2].width, (640 - 150 - 90) / 2);
  assert.equal(geometry.height, 3 * 28);
  assert.equal(barGeometry([]).bars.length, 0);
}

console.log('PASS stats page: period math, headline figures and chart geometry.');
