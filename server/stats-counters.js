// The anonymous daily counters behind the player metrics (server/stats-api.js writes them, the admin read in
// the same file reads them; server/accounts-api.js counts sign-ups with them). One row per UTC day, metric and
// dimension, holding a count: never a player, an IP address, a score or a time of day.
// This file is a leaf (no imports) so the accounts API can count sign-ups without an import cycle with the
// stats API, which imports its rate-limit key from the accounts API.
// The production database is out of reach of migrations, so the table is created lazily on first use
// (the same way as the feedback table); drizzle/0006_daily_stats.sql and db/schema.ts mirror it for previews and tests.
// WITHOUT ROWID is deliberate: an upsert then writes one row, not a row plus an index entry (D1 bills both).

export const STATS_SCHEMA = 'CREATE TABLE IF NOT EXISTS daily_stats (day TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric, dim)) WITHOUT ROWID';

/** At most this many counter rows are written per UTC day (an upper bound; see server/stats-api.js). */
export const STATS_DAILY_WRITE_CEILING = 30000;
/** The bookkeeping row that counts the rows written under the ceiling; never shown as a metric. */
export const WRITES_METRIC = '_writes';
/** The most distinct values one day keeps for these free-text dimensions; an existing value always counts. */
export const DIM_CAPS = Object.freeze({ character: 32, weapon: 16, version: 8 });
/** Every metric a counter row can carry (the admin read lists exactly these). */
export const COUNTER_METRICS = Object.freeze(['players', 'runs', 'wins', 'stage_reached', 'character', 'weapon', 'device', 'version', 'length', 'signups']);

/** The UTC calendar day of a time in milliseconds, 'YYYY-MM-DD'. */
export const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

const ready = new WeakMap(); // DB binding -> Promise, once per isolate

/** Creates the table if it is not there yet (once per DB binding; a failed bootstrap retries on the next request). */
export function ensureStatsTable(db) {
  let promise = ready.get(db);
  if (!promise) {
    promise = db.prepare(STATS_SCHEMA).run().then(() => undefined);
    ready.set(db, promise);
    promise.catch(() => ready.delete(db));
  }
  return promise;
}
