// Endless on the local accounts harness (server/dev-accounts.mjs, an in-memory database) over real HTTP: the
// endless depth column (an integer 1 to 999, KEEPERS stamp + rift_score, no daily, accounts only, 8 s a depth),
// the Endless board (?endless=1: rift_score, then depth, then the shorter time), the normal and Daily boards
// that never show an Endless row, and a Descend pair (a KEEPERS row and an Endless row from one account).
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
    assert.deepEqual(await body(res), { error: 'endless_rejected', reason });
  };
  const endless = (depth, over = {}) => run(uuid(), { endless: depth, stage: 3, seconds: depth * 30, ...over });
  const KEEPERS_NORMAL = '?ruleset=keepers&mode=normal&version=' + STAMP;

  const ash = await signIn('endless-ash', 'Ash');
  const bo = await signIn('endless-bo', 'Bodhi');

  assert.equal((await body(await get('/api/scores'))).capabilities.endless, true, 'capabilities.endless');

  // A signed-in Endless post lists on the Endless board only.
  let r = await post('/api/scores', endless(3), ash.token);
  assert.equal(r.status, 200, 'a signed-in Endless post');
  assert.deepEqual(await body(r), { saved: true });
  let rows = (await body(await get('/api/scores?endless=1' + KEEPERS_NORMAL.replace('?', '&')))).scores;
  assert.deepEqual(rows.map(s => [s.name, s.endless, s.rift_score, s.verified]), [['Ash', 3, 4200, true]], 'the Endless board');
  assert.deepEqual((await body(await get('/api/scores' + KEEPERS_NORMAL))).scores, [], 'not on the KEEPERS board');
  assert.deepEqual((await body(await get('/api/scores?mode=all'))).scores, [], 'not on the all board');
  assert.deepEqual((await body(await get('/api/scores?daily=' + today))).scores, [], 'not on the Daily board');
  assert.equal((await body(await get('/api/scores?endless=1'))).ranking.endless, 1);

  // Rejections.
  await rejected(await post('/api/scores', endless(3, { name: 'Guest' })), 'signin');
  for (const bad of [0, 1000, 2.5, '3', null, -1, true, 1e21, NaN]) {
    r = await post('/api/scores', endless(3, { endless: bad }), ash.token);
    assert.equal(r.status, 400, 'endless ' + String(bad));
    assert.deepEqual(await body(r), { error: 'Invalid endless' }, 'endless ' + String(bad));
  }
  assert.equal((await post('/api/scores', endless(3, { gameplay_version: 'original-2', rift_score: undefined }), ash.token)).status, 400, 'an ORIGINAL stamp');
  assert.equal((await post('/api/scores', endless(3, { rift_score: undefined }), ash.token)).status, 400, 'no rift_score');
  assert.equal((await post('/api/scores', endless(3, { daily: today }), ash.token)).status, 400, 'endless plus daily');
  await rejected(await post('/api/scores', endless(20, { seconds: 10 }), ash.token), 'too fast');
  await rejected(await post('/api/scores', endless(20, { seconds: 159 }), ash.token), 'too fast');
  r = await post('/api/scores', endless(20, { seconds: 160, rift_score: 100 }), ash.token);
  assert.equal(r.status, 200, '8 s a depth is enough');
  assert.equal((await post('/api/scores', endless(999, { seconds: 7992, rift_score: 99 }), ash.token)).status, 200, 'the deepest depth');
  assert.equal((await post('/api/scores', endless(1, { seconds: 8, rift_score: 98 }), ash.token)).status, 200, 'the shallowest depth');
  assert.equal((await post('/api/scores', { ...endless(3), stage: 7 }, ash.token)).status, 400, 'stage stays at most 6');

  // The order: rift_score, then the deeper, then the shorter time.
  for (const [depth, score, seconds] of [[5, 6000, 200], [9, 6000, 300], [9, 6000, 250], [2, 9000, 40]]) {
    assert.equal((await post('/api/scores', endless(depth, { rift_score: score, seconds }), bo.token)).status, 200);
  }
  rows = (await body(await get('/api/scores?endless=1'))).scores;
  assert.deepEqual(rows.map(s => [s.rift_score, s.endless, s.seconds]),
    [[9000, 2, 40], [6000, 9, 250], [6000, 9, 300], [6000, 5, 200], [4200, 3, 90], [100, 20, 160], [99, 999, 7992], [98, 1, 8]], 'the Endless order');
  assert.ok(rows.every(s => s.endless !== null));

  // The filter.
  for (const query of ['endless=2', 'endless=0', 'endless=', 'endless=true', 'endless=1&daily=' + today]) {
    assert.equal((await get('/api/scores?' + query)).status, 400, query);
  }

  // A Descend pair: a KEEPERS record (id A) and an Endless record (id B) from one account both save.
  const idA = uuid(), idB = uuid();
  assert.equal((await post('/api/scores', run(idA, { rift_score: 7777 }), bo.token)).status, 200, 'the KEEPERS record');
  assert.equal((await post('/api/scores', run(idB, { rift_score: 7777, endless: 4, stage: 3, seconds: 120 }), bo.token)).status, 200, 'the Endless record');
  rows = (await body(await get('/api/scores' + KEEPERS_NORMAL))).scores;
  assert.deepEqual(rows.map(s => [s.name, s.rift_score, s.endless]), [['Bodhi', 7777, null]], 'only the KEEPERS record on the KEEPERS board');
  rows = (await body(await get('/api/scores?endless=1'))).scores;
  assert.equal(rows.filter(s => s.rift_score === 7777).length, 1, 'only the Endless record on the Endless board');
  assert.equal(rows.find(s => s.rift_score === 7777).endless, 4);
  console.log('PASS Endless: signed-in post and board, guest + bad depth + ORIGINAL + daily + too fast rejections, 8 s a depth, the board order, no Endless row on the normal or Daily boards, ?endless filter, capability, a Descend pair.');
} finally {
  child.kill();
}
