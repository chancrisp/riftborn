// A made-up answer of GET /api/admin/stats in the Worker's exact shape, for the stats page tests (no real data). It lists only the
// days that have counts, like the real answer, so the page's gap filling is exercised. A helper, not a test.
const addDays = (day, delta) => { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10); };

export function statsResponse({ range = 30, endDay = '2026-10-08' } = {}) {
  const count = range === 'all' ? 50 : Number(range);
  const days = [];
  for (let i = 0; i < count; i++) {
    if (i % 9 === 4) continue; // a quiet day: no row at all
    const players = (i * 7) % 11 + 3;
    const runs = players * 3 + (i % 4);
    days.push({ day: addDays(endDay, -(count - 1 - i)), players, runs, wins: Math.floor(runs / 5), signups: i % 5 === 0 ? 1 : 0 });
  }
  return {
    range: String(range),
    days,
    breakdowns: {
      stage_reached: [{ dim: '1', n: 120 }, { dim: '2', n: 80 }, { dim: '3', n: 55 }, { dim: '4', n: 30 }, { dim: '5', n: 18 }, { dim: '6', n: 9 }],
      character: [{ dim: 'rift-knight', n: 150 }, { dim: 'abbot', n: 90 }, { dim: 'warden', n: 40 }],
      weapon: [{ dim: 'stinger', n: 120 }, { dim: 'rifle', n: 110 }],
      device: [{ dim: 'desktop', n: 200 }, { dim: 'phone', n: 60 }, { dim: 'tablet', n: 20 }],
      version: [{ dim: '2.9.0', n: 60 }, { dim: '2.10.0', n: 220 }],
      length: [{ dim: 'u2', n: 30 }, { dim: '2-5', n: 70 }, { dim: '5-10', n: 90 }, { dim: '10-20', n: 60 }, { dim: '20-40', n: 25 }, { dim: 'o40', n: 5 }]
    },
    accountsTotal: 42,
    lastReceived: endDay,
    ceiling: { day: endDay, used: 1234, limit: 30000 }
  };
}
