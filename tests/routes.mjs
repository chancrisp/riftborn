// Board routes (3.0 new worlds): a KEEPERS campaign row may carry the route it ran ("1-9-6-3-4-5": one world per position, a
// fork's either), stored in the late `route` column and served back on the boards; an old client's row without one still posts;
// a route off the KEEPERS path, too long, on an ORIGINAL row or with a Daily or an Endless depth is rejected. Local only.
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
    const seconds = over.seconds ?? 600;
    return { id, name: 'Guest' + id.slice(0, 4), score: 3000, kills: 40, wave: 1 + Math.floor(seconds / 30), seconds, stage: 6, played_at: Date.now(), death_mode: false, statue_count: 0, statue_modifier: 100, outcome: 'victory', gameplay_version: STAMP, rift_score: 4200, ...over };
  };
  const KEEPERS_NORMAL = '?ruleset=keepers&mode=normal&version=' + STAMP;

  // A forked route is stored and read back.
  const forked = run(uuid(), { route: '1-9-6-7-8-5', rift_score: 9100 });
  let r = await post('/api/scores', forked);
  assert.equal(r.status, 200, 'a route posts: ' + JSON.stringify(await r.clone().json()));
  let rows = (await body(await get('/api/scores' + KEEPERS_NORMAL))).scores;
  assert.equal(rows.find(s => s.rift_score === 9100)?.route, '1-9-6-7-8-5', 'the board serves the route');

  // An old client's row (no route) still posts and reads back with a null route.
  r = await post('/api/scores', run(uuid(), { rift_score: 9200 }));
  assert.equal(r.status, 200, 'no route posts');
  rows = (await body(await get('/api/scores' + KEEPERS_NORMAL))).scores;
  assert.equal(rows.find(s => s.rift_score === 9200)?.route, null);

  // Rejections: off the path, too long, too short for the stage, not a string, ORIGINAL, with a Daily or an Endless depth.
  const bad = [
    { route: '1-7-6-3-4-5' },
    { route: '1-2-6-3-4-5-1' },
    { route: '1-2', stage: 4 },
    { route: 126345 },
    { route: '1-2-6-3-4-5; DROP' },
    { route: '1-2-6-3-4-5', gameplay_version: 'original-3', rift_score: undefined },
    { route: '1-2-6-3-4-5', endless: 3 },
    { route: '1-2-6-3-4-5', daily: today },
  ];
  for (const over of bad) {
    r = await post('/api/scores', run(uuid(), over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.deepEqual(await body(r), { error: 'Invalid route' }, JSON.stringify(over));
  }
  console.log('PASS Routes: a forked route stored and served, a row without one, and route rejections (off the path, too long, too short, not a string, injected, ORIGINAL, Endless, Daily).');
} finally {
  child.kill();
}
