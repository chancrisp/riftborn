// The local accounts harness (server/dev-accounts.mjs) over real HTTP: starts it on a free port
// with an in-memory database, runs a fake sign-in end to end (with the client challenge the game
// sends), links and unlinks a second fake platform ("fake2"), and stops it. Local only.
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
  assert.deepEqual(await (await api('/api/auth/providers')).json(), { providers: ['fake', 'fake2'] });

  const ret = GAME + '/?accounts=local';
  // One browser: the Worker's sign-in cookie, and the game tab's verifier for each flow.
  let cookie = '';
  async function flow(provider, userId, extra = '') {
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    let res = await fetch(`${base}/auth/${provider}/start?return=${encodeURIComponent(ret)}&challenge=${challenge}${extra}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(res.status, 200, provider + ' start');
    cookie = res.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^rb_oauth=[A-Za-z0-9_-]{43}$/, 'The browser-binding cookie (plain http harness: no __Host- prefix)');
    const page = await res.text();
    assert.ok(page.includes(`action="/auth/${provider}/callback"`));
    const state = /name="state" value="([A-Za-z0-9_-]{43})"/.exec(page)[1];
    res = await fetch(`${base}/auth/${provider}/callback?state=${state}&code=${userId}`, { redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location.startsWith(ret + '#rb_login='), location);
    return { code: new URLSearchParams(new URL(location).hash.slice(1)).get('rb_login'), verifier };
  }
  r = await fetch(`${base}/auth/fake/start?return=${encodeURIComponent(ret)}`, { redirect: 'manual' });
  assert.equal(r.status, 400, 'No client challenge, no sign-in');

  const post = (path, body, token) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  const first = await flow('fake', 'harness-user');
  assert.equal((await post('/auth/session', { code: first.code })).status, 400, 'The code needs its verifier');
  const again = await flow('fake', 'harness-user');
  const login = await (await post('/auth/session', again)).json();
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

  // Link a second platform (fake2): ticket -> start in link mode -> callback -> the code, its
  // verifier and the account's session together at /auth/session.
  const ticket = (await (await post('/api/account/link-ticket', {}, token)).json()).ticket;
  const link = await flow('fake2', 'harness-user-2', `&mode=link&ticket=${ticket}`);
  r = await post('/auth/session', link);
  assert.equal(r.status, 401, 'Linking needs the account session too');
  const link2 = await flow('fake2', 'harness-user-2', `&mode=link&ticket=${(await (await post('/api/account/link-ticket', {}, token)).json()).ticket}`);
  r = await post('/auth/session', link2, token);
  assert.equal(r.status, 200);
  const linked = await r.json();
  assert.equal(linked.linked, 'fake2');
  assert.deepEqual(linked.account.providers, ['fake', 'fake2']);
  const viaSecond = await (await post('/auth/session', await flow('fake2', 'harness-user-2'))).json();
  assert.equal(viaSecond.account.id, account.id, 'The second platform signs in to the same account');
  // Unlink the first platform from the second one's session; the older session is signed out.
  r = await api('/api/account/identities/fake', { method: 'DELETE', headers: { Authorization: 'Bearer ' + viaSecond.token } });
  assert.equal(r.status, 200);
  const unlinked = await r.json();
  assert.deepEqual(unlinked.account.providers, ['fake2']);
  assert.equal(unlinked.revoked, 1);
  assert.equal((await api('/api/account', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
  r = await api('/api/account/identities/fake2', { method: 'DELETE', headers: { Authorization: 'Bearer ' + viaSecond.token } });
  assert.equal(r.status, 409, 'Never the last platform');
  console.log('PASS accounts harness: starts on 127.0.0.1, CORS for localhost:8700, fake sign-in with the client challenge, account, score and profile, fake2 link + unlink over HTTP.');
} finally {
  child.kill();
}
