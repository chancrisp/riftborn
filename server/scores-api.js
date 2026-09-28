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
      if (!['all', 'normal', 'death', 'unknown'].includes(mode) || !(/^[a-zA-Z0-9.-]{1,32}$/).test(version)) {
        return json({ error: 'Invalid ranking filter' }, 400, origin);
      }
      const clauses = [], values = [];
      if (mode === 'unknown') clauses.push('death_mode IS NULL');
      else if (mode !== 'all') { clauses.push('death_mode = ?'); values.push(mode === 'death' ? 1 : 0); }
      if (version !== 'all') { clauses.push('gameplay_version = ?'); values.push(version); }
      const query = 'SELECT name,score,stage,played_at,kills,wave,seconds,death_mode,statue_count,statue_modifier,outcome,gameplay_version FROM scores' +
        (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') +
        ' ORDER BY score DESC, wave DESC, seconds DESC LIMIT 25';
      const result = await db.prepare(query).bind(...values).all();
      return json({
        scores: result.results.map(row => ({ ...row, death_mode: row.death_mode == null ? null : row.death_mode === 1 })),
        capabilities: { modeFilter: true, versionFilter: true, runMetadata: true },
        ranking: { mode, version },
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

    const now = Date.now();
    await db.prepare('INSERT INTO scores (id,name,score,kills,wave,seconds,created_at,stage,played_at,death_mode,statue_count,statue_modifier,outcome,gameplay_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(p.id, p.name.trim(), p.score, p.kills, p.wave, p.seconds, now, p.stage ?? null, p.played_at ?? now,
        p.death_mode === undefined ? null : Number(p.death_mode), p.statue_count ?? null, p.statue_modifier ?? null,
        p.outcome ?? null, p.gameplay_version ?? null).run();
    return json({ saved: true }, 200, origin);
  } catch (error) {
    console.error('Leaderboard request failed', error);
    return json({ error: 'Leaderboard temporarily unavailable' }, 503, origin);
  }
}
