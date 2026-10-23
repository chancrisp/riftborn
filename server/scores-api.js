// Cross-origin score API shared by the current Sites Worker and the standalone
// Cloudflare Worker used by the GitHub Pages edition.
// Riftborn accounts (v2.2): the Cloudflare Worker passes server/accounts-api.js's scoreAccounts
// hooks as handleScores' third argument (this file is also concatenated into the Sites build, so
// it imports nothing). With them, a signed-in POST stores account_id and the account's username,
// guests cannot post under an account's username (or a name that renders like it: guest names are
// NFKC-normalised, invisible characters are refused, and the hook compares look-alike skeletons),
// and GET joins current usernames at read time. A post with no Authorization header is a guest post
// exactly as before; one whose token proves no session gets 401 (a run queued by an account never
// turns into a guest run), and one the accounts database cannot check gets 503 (retried later).
// The hooks also key the rate limiter by a hash of the address instead of the address itself.
// Without them (the Sites Worker) everything behaves exactly as before.
// Read-only origins (v2.3.1, SCORE_READ_ONLY_ORIGINS: dev.riftborn.us, from site.hosts.mjs) read the
// boards exactly like any allowed origin but never write them: any method but GET/HEAD/OPTIONS gets
// 403 before the rate limiter, the body, the accounts hooks or the database. Their preflight offers
// GET only and no request headers: POST is a CORS-safelisted method, so it is the missing
// Content-Type (and Authorization) that makes the browser stop a JSON post before it is sent.
// Requests without an Origin (curl, servers) are not browser pages and are untouched.
// The Daily Rift (accounts only): POST /api/daily/start claims an account's one ranked try of the day
// (its run id); GET /api/daily/me answers the account's standing today. A score posted with a daily day
// is that try: it needs the claiming account, the claimed run id, no earlier score, a time the clock
// since the claim allows, Normal mode and a KEEPERS stamp, or it gets 409 daily_rejected. Daily rows
// carry the daily column, show only on ?daily=<day>, and never on the normal boards. Without the
// accounts hooks the Daily paths answer 404. The day is the server's UTC date.
const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_HEADERS = 'Content-Type, Authorization';
const READ_ONLY_METHODS = 'GET, OPTIONS';
const json = (value, status = 200, origin = null, extra = {}) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
    ...extra
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = CORS_METHODS;
    headers['Access-Control-Allow-Headers'] = CORS_HEADERS;
  }
  return new Response(JSON.stringify(value), { status, headers });
};

const database = env => {
  if (!env.DB) throw new Error('Score database unavailable');
  return env.DB;
};

// Late columns: game_version (the release a run was played on, "2.1.0") and rift_score (KEEPERS
// runs' ranking score). They are added lazily: the production database was created by hand and
// Wrangler migrations cannot reach it. Checked once per isolate and DB binding; a column whose
// check or ALTER fails is simply left out (re-checked after a cooldown), so scores keep working
// exactly as before without it. account_id (v2.2) links a run to a Riftborn account; it is set
// only server-side from a signed-in session, never from the payload, and is never returned.
const LATE_COLUMNS = Object.freeze({ game_version: 'TEXT', rift_score: 'INTEGER', account_id: 'TEXT', daily: 'TEXT', endless: 'INTEGER', route: 'TEXT' });
// The KEEPERS path a campaign row's route follows: one world per position, a fork's either (a copy of the game's
// riftborn/src/data/campaign.js KEEPERS_PATH, 3.0: 9 the Sketchbook, 7 the Starfall, 8 the Boroughs). A route is that
// row's worlds joined by '-' ("1-9-6-3-4-5"), as far as the stage it reached at least.
const KEEPERS_PATH = Object.freeze([[1], [2, 9], [6], [3, 7], [4, 8], [5]]);
const ROUTE = /^[1-9](-[1-9]){0,5}$/;
const validRoute = (route, stage) => {
  if (typeof route !== 'string' || !ROUTE.test(route)) return false;
  const worlds = route.split('-').map(Number);
  return worlds.length >= Math.min(Math.max(1, stage), KEEPERS_PATH.length) && worlds.every((world, i) => KEEPERS_PATH[i].includes(world));
};
const LATE_RETRY_MS = 300000;
const lateColumnCache = new WeakMap();
// -> Promise<string[]> of the late columns the scores table has (LATE_COLUMNS order). Never rejects.
export function lateColumns(db) {
  const cached = lateColumnCache.get(db);
  if (cached && !(cached.failedAt && Date.now() - cached.failedAt > LATE_RETRY_MS)) return cached.ready;
  const entry = { failedAt: 0, ready: null };
  entry.ready = (async () => {
    const info = await db.prepare("PRAGMA table_info('scores')").all();
    const have = new Set((info?.results || []).map(column => column?.name));
    const ready = [];
    for (const [name, type] of Object.entries(LATE_COLUMNS)) {
      if (!have.has(name)) {
        try {
          await db.prepare(`ALTER TABLE scores ADD COLUMN ${name} ${type}`).run();
        } catch (error) {
          // "duplicate column": another isolate added it first. Anything else: go without it.
          if (!/duplicate column/i.test(String(error?.message || error))) {
            console.error('Score column unavailable: ' + name, error);
            entry.failedAt = Date.now();
            continue;
          }
        }
      }
      ready.push(name);
    }
    if (ready.includes('account_id')) {
      try { await db.prepare('CREATE INDEX IF NOT EXISTS idx_scores_account ON scores (account_id)').run(); } catch (error) {
        console.error('Score account index unavailable', error); // lookups still work, just slower
      }
    }
    return ready;
  })().catch(error => {
    console.error('Score columns unavailable', error);
    entry.failedAt = Date.now();
    return [];
  });
  lateColumnCache.set(db, entry);
  return entry.ready;
}
// A query naming late columns failed because of one ("no such column: game_version"): forget them
// (re-checked after the cooldown) so the caller runs the original query. Other errors are thrown.
function lateColumnLost(db, error) {
  const message = String(error?.message || error);
  if (!Object.keys(LATE_COLUMNS).some(name => message.includes(name))) throw error;
  console.error('Score column lost', error);
  lateColumnCache.set(db, { failedAt: Date.now(), ready: Promise.resolve([]) });
}
const RIFT_SCORE_MAX = 1e10;
// The furthest run position a payload may report (stage = position in the run, not the world id).
// 2.4 adds Pumpkin Hill: KEEPERS and Death Mode runs have 6 stages (the Void Crown is the 6th);
// ORIGINAL keeps 5. Older clients never send more than 5, so their runs stay valid.
const STAGE_MAX = 6;
// Characters a guest name may not contain once accounts are on: controls, format characters (zero
// width spaces and joiners, word joiners, bidi controls, tags), private-use, unassigned and lone
// surrogate code points, line/paragraph separators, and letters that render as blank space.
export const GUEST_NAME_INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/u;
const isKeepers = version => typeof version === 'string' && version.startsWith('keepers-');
const DAILY_DAY = /^\d{4}-\d{2}-\d{2}$/;
// Endless (accounts only): a KEEPERS-stamped run with a rift_score and an endless depth (1 to 999). A depth
// needs at least ENDLESS_MIN_SECONDS of play each. The score bound stays client-side (plausible.js).
const ENDLESS_MAX = 999, ENDLESS_MIN_SECONDS = 8;
const RUN_ID = /^[0-9a-f-]{36}$/i;
const DAILY_PATHS = Object.freeze({ '/api/daily/start': 'POST', '/api/daily/me': 'GET' });
const serverDay = () => new Date().toISOString().slice(0, 10);
// A Daily score's time may run 5% ahead of the server clock since the claim, plus 30 s of slack.
const DAILY_CLOCK_SLACK = 1.05, DAILY_SLACK_SECONDS = 30;

// The daily_rites table (one row per account and day: the claimed run id, when, and whether it was
// scored), created on first use like the late columns. A failure is re-tried on the next request.
const dailyCache = new WeakMap();
function dailyReady(db) {
  let ready = dailyCache.get(db);
  if (!ready) {
    ready = db.prepare('CREATE TABLE IF NOT EXISTS daily_rites (day TEXT NOT NULL, account_id TEXT NOT NULL, run_id TEXT NOT NULL,' +
      ' started_at INTEGER NOT NULL, scored INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, account_id))').run().then(() => true, error => {
      console.error('Daily rites unavailable', error);
      dailyCache.delete(db);
      return false;
    });
    dailyCache.set(db, ready);
  }
  return ready;
}
const dailyRite = (db, day, accountId) => db.prepare('SELECT run_id, started_at, scored FROM daily_rites WHERE day = ? AND account_id = ?').bind(day, accountId).first();
// An account's standing on a day: none, started, or scored with its Rift Score and rank among the day's
// tries (equal scores share a rank).
async function dailyStanding(db, day, accountId) {
  const rite = await dailyRite(db, day, accountId);
  if (!rite) return { day, status: 'none' };
  if (!rite.scored) return { day, status: 'started' };
  const score = (await db.prepare('SELECT rift_score FROM scores WHERE id = ?').bind(rite.run_id).first('rift_score')) ?? 0;
  const counts = await db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN rift_score > ? THEN 1 ELSE 0 END) AS above FROM scores WHERE daily = ?').bind(score, day).first();
  return { day, status: 'scored', score, rank: 1 + Number(counts?.above || 0), of: Math.max(1, Number(counts?.total || 0)) };
}
// -> the reason a Daily score is refused, or null. Throws (503) when the Daily cannot be checked.
async function dailyRejection(db, p, account, late) {
  if (!account) return 'guest';
  if (!late.includes('daily') || !(await dailyReady(db))) throw new Error('Daily unavailable');
  const rite = await dailyRite(db, p.daily, account.id);
  if (!rite) return 'no_rite';
  if (rite.run_id !== p.id) return 'wrong_run';
  if (rite.scored) return 'scored';
  if (p.seconds > (Date.now() - rite.started_at) / 1000 * DAILY_CLOCK_SLACK + DAILY_SLACK_SECONDS) return 'too_fast';
  if (p.death_mode !== false) return 'mode';
  if (!isKeepers(p.gameplay_version)) return 'ruleset';
  return null;
}

function originAllowed(origin, env) {
  if (!origin) return true;
  const defaults = env.ENVIRONMENT === 'production' ? '' : 'http://127.0.0.1:4173,http://localhost:4173';
  return `${defaults},${env.ALLOWED_ORIGINS || ''}`
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .includes(origin);
}

// Only narrows originAllowed: an origin must be allowed there to be answered at all.
function originReadOnly(origin, env) {
  return Boolean(origin) && String(env.SCORE_READ_ONLY_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .includes(origin);
}

export async function handleScores(request, env, accounts = null) {
  const url = new URL(request.url);
  const dailyMethod = DAILY_PATHS[url.pathname];
  if (url.pathname !== '/api/scores' && !dailyMethod) return null;

  const origin = request.headers.get('Origin');
  const allowed = originAllowed(origin, env);
  if (!allowed) return json({ error: 'Forbidden origin' }, 403);
  const readOnly = originReadOnly(origin, env);
  if (request.method === 'OPTIONS') {
    if (!origin) return json({ error: 'Origin required' }, 400);
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': readOnly ? READ_ONLY_METHODS : CORS_METHODS,
        ...(readOnly ? {} : { 'Access-Control-Allow-Headers': CORS_HEADERS }),
        'Access-Control-Max-Age': '86400',
        'Cache-Control': 'no-store',
        Vary: 'Origin'
      }
    });
  }
  if (readOnly && !['GET', 'HEAD'].includes(request.method)) return json({ error: 'read_only_origin' }, 403, origin);
  if (dailyMethod && !accounts) return json({ error: 'Not found' }, 404, origin);
  if (dailyMethod ? request.method !== dailyMethod : !['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, origin);
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' && !origin) return json({ error: 'Forbidden' }, 403);

  try {
    const db = database(env);
    if (url.pathname === '/api/daily/me') {
      const session = await accounts.session(request, env);
      if (!session) return json({ day: serverDay(), status: 'guest' }, 200, origin);
      if (session.unavailable) return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
      if (session.unauthorized || typeof session.id !== 'string') return json({ error: 'unauthorized' }, 401, origin, { 'WWW-Authenticate': 'Bearer' });
      if (!(await dailyReady(db))) return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
      return json(await dailyStanding(db, serverDay(), session.id), 200, origin);
    }
    if (url.pathname === '/api/daily/start') {
      if (env.SCORE_RATE_LIMITER) {
        const key = (typeof accounts.limitKey === 'function' && await accounts.limitKey(request, env, 'daily')) || request.headers.get('CF-Connecting-IP') || 'unknown';
        if (!(await env.SCORE_RATE_LIMITER.limit({ key })).success) return json({ error: 'Too many requests' }, 429, origin);
      }
      if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'JSON required' }, 415, origin);
      const text = await request.text();
      if (text.length > 2048) return json({ error: 'Request too large' }, 413, origin);
      let b;
      try { b = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }
      if (!b || typeof b.run_id !== 'string' || !RUN_ID.test(b.run_id)) return json({ error: 'Invalid run id' }, 400, origin);
      const session = await accounts.session(request, env);
      if (session && session.unavailable) return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
      if (!session || session.unauthorized || typeof session.id !== 'string') return json({ error: 'unauthorized' }, 401, origin, { 'WWW-Authenticate': 'Bearer' });
      if (!(await dailyReady(db))) return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
      const day = serverDay();
      await db.prepare('INSERT INTO daily_rites (day, account_id, run_id, started_at, scored) VALUES (?, ?, ?, ?, 0) ON CONFLICT DO NOTHING')
        .bind(day, session.id, b.run_id, Date.now()).run();
      // A retried claim of the same run id is answered again; any other claim of the day is refused.
      const rite = await dailyRite(db, day, session.id);
      if (rite && rite.run_id === b.run_id && !rite.scored) return json({ day, run_id: b.run_id }, 200, origin);
      return json(await dailyStanding(db, day, session.id), 409, origin);
    }
    if (request.method === 'GET') {
      const mode = url.searchParams.get('mode') || 'all';
      const version = url.searchParams.get('version') || 'all';
      // ruleset: absent = every run (as before); keepers = KEEPERS stamps (keepers-*), ranked by
      // Rift Score; original = everything else, legacy and unstamped runs included.
      const ruleset = url.searchParams.get('ruleset');
      const dailyDay = url.searchParams.get('daily');
      if (dailyDay !== null && !DAILY_DAY.test(dailyDay)) return json({ error: 'Invalid ranking filter' }, 400, origin);
      const endlessParam = url.searchParams.get('endless');
      if (endlessParam !== null && (endlessParam !== '1' || dailyDay !== null)) return json({ error: 'Invalid ranking filter' }, 400, origin);
      const endlessBoard = endlessParam !== null;
      if (!['all', 'normal', 'death', 'unknown'].includes(mode) || !(/^[a-zA-Z0-9.-]{1,32}$/).test(version) || (ruleset !== null && !['keepers', 'original'].includes(ruleset))) {
        return json({ error: 'Invalid ranking filter' }, 400, origin);
      }
      const clauses = [], values = [];
      if (mode === 'unknown') clauses.push('death_mode IS NULL');
      else if (mode !== 'all') { clauses.push('death_mode = ?'); values.push(mode === 'death' ? 1 : 0); }
      if (version !== 'all') { clauses.push('gameplay_version = ?'); values.push(version); }
      if (ruleset === 'keepers') clauses.push("gameplay_version LIKE 'keepers-%'");
      else if (ruleset === 'original') clauses.push("(gameplay_version IS NULL OR gameplay_version NOT LIKE 'keepers-%')");
      const limit = dailyDay !== null || endlessBoard ? 20 : ruleset === 'keepers' ? (mode === 'all' ? 25 : 20) : mode === 'death' ? 10 : mode === 'normal' ? 20 : 25;
      // joined: account rows show the account's current username (a rename reaches old rows) and
      // verified marks rows that belong to a Riftborn account. account_id itself is never returned.
      // With the daily column, a day board reads only that day's tries and every other board none.
      // The endless column splits the boards the same way: the Endless board reads only depth rows, every other board none.
      const where = late => [...clauses, ...(late.includes('daily') ? [dailyDay !== null ? 's.daily = ?' : 's.daily IS NULL'] : []),
        ...(late.includes('endless') ? [endlessBoard ? 's.endless IS NOT NULL' : 's.endless IS NULL'] : [])];
      const bound = late => (late.includes('daily') && dailyDay !== null ? [...values, dailyDay] : values);
      const query = (late, order, joined = false) => 'SELECT ' + (joined ? 'COALESCE(a.username, s.name) AS name' : 's.name AS name') +
        ',s.score,s.stage,s.played_at,s.kills,s.wave,s.seconds,s.death_mode,s.statue_count,s.statue_modifier,s.outcome,s.gameplay_version' +
        late.map(name => ',s.' + name).join('') + (joined ? ',(a.id IS NOT NULL) AS verified' : '') + ' FROM scores s' +
        (joined ? ' LEFT JOIN accounts a ON a.id = s.account_id' : '') +
        (where(late).length ? ' WHERE ' + where(late).join(' AND ') : '') +
        ` ORDER BY ${order} LIMIT ${limit}`;
      const byScore = 'score DESC, wave DESC, seconds DESC';
      const late = await lateColumns(db);
      const shown = late.filter(name => name !== 'account_id');
      let result = null;
      if ((dailyDay !== null && !shown.includes('daily')) || (endlessBoard && !(shown.includes('endless') && shown.includes('rift_score')))) result = { results: [] }; // no Daily or Endless tries yet
      else if (late.length) {
        const order = endlessBoard ? 'rift_score DESC, endless DESC, seconds ASC' : (ruleset === 'keepers' || dailyDay !== null) && shown.includes('rift_score') ? 'rift_score DESC, stage DESC, seconds ASC' : byScore;
        if (accounts && late.includes('account_id') && await accounts.ready(env)) {
          try { result = await db.prepare(query(shown, order, true)).bind(...bound(shown)).all(); } catch (error) {
            // No accounts table after all: read without the join. Late-column errors as before.
            if (!/no such table: accounts/i.test(String(error?.message || error))) lateColumnLost(db, error);
          }
        }
        if (!result) {
          try { result = await db.prepare(query(shown, order)).bind(...bound(shown)).all(); } catch (error) { lateColumnLost(db, error); }
        }
      }
      // The fallback never names the daily or endless column; those boards without them have no rows.
      result ||= dailyDay !== null || endlessBoard ? { results: [] } : await db.prepare(query([], byScore)).bind(...values).all();
      return json({
        scores: result.results.map(({ verified, ...row }) => ({ ...row, death_mode: row.death_mode == null ? null : row.death_mode === 1, game_version: row.game_version ?? null, rift_score: row.rift_score ?? null, daily: row.daily ?? null, endless: row.endless ?? null, route: row.route ?? null, verified: verified === 1 || verified === true })),
        capabilities: { modeFilter: true, versionFilter: true, runMetadata: true, rulesetFilter: true, daily: Boolean(accounts), endless: true },
        ranking: { mode, version, ruleset: ruleset || 'all', ...(dailyDay !== null ? { daily: dailyDay } : {}), ...(endlessBoard ? { endless: 1 } : {}) },
        verified: false
      }, 200, origin);
    }

    if (env.SCORE_RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const key = (accounts && typeof accounts.limitKey === 'function' && await accounts.limitKey(request, env, 'score')) || ip;
      const limit = await env.SCORE_RATE_LIMITER.limit({ key });
      if (!limit.success) return json({ error: 'Too many score submissions' }, 429, origin);
    }
    if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) {
      return json({ error: 'JSON required' }, 415, origin);
    }
    const text = await request.text();
    if (text.length > 2048) return json({ error: 'Request too large' }, 413, origin);
    let p;
    try { p = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }
    const integer = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
    // A signed-in run is posted under the account's username; the client-sent name is ignored.
    const session = accounts && p && typeof p === 'object' ? await accounts.session(request, env) : null;
    if (session && session.unavailable) return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
    if (session && session.unauthorized) return json({ error: 'unauthorized' }, 401, origin, { 'WWW-Authenticate': 'Bearer' });
    const account = session && typeof session.id === 'string' && typeof session.username === 'string' ? session : null;
    // Guest names: trimmed; with accounts on, in NFKC form first (fullwidth and styled letters folded).
    const guestName = account || !p || typeof p !== 'object' || typeof p.name !== 'string' ? null : (accounts ? p.name.normalize('NFKC') : p.name).trim();
    if (!p || typeof p.id !== 'string' || !(/^[0-9a-f-]{36}$/i).test(p.id) || (!account && (!guestName || guestName.length > 16)) ||
      !integer(p.score, 100000000) || !integer(p.kills, 1000000) || !integer(p.seconds, 86400) || p.seconds < 1 || !integer(p.wave, 2881) || p.wave !== 1 + Math.floor(p.seconds / 30)) {
      return json({ error: 'Invalid run' }, 400, origin);
    }
    if (p.stage !== undefined && (!integer(p.stage, STAGE_MAX) || p.stage < 1)) return json({ error: 'Invalid stage' }, 400, origin);
    if (p.played_at !== undefined && (!Number.isSafeInteger(p.played_at) || p.played_at < 0 || p.played_at > Date.now() + 300000)) return json({ error: 'Invalid run date' }, 400, origin);
    if (p.death_mode !== undefined && typeof p.death_mode !== 'boolean') return json({ error: 'Invalid run mode' }, 400, origin);
    if (p.statue_count !== undefined && !integer(p.statue_count, 1000)) return json({ error: 'Invalid statue count' }, 400, origin);
    if (p.statue_modifier !== undefined && (!integer(p.statue_modifier, 5100) || p.statue_modifier < 100 || p.statue_modifier % 5 !== 0)) return json({ error: 'Invalid curse' }, 400, origin);
    if (p.statue_count !== undefined && p.statue_modifier !== undefined && p.statue_modifier !== 100 + p.statue_count * 5) return json({ error: 'Inconsistent curse' }, 400, origin);
    if (p.outcome !== undefined && !['victory', 'defeat', 'ended'].includes(p.outcome)) return json({ error: 'Invalid outcome' }, 400, origin);
    if (p.gameplay_version !== undefined && (typeof p.gameplay_version !== 'string' || !(/^[a-zA-Z0-9.-]{1,32}$/).test(p.gameplay_version))) return json({ error: 'Invalid gameplay version' }, 400, origin);
    if (p.game_version !== undefined && (typeof p.game_version !== 'string' || p.game_version.length > 16 || !(/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/).test(p.game_version))) return json({ error: 'Invalid game version' }, 400, origin);

    // Rift Score belongs to KEEPERS runs only.
    if (p.rift_score !== undefined && (!isKeepers(p.gameplay_version) || !integer(p.rift_score, RIFT_SCORE_MAX))) return json({ error: 'Invalid rift score' }, 400, origin);

    if (p.daily !== undefined && (typeof p.daily !== 'string' || !DAILY_DAY.test(p.daily))) return json({ error: 'Invalid daily' }, 400, origin);
    // Endless depth: 1 to 999, a KEEPERS stamp with a rift_score, never with a Daily. Accounts only; a depth needs 8 s each.
    if (p.endless !== undefined && (!Number.isInteger(p.endless) || p.endless < 1 || p.endless > ENDLESS_MAX ||
      !isKeepers(p.gameplay_version) || p.rift_score === undefined || p.daily !== undefined)) return json({ error: 'Invalid endless' }, 400, origin);
    // A route (3.0): a KEEPERS campaign row only, never with a Daily or an Endless depth, and one that fits the path.
    if (p.route !== undefined && (!isKeepers(p.gameplay_version) || p.daily !== undefined || p.endless !== undefined || !validRoute(p.route, p.stage ?? 1))) return json({ error: 'Invalid route' }, 400, origin);
    const late = await lateColumns(db);
    if (p.endless !== undefined) {
      if (!account) return json({ error: 'endless_rejected', reason: 'signin' }, 409, origin);
      if (!late.includes('endless')) return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
      if (p.seconds < ENDLESS_MIN_SECONDS * p.endless) return json({ error: 'endless_rejected', reason: 'too fast' }, 409, origin);
    }
    if (p.daily !== undefined) {
      if (!accounts) return json({ error: 'Invalid daily' }, 400, origin);
      const reason = await dailyRejection(db, p, account, late);
      if (reason) return json({ error: 'daily_rejected', reason }, 409, origin);
    }

    if (!account && accounts && GUEST_NAME_INVISIBLE.test(guestName)) return json({ error: 'invalid_name' }, 400, origin);
    const name = account ? account.username : guestName;
    // Name protection: a guest cannot post under a Riftborn account's username, in any letter case
    // or in look-alike characters (accounts.owns compares skeletons).
    if (!account && accounts) {
      const owned = await accounts.owns(env, name);
      if (owned && owned.unavailable) return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
      if (owned) return json({ error: 'name_taken' }, 409, origin);
    }

    const now = Date.now();
    const insertStmt = late => db.prepare('INSERT INTO scores (id,name,score,kills,wave,seconds,created_at,stage,played_at,death_mode,statue_count,statue_modifier,outcome,gameplay_version' +
      late.map(name => ',' + name).join('') + ') VALUES (' + Array(14 + late.length).fill('?').join(',') + ') ON CONFLICT(id) DO NOTHING')
      .bind(p.id, name, p.score, p.kills, p.wave, p.seconds, now, p.stage ?? null, p.played_at ?? now,
        p.death_mode === undefined ? null : Number(p.death_mode), p.statue_count ?? null, p.statue_modifier ?? null,
        p.outcome ?? null, p.gameplay_version ?? null, ...late.map(column => column === 'account_id' ? (account ? account.id : null) : p[column] ?? null));
    if (p.daily !== undefined) {
      await db.batch([insertStmt(late), db.prepare('UPDATE daily_rites SET scored = 1 WHERE day = ? AND account_id = ? AND scored = 0').bind(p.daily, account.id)]);
      const { rank, of } = await dailyStanding(db, p.daily, account.id);
      return json({ saved: true, rank, of }, 200, origin);
    }
    const insert = late => insertStmt(late).run();
    let saved = false;
    if (late.length) {
      try { await insert(late); saved = true; } catch (error) { lateColumnLost(db, error); }
    }
    // An Endless run never falls back to a column-less insert: it would land on the normal KEEPERS board.
    if (!saved && p.endless !== undefined) return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
    if (!saved) await insert([]);
    return json({ saved: true }, 200, origin);
  } catch (error) {
    console.error('Leaderboard request failed', error);
    return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
  }
}
