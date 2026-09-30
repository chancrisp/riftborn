// The local accounts harness (server/dev-accounts.mjs) over real HTTP: starts it on a free port
// with an in-memory database, runs a fake sign-in end to end, and stops it. Local only.
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
  const api = (path, init = {}) => fetch(base + path, { ...init, headers: { Origin: GAME, ...(init.headers || {}) } });

  let r = await api('/api/account', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), GAME);
  assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);
  assert.deepEqual(await (await api('/api/auth/providers')).json(), { providers: ['fake'] });

  const ret = GAME + '/?accounts=local';
  r = await fetch(`${base}/auth/fake/start?return=${encodeURIComponent(ret)}`, { redirect: 'manual' });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^rb_oauth=[A-Za-z0-9_-]{43}$/, 'The browser-binding cookie (plain http harness: no __Host- prefix)');
  const state = /name="state" value="([A-Za-z0-9_-]{43})"/.exec(await r.text())[1];
  r = await fetch(`${base}/auth/fake/callback?state=${state}&code=harness-user`, { redirect: 'manual', headers: { Cookie: cookie } });
  assert.equal(r.status, 302);
  const location = r.headers.get('location');
  assert.ok(location.startsWith(ret + '#rb_login='), location);
  const code = new URLSearchParams(new URL(location).hash.slice(1)).get('rb_login');

  const post = (path, body, token) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  const login = await (await post('/auth/session', { code })).json();
  assert.equal(login.needsUsername, true);
  r = await post('/api/account', { signupToken: login.signupToken, username: 'Harness' });
  assert.equal(r.status, 200);
  const { token, account } = await r.json();
  assert.equal(account.username, 'Harness');
  r = await api('/api/account', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal((await r.json()).account.id, account.id);
  r = await post('/api/scores', { id: '12345678-1234-4234-8234-123456789012', name: 'ignored', score: 10, kills: 1, wave: 1, seconds: 5 }, token);
  assert.equal(r.status, 200);
  const board = await (await api('/api/scores')).json();
  assert.deepEqual(board.scores.map(s => [s.name, s.verified]), [['Harness', true]]);
  r = await api('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ profile: { a: 1 }, baseRev: 0 }) });
  assert.deepEqual((await r.json()).rev, 1);
  r = await fetch(base + '/api/account', { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  console.log('PASS accounts harness: starts on 127.0.0.1, CORS for localhost:8700, fake sign-in, account, score and profile over HTTP.');
} finally {
  child.kill();
}
