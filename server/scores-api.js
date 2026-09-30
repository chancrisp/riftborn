// Cross-origin score API shared by the current Sites Worker and the standalone
// Cloudflare Worker used by the GitHub Pages edition.
const json = (value, status = 200, origin = null) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin'
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
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
// exactly as before without it.
const LATE_COLUMNS = Object.freeze({ game_version: 'TEXT', rift_score: 'INTEGER' });
const LATE_RETRY_MS = 300000;
const lateColumnCache = new WeakMap();
// -> Promise<string[]> of the late columns the scores table has (LATE_COLUMNS order). Never rejects.
function lateColumns(db) {
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
const isKeepers = version => typeof version === 'string' && version.startsWith('keepers-');

function originAllowed(origin, env) {
  if (!origin) return true;
  const defaults = 'https://riftborn.chanmanc10.chatgpt.site' +
    (env.ENVIRONMENT === 'production' ? '' : ',http://127.0.0.1:4173,http://localhost:4173');
  return `${defaults},${env.ALLOWED_ORIGINS || ''}`
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .includes(origin);
}

export async function handleScores(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/scores') return null;

  const origin = request.headers.get('Origin');
  const allowed = originAllowed(origin, env);
  if (!allowed) return json({ error: 'Forbidden origin' }, 403);
  if (request.method === 'OPTIONS') {
    if (!origin) return json({ error: 'Origin required' }, 400);
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Cache-Control': 'no-store',
        Vary: 'Origin'
      }
    });
  }
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, origin);
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' && !origin) return json({ error: 'Forbidden' }, 403);

  try {
    const db = database(env);
    if (request.method === 'GET') {
      const mode = url.searchParams.get('mode') || 'all';
      const version = url.searchParams.get('version') || 'all';
      // ruleset: absent = every run (as before); keepers = KEEPERS stamps (keepers-*), ranked by
      // Rift Score; original = everything else, legacy and unstamped runs included.
      const ruleset = url.searchParams.get('ruleset');
      if (!['all', 'normal', 'death', 'unknown'].includes(mode) || !(/^[a-zA-Z0-9.-]{1,32}$/).test(version) || (ruleset !== null && !['keepers', 'original'].includes(ruleset))) {
        return json({ error: 'Invalid ranking filter' }, 400, origin);
      }
      const clauses = [], values = [];
      if (mode === 'unknown') clauses.push('death_mode IS NULL');
      else if (mode !== 'all') { clauses.push('death_mode = ?'); values.push(mode === 'death' ? 1 : 0); }
      if (version !== 'all') { clauses.push('gameplay_version = ?'); values.push(version); }
      if (ruleset === 'keepers') clauses.push("gameplay_version LIKE 'keepers-%'");
      else if (ruleset === 'original') clauses.push("(gameplay_version IS NULL OR gameplay_version NOT LIKE 'keepers-%')");
      const limit = ruleset === 'keepers' ? (mode === 'all' ? 25 : 20) : mode === 'death' ? 10 : mode === 'normal' ? 20 : 25;
      const query = (late, order) => 'SELECT name,score,stage,played_at,kills,wave,seconds,death_mode,statue_count,statue_modifier,outcome,gameplay_version' +
        late.map(name => ',' + name).join('') + ' FROM scores' +
        (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') +
        ` ORDER BY ${order} LIMIT ${limit}`;
      const byScore = 'score DESC, wave DESC, seconds DESC';
      const late = await lateColumns(db);
      let result = null;
      if (late.length) {
        const order = ruleset === 'keepers' && late.includes('rift_score') ? 'rift_score DESC, stage DESC, seconds ASC' : byScore;
        try { result = await db.prepare(query(late, order)).bind(...values).all(); } catch (error) { lateColumnLost(db, error); }
      }
      result ||= await db.prepare(query([], byScore)).bind(...values).all();
      return json({
        scores: result.results.map(row => ({ ...row, death_mode: row.death_mode == null ? null : row.death_mode === 1, game_version: row.game_version ?? null, rift_score: row.rift_score ?? null })),
        capabilities: { modeFilter: true, versionFilter: true, runMetadata: true, rulesetFilter: true },
        ranking: { mode, version, ruleset: ruleset || 'all' },
        verified: false
      }, 200, origin);
    }

    if (env.SCORE_RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const limit = await env.SCORE_RATE_LIMITER.limit({ key: ip });
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
    if (!p || typeof p.id !== 'string' || !(/^[0-9a-f-]{36}$/i).test(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > 16 ||
      !integer(p.score, 100000000) || !integer(p.kills, 1000000) || !integer(p.seconds, 86400) || p.seconds < 1 || !integer(p.wave, 2881) || p.wave !== 1 + Math.floor(p.seconds / 30)) {
      return json({ error: 'Invalid run' }, 400, origin);
    }
    if (p.stage !== undefined && (!integer(p.stage, 5) || p.stage < 1)) return json({ error: 'Invalid stage' }, 400, origin);
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

    const now = Date.now();
    const insert = late => db.prepare('INSERT INTO scores (id,name,score,kills,wave,seconds,created_at,stage,played_at,death_mode,statue_count,statue_modifier,outcome,gameplay_version' +
      late.map(name => ',' + name).join('') + ') VALUES (' + Array(14 + late.length).fill('?').join(',') + ') ON CONFLICT(id) DO NOTHING')
      .bind(p.id, p.name.trim(), p.score, p.kills, p.wave, p.seconds, now, p.stage ?? null, p.played_at ?? now,
        p.death_mode === undefined ? null : Number(p.death_mode), p.statue_count ?? null, p.statue_modifier ?? null,
        p.outcome ?? null, p.gameplay_version ?? null, ...late.map(name => p[name] ?? null)).run();
    const late = await lateColumns(db);
    let saved = false;
    if (late.length) {
      try { await insert(late); saved = true; } catch (error) { lateColumnLost(db, error); }
    }
    if (!saved) await insert([]);
    return json({ saved: true }, 200, origin);
  } catch (error) {
    console.error('Leaderboard request failed', error);
    return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
  }
}
