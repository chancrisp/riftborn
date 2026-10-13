// The Daily Rift on the local accounts harness (server/dev-accounts.mjs, an in-memory database) over real
// HTTP: one ranked try per account per day, claimed at /api/daily/start and checked when the score is
// posted (the claiming account, the claimed run id, not yet scored, a plausible time, Normal mode, a KEEPERS
// stamp), /api/daily/me, the day's board (?daily=) and the normal boards that never show a Daily row.
// Local only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['server/dev-accounts.mjs'], {
  env: { ...process.env, PORT: '0', DEV_ACCOUNTS_DB: ':memory:', DEV_ACCOUNTS_QUIET: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stderr.on('data', chunk => { output += chunk; });
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Harness did not start:\n' + output)), 15000);
  child.stdout.on('data', chunk => {
    output += chunk;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) { clearTimeout(timer); resolve(match[0]); }
  });
  child.on('exit', code => { clearTimeout(timer); reject(new Error(`Harness exited (${code}):\n${output}`)); });
});

try {
  const GAME = 'http://localhost:8700';
  const STAMP = 'keepers-7';
  const today = new Date().toISOString().slice(0, 10);
  const api = (path, init = {}) => fetch(base + path, { ...init, headers: { Origin: GAME, ...(init.headers || {}) } });
  const auth = token => (token ? { Authorization: 'Bearer ' + token } : {});
  const post = (path, body, token) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(token) }, body: JSON.stringify(body) });
  const get = (path, token) => api(path, { headers: auth(token) });
  const body = r => r.json();

  // A fake sign-in end to end (as tests/accounts-harness.mjs), then a username: { token, account }.
  const ret = GAME + '/?accounts=local';
  async function signIn(userId, username) {
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    let res = await fetch(`${base}/auth/fake/start?return=${encodeURIComponent(ret)}&challenge=${challenge}`, { redirect: 'manual' });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const state = /name="state" value="([A-Za-z0-9_-]{43})"/.exec(await res.text())[1];
    res = await fetch(`${base}/auth/fake/callback?state=${state}&code=${userId}`, { redirect: 'manual', headers: { Cookie: cookie } });
    const code = new URLSearchParams(new URL(res.headers.get('location')).hash.slice(1)).get('rb_login');
    const login = await body(await post('/auth/session', { code, verifier }));
    res = await post('/api/account', { signupToken: login.signupToken, username });
    assert.equal(res.status, 200, 'sign-up ' + username);
    return body(res);
  }

  const uuid = () => crypto.randomUUID();
  // A KEEPERS run as the game posts it (scores.js keepersWorkerPayload): wave = 1 + floor(seconds / 30).
  const run = (id, over = {}) => {
    const seconds = over.seconds ?? 20;
    return { id, name: 'ignored', score: 3000, kills: 40, wave: 1 + Math.floor(seconds / 30), seconds, stage: 2, played_at: Date.now(), death_mode: false, statue_count: 0, statue_modifier: 100, outcome: 'defeat', gameplay_version: STAMP, rift_score: 4200, ...over };
  };
  const rejected = async (res, reason) => {
    assert.equal(res.status, 409, reason);
    assert.deepEqual(await body(res), { error: 'daily_rejected', reason });
  };

  const ash = await signIn('daily-ash', 'Ash');
  const bo = await signIn('daily-bo', 'Bodhi');

  // Guests, origins and the capability.
  assert.deepEqual(await body(await get('/api/daily/me')), { day: today, status: 'guest' }, '/me as a guest');
  assert.equal((await post('/api/daily/start', { run_id: uuid() })).status, 401, 'a guest cannot claim');
  assert.equal((await get('/api/daily/me', 'not-a-token')).status, 401, 'a bad token');
  assert.equal((await body(await get('/api/scores'))).capabilities.daily, true, 'capabilities.daily');
  let r = await api('/api/daily/start', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(r.status, 204, 'preflight');
  assert.equal(r.headers.get('access-control-allow-origin'), GAME);
  assert.equal((await fetch(base + '/api/daily/me', { headers: { Origin: 'https://evil.example' } })).status, 403, 'other origins');

  // The claim.
  assert.deepEqual(await body(await get('/api/daily/me', ash.token)), { day: today, status: 'none' });
  const ashRun = uuid();
  r = await post('/api/daily/start', { run_id: ashRun }, ash.token);
  assert.equal(r.status, 200, 'first claim');
  assert.deepEqual(await body(r), { day: today, run_id: ashRun });
  r = await post('/api/daily/start', { run_id: ashRun }, ash.token);
  assert.equal(r.status, 200, 'the same claim again (a retried request)');
  r = await post('/api/daily/start', { run_id: uuid() }, ash.token);
  assert.equal(r.status, 409, 'second claim');
  assert.deepEqual(await body(r), { day: today, status: 'started' });
  assert.equal((await post('/api/daily/start', { run_id: 'nope' }, bo.token)).status, 400, 'a run id is a UUID');
  assert.deepEqual(await body(await get('/api/daily/me', ash.token)), { day: today, status: 'started' }, '/me answers started');

  // Every rule of a Daily post.
  await rejected(await post('/api/scores', run(uuid(), { daily: today }), ash.token), 'wrong_run');
  await rejected(await post('/api/scores', run(ashRun, { daily: today }), bo.token), 'no_rite');
  await rejected(await post('/api/scores', run(ashRun, { daily: today })), 'guest');
  await rejected(await post('/api/scores', run(ashRun, { daily: today, seconds: 3000 }), ash.token), 'too_fast');
  await rejected(await post('/api/scores', run(ashRun, { daily: today, death_mode: true }), ash.token), 'mode');
  await rejected(await post('/api/scores', run(ashRun, { daily: today, gameplay_version: 'original-2', rift_score: undefined }), ash.token), 'ruleset');
  await rejected(await post('/api/scores', run(ashRun, { daily: '2020-01-01' }), ash.token), 'no_rite');
  assert.equal((await post('/api/scores', run(ashRun, { daily: '20-10-2026' }), ash.token)).status, 400, 'a malformed day');

  // The try.
  r = await post('/api/scores', run(ashRun, { daily: today }), ash.token);
  assert.equal(r.status, 200, 'the ranked try');
  assert.deepEqual(await body(r), { saved: true, rank: 1, of: 1 });
  await rejected(await post('/api/scores', run(ashRun, { daily: today }), ash.token), 'scored');
  assert.deepEqual(await body(await get('/api/daily/me', ash.token)), { day: today, status: 'scored', score: 4200, rank: 1, of: 1 });
  r = await post('/api/daily/start', { run_id: uuid() }, ash.token);
  assert.equal(r.status, 409);
  assert.deepEqual(await body(r), { day: today, status: 'scored', score: 4200, rank: 1, of: 1 });

  // A second account's try ranks against the first.
  const boRun = uuid();
  assert.equal((await post('/api/daily/start', { run_id: boRun }, bo.token)).status, 200);
  assert.deepEqual(await body(await post('/api/scores', run(boRun, { daily: today, rift_score: 5000 }), bo.token)), { saved: true, rank: 1, of: 2 });
  assert.deepEqual(await body(await get('/api/daily/me', ash.token)), { day: today, status: 'scored', score: 4200, rank: 2, of: 2 });

  // The day's board, another day's, and the normal boards.
  const daily = await body(await get('/api/scores?daily=' + today));
  assert.deepEqual(daily.scores.map(s => [s.name, s.rift_score, s.daily, s.verified]), [['Bodhi', 5000, today, true], ['Ash', 4200, today, true]]);
  assert.deepEqual((await body(await get('/api/scores?daily=2020-01-01'))).scores, []);
  assert.equal((await get('/api/scores?daily=nope')).status, 400);
  assert.equal((await post('/api/scores', run(uuid(), { name: 'Cy' }))).status, 200, 'a normal guest KEEPERS run');
  for (const query of ['ruleset=keepers&mode=normal&version=' + STAMP, 'ruleset=keepers&mode=all&version=all', 'mode=all']) {
    const rows = (await body(await get('/api/scores?' + query))).scores;
    assert.deepEqual(rows.map(s => s.name), ['Cy'], 'no Daily row on ' + query);
    assert.equal(rows[0].daily, null);
  }
  console.log('PASS Daily Rift: guest /me, claim + retried claim + second claim, every Daily post rule, the ranked try and its rank, the day board, no Daily row on the normal boards.');
} finally {
  child.kill();
}
