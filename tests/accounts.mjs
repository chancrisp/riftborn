// Riftborn accounts (v2.2): the real Worker entry (cloudflare/worker.js) against the node:sqlite
// D1 stand-in, with the fake provider for sign-in flows and a stubbed fetch for Google, Discord
// and GitHub. Never touches the network or any deployed Worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../cloudflare/worker.js';
import { createD1, openDatabase } from '../server/d1-sqlite.mjs';
import { checkReturnUrl, fakeEnabled, PROFILE_MAX } from '../server/accounts-api.js';

const sqlite = openDatabase(':memory:', 'drizzle', fs);
const DB = createD1(sqlite);
const GAME = 'http://localhost:8700';
const BASE = 'http://127.0.0.1:8787';
const RETURN = GAME + '/?accounts=local';
const KEY = 'test-signing-key-0123456789-abcdefghijklmnop';
const env = {
  DB, ENVIRONMENT: 'development', ALLOWED_ORIGINS: GAME, AUTH_RETURN_ORIGINS: GAME, AUTH_RETURN_PATHS: '/,/riftborn/',
  FAKE_OAUTH: '1', AUTH_SIGNING_KEY: KEY
};
const q = (sql, ...values) => sqlite.prepare(sql).all(...values);
const one = (sql, ...values) => sqlite.prepare(sql).get(...values);
const DAY = 86400000;

let ipCount = 0;
const freshIp = () => { ipCount++; return `10.${(ipCount >> 16) & 255}.${(ipCount >> 8) & 255}.${ipCount & 255}`; };

// A browser's cookie jar for the Worker origin (only the OAuth round trip sets a cookie).
const newJar = () => new Map();
const browser = newJar();
async function call(path, { method = 'GET', body, token, ip = freshIp(), origin = GAME, headers = {}, e = env, base = BASE, jar = null } = {}) {
  const h = { 'CF-Connecting-IP': ip, ...headers };
  if (jar && jar.size) h.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  if (origin) h.Origin = origin;
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const response = await worker.fetch(new Request(base + path, {
    method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  }), e);
  const setCookie = response.headers.get('Set-Cookie');
  if (jar && setCookie) {
    const [pair] = setCookie.split(';');
    const [name, value] = pair.split('=');
    if (/Max-Age=0/i.test(setCookie)) jar.delete(name); else jar.set(name, value);
  }
  let data = null;
  const type = response.headers.get('Content-Type') || '';
  if (type.startsWith('application/json')) data = await response.json();
  else if (type.startsWith('text/html')) data = await response.text();
  return { status: response.status, headers: response.headers, data };
}
const nav = (path, opts = {}) => call(path, { origin: null, jar: browser, ...opts });
const hashParam = (location, key) => new URLSearchParams(new URL(location).hash.slice(1)).get(key);

// The fake provider: start -> tiny page with the state -> Continue -> callback -> back to the game.
async function fakeRedirect(userId, { mode, ticket, ret = RETURN, e = env } = {}) {
  const params = new URLSearchParams({ return: ret });
  if (mode) params.set('mode', mode);
  if (ticket) params.set('ticket', ticket);
  const page = await nav('/auth/fake/start?' + params, { e });
  if (page.status !== 200) return { page };
  const state = /name="state" value="([A-Za-z0-9_-]{43})"/.exec(page.data)?.[1];
  assert.ok(state, 'The fake page carries a valid state');
  const back = await nav(`/auth/fake/callback?state=${state}&code=${encodeURIComponent(userId)}`, { e });
  assert.equal(back.status, 302);
  return { page, state, location: back.headers.get('Location') };
}
async function fakeLogin(userId, opts) {
  const { location } = await fakeRedirect(userId, opts);
  assert.ok(location.startsWith(opts?.ret || RETURN), 'Back to the allowed return URL: ' + location);
  const code = hashParam(location, 'rb_login');
  assert.ok(code, 'Login code in the fragment: ' + location);
  const session = await call('/auth/session', { method: 'POST', body: { code }, e: opts?.e });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  return { ...session.data, code, location };
}
async function register(userId, username) {
  const login = await fakeLogin(userId);
  assert.equal(login.needsUsername, true);
  const created = await call('/api/account', { method: 'POST', body: { signupToken: login.signupToken, username } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  return created.data;
}
const uid = n => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
const run = (n, extra = {}) => ({ id: uid(n), name: 'Guest Runner', score: 1000 + n, kills: 5, wave: 2, seconds: 35, stage: 2, death_mode: false, ...extra });

// ---- CORS ------------------------------------------------------------------------------------
{
  for (const path of ['/api/account', '/api/profile', '/auth/session', '/api/account/identities/google', '/api/scores']) {
    const r = await call(path, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(r.status, 204, path);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), GAME);
    assert.equal(r.headers.get('Access-Control-Allow-Methods'), 'GET, POST, PUT, PATCH, DELETE, OPTIONS', path);
    assert.equal(r.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization', path);
    assert.equal(r.headers.get('Access-Control-Allow-Credentials'), null, 'Credentials mode is never used');
  }
  let r = await call('/api/account', { method: 'OPTIONS', origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  r = await call('/api/account', { origin: 'https://evil.example' });
  assert.equal(r.status, 403, 'Other sites cannot call the accounts API');
  r = await call('/api/auth/providers');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), GAME);
  r = await call('/api/account', { origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
  assert.equal((await call('/api/account', { method: 'PUT' })).status, 405);
  assert.equal((await call('/api/account/whatever')).status, 404);
  assert.equal((await call('/auth/nothing/here')).status, 404);
  assert.equal((await call('/elsewhere')).status, 404, 'Other paths fall through to the old 404');
}
console.log('PASS accounts CORS: preflight headers and methods, Authorization allowed, no credentials, origin allow-list.');

// ---- configuration: providers, fake provider gating, signing key ------------------------------
{
  assert.deepEqual((await call('/api/auth/providers')).data, { providers: ['fake'] });
  const configured = { ...env, GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', DISCORD_CLIENT_ID: 'd-id', DISCORD_CLIENT_SECRET: 'd-secret', GITHUB_CLIENT_ID: 'h-id' };
  assert.deepEqual((await call('/api/auth/providers', { e: configured })).data, { providers: ['google', 'discord', 'fake'] }, 'A provider missing its secret is unavailable');
  const r = await nav('/auth/github/start?return=' + encodeURIComponent(RETURN), { e: configured });
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'provider_unavailable');

  // Fake OAuth is impossible in production, whatever FAKE_OAUTH says, and needs a loopback host.
  const production = { ...env, ENVIRONMENT: 'production' };
  assert.deepEqual((await call('/api/auth/providers', { e: production })).data, { providers: [] });
  assert.equal((await nav('/auth/fake/start?return=' + encodeURIComponent(RETURN), { e: production })).status, 404);
  assert.equal((await nav('/auth/fake/callback?state=x&code=y', { e: production })).status, 404);
  assert.equal(fakeEnabled(production, BASE + '/auth/fake/start'), false);
  assert.equal(fakeEnabled(env, 'https://riftborn-leaderboard.chanmanc10.workers.dev/auth/fake/start'), false, 'Not on a deployed host');
  assert.equal((await nav('/auth/fake/start?return=' + encodeURIComponent(RETURN), { base: 'https://riftborn-leaderboard.chanmanc10.workers.dev' })).status, 404);
  assert.equal(fakeEnabled({ ...env, FAKE_OAUTH: undefined }, BASE), false);
  assert.equal(fakeEnabled({ ...env, FAKE_OAUTH: 'true' }, BASE), false, 'Only the exact value 1');
  assert.equal(fakeEnabled(env, BASE), true);
  assert.equal(fakeEnabled(env, 'http://localhost:8787/'), true);

  // No (or a short) signing key: accounts are off, scores still work.
  for (const key of [undefined, 'short-key']) {
    const off = { ...env, AUTH_SIGNING_KEY: key };
    assert.deepEqual((await call('/api/auth/providers', { e: off })).data, { providers: [] });
    const a = await call('/api/account', { e: off, token: 'x'.repeat(43) });
    assert.equal(a.status, 503);
    assert.equal(a.data.error, 'accounts_unavailable');
    assert.equal((await nav('/auth/fake/start?return=' + encodeURIComponent(RETURN), { e: off })).status, 503);
    assert.equal((await call('/api/scores', { e: off })).status, 200);
  }
}
console.log('PASS accounts config: provider list from secrets, 503 provider_unavailable, fake OAuth gated (never production), signing key required.');

// ---- return URL allow-list -------------------------------------------------------------------
{
  const prod = { ENVIRONMENT: 'production' };
  for (const good of ['https://chancrisp.github.io/riftborn/', 'https://chancrisp.github.io/riftborn/dev/', 'https://chancrisp.github.io/riftborn/index.html',
    'https://chancrisp.github.io/riftborn/dev/index.html', 'https://chancrisp.github.io/riftborn/?practice=1']) {
    assert.equal(checkReturnUrl(good, prod), good, 'Allowed: ' + good);
  }
  assert.equal(checkReturnUrl('https://chancrisp.github.io/riftborn/#rb_login=stale', prod), 'https://chancrisp.github.io/riftborn/', 'An old fragment is dropped');
  assert.equal(checkReturnUrl('https://chancrisp.github.io:443/riftborn/', prod), 'https://chancrisp.github.io/riftborn/');
  for (const bad of ['https://evil.example/riftborn/', 'https://chancrisp.github.io.evil.example/riftborn/', 'http://chancrisp.github.io/riftborn/',
    'https://chancrisp.github.io/riftborn', 'https://chancrisp.github.io/', 'https://chancrisp.github.io/other/', 'https://chancrisp.github.io/riftborn/../other/',
    'https://chancrisp.github.io/riftborn/dev/x.html', 'https://chancrisp.github.io/riftborn/%2e%2e/', 'https://user:pw@chancrisp.github.io/riftborn/',
    'https://chancrisp.github.io/riftborn/?a=<script>', 'https://chancrisp.github.io/riftborn/?a="x"', 'javascript:alert(1)', '//evil.example/riftborn/',
    '/riftborn/', '', 'https://chancrisp.github.io/riftborn/?' + 'a'.repeat(600), 'http://localhost:8700/']) {
    assert.equal(checkReturnUrl(bad, prod), null, 'Refused: ' + bad);
  }
  for (const bad of ['https://evil.example/', 'http://localhost:8701/', 'http://localhost:8700/other/', 'http://localhost:8700.evil.example/', 'javascript:alert(1)']) {
    const r = await nav('/auth/fake/start?return=' + encodeURIComponent(bad));
    assert.equal(r.status, 400, 'Start refuses return ' + bad);
    assert.equal(r.data.error, 'invalid_return');
    assert.equal(r.headers.get('Location'), null, 'Never an open redirect');
  }
  assert.equal((await nav('/auth/fake/start')).status, 400, 'A return URL is required');
  assert.equal((await nav('/auth/fake/start?mode=weird&return=' + encodeURIComponent(RETURN))).status, 400);
}
console.log('PASS return URLs: exact origin + path allow-list, index.html, plain query, no open redirect.');

// ---- sign-up flow ----------------------------------------------------------------------------
let alice, aliceToken;
{
  const { page, location } = await fakeRedirect('alice-1');
  assert.match(page.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
  assert.ok(location.startsWith(RETURN + '#rb_login='), 'Redirects to <return>#rb_login=<code>');
  const code = hashParam(location, 'rb_login');
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  let r = await call('/auth/session', { method: 'POST', body: { code } });
  assert.equal(r.status, 200);
  assert.equal(r.data.needsUsername, true);
  assert.match(r.data.signupToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(r.data.expiresAt > Date.now() + 14 * 60000 && r.data.expiresAt <= Date.now() + 15 * 60000, 'Signup token lasts 15 minutes');
  assert.equal(r.data.token, undefined, 'No session before a username');
  const signupToken = r.data.signupToken;

  r = await call('/auth/session', { method: 'POST', body: { code } });
  assert.equal(r.status, 400, 'A login code works once');
  assert.equal(r.data.error, 'expired');

  for (const [username, error] of [['ab', 'invalid'], ['a'.repeat(17), 'invalid'], ['bad name', 'invalid'], ['émile', 'invalid'], ['Admin', 'reserved'],
    ['EXILE-1a2b', 'reserved'], ['riftborn', 'reserved'], ['Sh1tLord', 'reserved'], [42, 'invalid']]) {
    r = await call('/api/account', { method: 'POST', body: { signupToken, username } });
    assert.equal(r.status, 400, 'Refuses username ' + username);
    assert.equal(r.data.error, error, 'Username ' + username);
  }
  r = await call('/api/account', { method: 'POST', body: { signupToken: 'x'.repeat(43), username: 'Alice' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'expired');
  r = await call('/api/account', { method: 'POST', body: { signupToken, username: 'Alice' }, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
  r = await call('/api/account', { method: 'POST', body: '{nope' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_json');

  r = await call('/api/account', { method: 'POST', body: { signupToken, username: '  Alice  ' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(r.data.expiresAt > Date.now() + 179 * DAY, 'Sessions last 180 days');
  alice = r.data.account;
  aliceToken = r.data.token;
  assert.deepEqual(Object.keys(alice).sort(), ['createdAt', 'id', 'nextUsernameChangeAt', 'providers', 'username', 'usernameChangedAt']);
  assert.match(alice.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(alice.username, 'Alice', 'Trimmed');
  assert.deepEqual(alice.providers, ['fake']);
  assert.equal(alice.usernameChangedAt, null, 'Choosing the first name is not a change');
  assert.equal(alice.nextUsernameChangeAt, null);

  r = await call('/api/account', { method: 'POST', body: { signupToken, username: 'Alice2' } });
  assert.equal(r.status, 400, 'A signup token is single-use');
  assert.equal(r.data.error, 'expired');

  r = await call('/api/account', { token: aliceToken });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.account, alice);
  assert.equal((await call('/api/account')).status, 401);
  assert.equal((await call('/api/account', { token: 'y'.repeat(43) })).status, 401);
  assert.equal((await call('/api/account', { headers: { Authorization: 'Basic abc' } })).status, 401);
  assert.equal((await call('/api/account', { token: aliceToken + 'x' })).status, 401);

  // Nothing identifying is stored raw: the platform id, token and codes exist only as hashes.
  const identity = one('SELECT * FROM identities WHERE account_id = ?', alice.id);
  assert.equal(identity.provider, 'fake');
  assert.notEqual(identity.provider_user_id, 'alice-1');
  assert.ok(!identity.provider_user_id.includes('alice'));
  const dump = JSON.stringify([q('SELECT * FROM sessions'), q('SELECT * FROM auth_pending'), q('SELECT * FROM rate_limits'), q('SELECT * FROM identities'), q('SELECT * FROM accounts')]);
  for (const secret of [aliceToken, code, signupToken, 'alice-1', '10.0.0.']) assert.ok(!dump.includes(secret), 'Not stored raw: ' + secret.slice(0, 8));
}
console.log('PASS sign-up: fake login -> needsUsername -> create (rules, single-use tokens) -> session -> GET account; only hashes stored.');

// ---- returning login, username availability ------------------------------------------------------
{
  const back = await fakeLogin('alice-1');
  assert.equal(back.needsUsername, undefined);
  assert.equal(back.account.id, alice.id, 'The same platform user returns to the same account');
  assert.notEqual(back.token, aliceToken, 'Each sign-in gets its own session');
  assert.equal((await call('/api/account', { token: back.token })).status, 200);
  assert.equal((await call('/api/account', { token: aliceToken })).status, 200, 'Other sessions stay valid');

  const check = async (name, token) => (await call('/api/username-available?name=' + encodeURIComponent(name), { token })).data;
  assert.deepEqual(await check('aLiCe'), { available: false, reason: 'taken' }, 'Taken, case-insensitively');
  assert.deepEqual(await check('ALICE', aliceToken), { available: true }, 'Your own name (letter-case change) is available to you');
  assert.deepEqual(await check('Nobody_Here'), { available: true });
  assert.deepEqual(await check('ab'), { available: false, reason: 'invalid' });
  assert.deepEqual(await check('moderator'), { available: false, reason: 'reserved' });
  assert.deepEqual(await check('x'.repeat(5000)), { available: false, reason: 'invalid' });
  assert.deepEqual(await check(''), { available: false, reason: 'invalid' });

  const login = await fakeLogin('mallory-1');
  const r = await call('/api/account', { method: 'POST', body: { signupToken: login.signupToken, username: 'ALICE' } });
  assert.equal(r.status, 409, 'Usernames are unique case-insensitively');
  assert.equal(r.data.error, 'taken');
  const retry = await call('/api/account', { method: 'POST', body: { signupToken: login.signupToken, username: 'Mallory' } });
  assert.equal(retry.status, 200, 'The signup token survives a taken name');

  // Two tabs: both reached the username screen; the second one to finish signs in to the first's account.
  const tabA = await fakeLogin('twin-1');
  const tabB = await fakeLogin('twin-1');
  const a = await call('/api/account', { method: 'POST', body: { signupToken: tabA.signupToken, username: 'TwinA' } });
  const b = await call('/api/account', { method: 'POST', body: { signupToken: tabB.signupToken, username: 'TwinB' } });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.data.account.id, a.data.account.id);
  assert.equal(b.data.account.username, 'TwinA');
  assert.equal(one("SELECT COUNT(*) AS n FROM accounts WHERE username IN ('TwinA', 'TwinB')").n, 1);
}
console.log('PASS returning login and usernames: same account, availability reasons, case-insensitive uniqueness, two-tab signup.');

// ---- username change: once per 30 days ---------------------------------------------------------
{
  const patch = (username, token = aliceToken) => call('/api/account', { method: 'PATCH', body: { username }, token });
  let r = await patch('Mallory');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'taken');
  r = await patch('staff');
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'reserved');
  r = await patch('no');
  assert.equal(r.data.error, 'invalid');
  r = await patch('alice');
  assert.equal(r.status, 200, 'A letter-case change is free');
  assert.equal(r.data.account.username, 'alice');
  assert.equal(r.data.account.usernameChangedAt, null, 'and does not start the 30 days');
  r = await patch('Alyx');
  assert.equal(r.status, 200);
  assert.equal(r.data.account.username, 'Alyx');
  assert.ok(Math.abs(r.data.account.usernameChangedAt - Date.now()) < 5000);
  assert.ok(Math.abs(r.data.account.nextUsernameChangeAt - (r.data.account.usernameChangedAt + 30 * DAY)) < 5);
  r = await patch('Alyx2');
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'too_soon');
  assert.ok(r.data.nextUsernameChangeAt > Date.now() + 29 * DAY);
  r = await patch('ALYX');
  assert.equal(r.status, 200, 'Letter case can change even inside the 30 days');
  assert.equal(r.data.account.username, 'ALYX');
  r = await patch('ALYX');
  assert.equal(r.status, 200, 'The same name is a no-op');
  sqlite.prepare('UPDATE accounts SET username_changed_at = ? WHERE id = ?').run(Date.now() - 31 * DAY, alice.id);
  assert.equal((await call('/api/account', { token: aliceToken })).data.account.nextUsernameChangeAt, null, 'After 30 days the change is available');
  r = await patch('Alyx_Two');
  assert.equal(r.status, 200);
  assert.equal(r.data.account.username, 'Alyx_Two');
  assert.equal((await call('/api/username-available?name=alice')).data.available, true, 'The old name is free again');
  assert.equal((await call('/api/account', { method: 'PATCH', body: { username: 'Nope' } })).status, 401);
}
console.log('PASS username change: rules, taken, 30-day limit (429 too_soon), free letter-case changes, cooldown expiry.');

// ---- link a second platform (stubbed Google), already_linked, unlink ---------------------------
const realFetch = globalThis.fetch;
const providerCalls = [];
let googleSub = 'g-sub-alice';
function stubProviders({ fail = null } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    providerCalls.push({ url: href, init });
    const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (fail === href) return reply({ error: 'invalid_grant' }, 400);
    if (href === 'https://oauth2.googleapis.com/token') {
      const claims = { iss: 'https://accounts.google.com', aud: 'g-id', sub: googleSub, exp: Math.floor(Date.now() / 1000) + 3600, email: 'never@stored.example' };
      const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      return reply({ access_token: 'g-access', id_token: `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`, token_type: 'Bearer' });
    }
    if (href === 'https://discord.com/api/oauth2/token') return reply({ access_token: 'd-access', token_type: 'Bearer' });
    if (href === 'https://discord.com/api/users/@me') return reply({ id: '80351110224678912', username: 'never_stored', email: 'x@y.z' });
    if (href === 'https://github.com/login/oauth/access_token') return reply({ access_token: 'h-access', token_type: 'bearer' });
    if (href === 'https://api.github.com/user') return reply({ id: 583231, login: 'never-stored', name: 'Never Stored' });
    throw new Error('Unexpected fetch ' + href);
  };
}
const withProviders = { ...env, GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', DISCORD_CLIENT_ID: 'd-id', DISCORD_CLIENT_SECRET: 'd-secret', GITHUB_CLIENT_ID: 'h-id', GITHUB_CLIENT_SECRET: 'h-secret' };
async function providerRedirect(provider, { mode, ticket, e = withProviders, fail } = {}) {
  const params = new URLSearchParams({ return: RETURN });
  if (mode) params.set('mode', mode);
  if (ticket) params.set('ticket', ticket);
  const start = await nav(`/auth/${provider}/start?` + params, { e });
  if (start.status !== 302) return { start };
  const target = new URL(start.headers.get('Location'));
  if (target.origin === GAME) return { start, location: target.href };
  stubProviders({ fail });
  try {
    const back = await nav(`/auth/${provider}/callback?code=provider-code-123&state=${target.searchParams.get('state')}`, { e });
    assert.equal(back.status, 302);
    return { start, target, location: back.headers.get('Location') };
  } finally { globalThis.fetch = realFetch; }
}
{
  // Start: authorization code + state + PKCE S256, minimal scopes, callback on the Worker.
  for (const [provider, host, scope] of [['google', 'https://accounts.google.com/o/oauth2/v2/auth', 'openid'], ['discord', 'https://discord.com/oauth2/authorize', 'identify'], ['github', 'https://github.com/login/oauth/authorize', null]]) {
    const r = await nav(`/auth/${provider}/start?return=` + encodeURIComponent(RETURN), { e: withProviders });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('Referrer-Policy'), 'no-referrer');
    const target = new URL(r.headers.get('Location'));
    assert.equal(target.origin + target.pathname, host);
    assert.equal(target.searchParams.get('client_id'), { google: 'g-id', discord: 'd-id', github: 'h-id' }[provider]);
    assert.equal(target.searchParams.get('redirect_uri'), `${BASE}/auth/${provider}/callback`);
    assert.equal(target.searchParams.get('response_type'), 'code');
    assert.equal(target.searchParams.get('scope'), scope, provider + ' scope');
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    assert.match(target.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.match(target.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!target.href.includes('return'), 'The return URL stays server-side');
  }

  // Callback: server-side code exchange with the PKCE verifier; only the platform id is read.
  providerCalls.length = 0;
  const { target, location } = await providerRedirect('discord');
  const tokenCall = providerCalls.find(c => c.url === 'https://discord.com/api/oauth2/token');
  const form = new URLSearchParams(tokenCall.init.body);
  assert.equal(form.get('code'), 'provider-code-123');
  assert.equal(form.get('client_secret'), 'd-secret');
  assert.equal(form.get('redirect_uri'), `${BASE}/auth/discord/callback`);
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier')))).toString('base64url');
  assert.equal(challenge, target.searchParams.get('code_challenge'), 'The verifier matches the challenge');
  assert.equal(providerCalls.find(c => c.url === 'https://discord.com/api/users/@me').init.headers.Authorization, 'Bearer d-access');
  const discordLogin = await call('/auth/session', { method: 'POST', body: { code: hashParam(location, 'rb_login') } });
  assert.equal(discordLogin.data.needsUsername, true, 'A new Discord user chooses a username');
  const gh = await providerRedirect('github');
  assert.ok(hashParam(gh.location, 'rb_login'));
  assert.ok(providerCalls.some(c => c.url === 'https://api.github.com/user' && c.init.headers['User-Agent']));
  const stored = JSON.stringify(q('SELECT * FROM identities')) + JSON.stringify(q('SELECT * FROM auth_pending'));
  for (const raw of ['80351110224678912', '583231', 'never', 'd-access', 'h-access', 'provider-code-123']) assert.ok(!stored.includes(raw), 'Not stored: ' + raw);

  const logError = console.error;
  console.error = () => {}; // the Worker logs the simulated provider failure
  const failed = await providerRedirect('google', { fail: 'https://oauth2.googleapis.com/token' });
  console.error = logError;
  assert.equal(failed.location, RETURN + '#rb_error=provider_error');
  const denied = await nav('/auth/fake/start?return=' + encodeURIComponent(RETURN));
  const deniedState = /name="state" value="([^"]+)"/.exec(denied.data)[1];
  const cancelled = await nav(`/auth/fake/callback?state=${deniedState}&error=access_denied`);
  assert.equal(cancelled.headers.get('Location'), RETURN + '#rb_error=cancelled');

  // Link Google to Alice with a ticket.
  let r = await call('/api/account/link-ticket', { method: 'POST', token: aliceToken });
  assert.equal(r.status, 200);
  const ticket = r.data.ticket;
  assert.ok(r.data.expiresAt <= Date.now() + 5 * 60000);
  const linked = await providerRedirect('google', { mode: 'link', ticket });
  const linkCode = hashParam(linked.location, 'rb_login');
  r = await call('/auth/session', { method: 'POST', body: { code: linkCode } });
  assert.equal(r.status, 200);
  assert.equal(r.data.linked, 'google');
  assert.equal(r.data.token, undefined, 'A link hands out no new token');
  assert.deepEqual(r.data.account.providers, ['fake', 'google']);
  const reuse = await providerRedirect('google', { mode: 'link', ticket });
  assert.equal(reuse.location, RETURN + '#rb_error=invalid_state', 'A link ticket works once');
  assert.equal((await call('/api/account/link-ticket', { method: 'POST' })).status, 401);

  // Google now signs in to Alice's account too.
  const viaGoogle = await providerRedirect('google');
  r = await call('/auth/session', { method: 'POST', body: { code: hashParam(viaGoogle.location, 'rb_login') } });
  assert.equal(r.data.account.id, alice.id, 'Any linked platform signs in to the same account');

  // Mallory cannot take Alice's Google identity; Alice cannot link a second Google account.
  const mallory = await fakeLogin('mallory-1');
  const malloryTicket = (await call('/api/account/link-ticket', { method: 'POST', token: mallory.token })).data.ticket;
  const stolen = await providerRedirect('google', { mode: 'link', ticket: malloryTicket });
  assert.equal(stolen.location, RETURN + '#rb_error=already_linked');
  googleSub = 'g-sub-other';
  const second = await providerRedirect('google', { mode: 'link', ticket: (await call('/api/account/link-ticket', { method: 'POST', token: aliceToken })).data.ticket });
  assert.equal(second.location, RETURN + '#rb_error=already_linked', 'One identity per platform per account');
  googleSub = 'g-sub-alice';

  // Unlink: never the last identity.
  const unlink = (provider, token = aliceToken) => call('/api/account/identities/' + provider, { method: 'DELETE', token });
  r = await unlink('github');
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'not_linked');
  assert.equal((await unlink('myspace')).status, 404);
  r = await unlink('google');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.account.providers, ['fake']);
  r = await unlink('fake');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'last_identity');
  assert.equal(one('SELECT COUNT(*) AS n FROM identities WHERE account_id = ?', alice.id).n, 1);
  assert.equal((await unlink('fake', mallory.token)).data.error, 'last_identity');
}
console.log('PASS platforms: OAuth start (state, PKCE S256, scopes), code exchange, link via ticket, already_linked, unlink (last identity refused).');

// ---- profile sync --------------------------------------------------------------------------
{
  const put = (profile, baseRev, token = aliceToken) => call('/api/profile', { method: 'PUT', body: { profile, baseRev }, token });
  let r = await call('/api/profile', { token: aliceToken });
  assert.equal(r.status, 200);
  assert.deepEqual({ profile: r.data.profile, rev: r.data.rev }, { profile: null, rev: 0 });
  const saved = { version: 3, journal: { kills: 12 }, cosmetics: ['ember'] };
  r = await put(saved, 0);
  assert.equal(r.status, 200);
  assert.equal(r.data.rev, 1);
  r = await put({ other: true }, 0);
  assert.equal(r.status, 409, 'A stale base revision conflicts');
  assert.equal(r.data.error, 'conflict');
  assert.deepEqual(r.data.profile, saved, 'The conflict carries the stored profile to merge');
  assert.equal(r.data.rev, 1);
  r = await put({ ...saved, merged: true }, 1);
  assert.equal(r.data.rev, 2);
  r = await call('/api/profile', { token: aliceToken });
  assert.deepEqual(r.data.profile, { ...saved, merged: true });
  assert.equal(r.data.rev, 2);
  assert.ok(r.data.updatedAt > Date.now() - 5000);
  for (const bad of [[], null, 'text', 5]) assert.equal((await put(bad, 2)).status, 400, 'Profile must be a JSON object: ' + JSON.stringify(bad));
  for (const bad of [-1, 1.5, '2', null]) assert.equal((await put(saved, bad)).status, 400, 'baseRev: ' + JSON.stringify(bad));
  r = await put({ blob: 'x'.repeat(PROFILE_MAX) }, 2);
  assert.equal(r.status, 413, 'Over 96 KB');
  r = await put({ blob: 'x'.repeat(PROFILE_MAX - 20) }, 2);
  assert.equal(r.status, 200, 'Just under 96 KB is fine');
  assert.equal((await call('/api/profile')).status, 401);
  assert.equal((await put(saved, 0, 'z'.repeat(43))).status, 401);
}
console.log('PASS profile: GET/PUT with rev check, 409 conflict with the stored profile, object-only, 96 KB cap, auth required.');

// ---- scores: session attach, name protection, read-time username, verified -----------------------
{
  const post = (body, token, ip) => call('/api/scores', { method: 'POST', body, token, ip });
  let r = await post(run(1, { name: 'Whatever' }), aliceToken);
  assert.equal(r.status, 200);
  let row = one('SELECT name, account_id FROM scores WHERE id = ?', uid(1));
  assert.equal(row.account_id, alice.id, 'account_id comes from the session');
  assert.equal(row.name, 'Alyx_Two', 'The client name is replaced by the username');
  r = await post({ ...run(2), name: undefined }, aliceToken);
  assert.equal(r.status, 200, 'A signed-in run needs no name');
  r = await post(run(3, { account_id: 'forged-account', name: 'Forger' }));
  assert.equal(r.status, 200);
  assert.equal(one('SELECT account_id FROM scores WHERE id = ?', uid(3)).account_id, null, 'account_id is never taken from the payload');

  for (const name of ['alyx_two', 'ALYX_TWO', '  Alyx_Two ']) {
    r = await post(run(10, { name }));
    assert.equal(r.status, 409, 'Guests cannot use an account name: ' + name);
    assert.equal(r.data.error, 'name_taken');
  }
  r = await post(run(11, { name: 'Alyx_Two' }), 'q'.repeat(43));
  assert.equal(r.status, 409, 'An invalid session posts as a guest');
  r = await post(run(12, { name: 'Free Name' }));
  assert.equal(r.status, 200);

  r = await call('/api/scores');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ['capabilities', 'ranking', 'scores', 'verified'], 'Response shape unchanged');
  assert.equal(r.data.verified, false);
  const byScore = Object.fromEntries(r.data.scores.map(s => [s.score, s]));
  assert.equal(byScore[1001].name, 'Alyx_Two');
  assert.equal(byScore[1001].verified, true);
  assert.equal(byScore[1012].verified, false);
  assert.equal(byScore[1003].name, 'Forger');
  assert.ok(r.data.scores.every(s => !('account_id' in s)), 'account_id is never returned');

  // A rename reaches old rows at read time.
  sqlite.prepare('UPDATE accounts SET username_changed_at = ? WHERE id = ?').run(Date.now() - 31 * DAY, alice.id);
  assert.equal((await call('/api/account', { method: 'PATCH', body: { username: 'Alyx_Three' }, token: aliceToken })).status, 200);
  r = await call('/api/scores?mode=normal&version=all');
  assert.equal(r.data.scores.find(s => s.score === 1001).name, 'Alyx_Three');
  assert.equal(one('SELECT name FROM scores WHERE id = ?', uid(1)).name, 'Alyx_Two', 'Stored name is untouched; the join renames');
  assert.equal((await post(run(13, { name: 'Alyx_Two' }))).status, 200, 'The old name is free for guests after a rename');
  r = await call('/api/scores?mode=normal&version=all&ruleset=original');
  assert.equal(r.data.scores.find(s => s.score === 1001).verified, true, 'Filters keep the join');
}
console.log('PASS scores: session attaches account_id + username, guest name_taken (any case), verified flag, renames at read time.');

// ---- sessions: logout, expiry, sliding -------------------------------------------------------------
{
  const login = await fakeLogin('alice-1');
  let r = await call('/auth/logout', { method: 'POST', token: login.token });
  assert.deepEqual(r.data, { ok: true });
  assert.equal((await call('/api/account', { token: login.token })).status, 401, 'Logout revokes that session');
  assert.equal((await call('/api/account', { token: aliceToken })).status, 200, 'Only that session');
  assert.equal((await call('/auth/logout', { method: 'POST' })).status, 401);

  const temp = await fakeLogin('alice-1');
  const hash = one('SELECT token_hash FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1').token_hash;
  sqlite.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(Date.now() - 2 * DAY, Date.now() + 10 * DAY, hash);
  assert.equal((await call('/api/account', { token: temp.token })).status, 200);
  const slid = one('SELECT last_seen, expires_at FROM sessions WHERE token_hash = ?', hash);
  assert.ok(slid.last_seen > Date.now() - 5000 && slid.expires_at > Date.now() + 179 * DAY, 'Sessions slide at most once a day');
  sqlite.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, hash);
  assert.equal((await call('/api/account', { token: temp.token })).status, 401, 'Expired sessions are refused');
  assert.equal(one('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', hash).n, 0, 'and deleted');
}
console.log('PASS sessions: logout revokes, 180-day sliding expiry, expired refused.');

// ---- expired and used codes, states, tickets --------------------------------------------------------
{
  const { location } = await fakeRedirect('alice-1');
  sqlite.prepare("UPDATE auth_pending SET expires_at = ? WHERE kind = 'login'").run(Date.now() - 1);
  let r = await call('/auth/session', { method: 'POST', body: { code: hashParam(location, 'rb_login') } });
  assert.equal(r.status, 400, 'Login codes expire (60 s)');
  assert.equal(r.data.error, 'expired');
  for (const code of [undefined, '', 'short', 'x'.repeat(43), 12]) {
    assert.equal((await call('/auth/session', { method: 'POST', body: { code } })).data.error, 'expired');
  }

  const page = await nav('/auth/fake/start?return=' + encodeURIComponent(RETURN));
  const state = /name="state" value="([^"]+)"/.exec(page.data)[1];
  r = await nav(`/auth/fake/callback?state=${state}&code=alice-1`);
  assert.ok(hashParam(r.headers.get('Location'), 'rb_login'));
  r = await nav(`/auth/fake/callback?state=${state}&code=alice-1`);
  assert.equal(r.headers.get('Location'), GAME + '/#rb_error=invalid_state', 'A state works once (errors go to the first allowed return)');
  const page2 = await nav('/auth/fake/start?return=' + encodeURIComponent(RETURN));
  const state2 = /name="state" value="([^"]+)"/.exec(page2.data)[1];
  sqlite.prepare("UPDATE auth_pending SET expires_at = ? WHERE kind = 'state'").run(Date.now() - 1);
  r = await nav(`/auth/fake/callback?state=${state2}&code=alice-1`);
  assert.equal(r.headers.get('Location'), GAME + '/#rb_error=invalid_state', 'States expire (10 min)');
  r = await nav('/auth/fake/callback?code=alice-1');
  assert.equal(r.headers.get('Location'), GAME + '/#rb_error=invalid_state');
  // A state from one provider cannot finish another provider's sign-in.
  const page3 = await nav('/auth/fake/start?return=' + encodeURIComponent(RETURN));
  const state3 = /name="state" value="([^"]+)"/.exec(page3.data)[1];
  r = await nav(`/auth/google/callback?state=${state3}&code=abc`, { e: withProviders });
  assert.equal(r.headers.get('Location'), GAME + '/#rb_error=invalid_state');
  const page4 = await nav('/auth/fake/start?return=' + encodeURIComponent(RETURN));
  r = await nav(`/auth/fake/callback?state=${/name="state" value="([^"]+)"/.exec(page4.data)[1]}&code=${encodeURIComponent('bad id!')}`);
  assert.equal(r.headers.get('Location'), RETURN + '#rb_error=provider_error');

  const signup = await fakeLogin('late-1');
  sqlite.prepare("UPDATE auth_pending SET expires_at = ? WHERE kind = 'signup'").run(Date.now() - 1);
  r = await call('/api/account', { method: 'POST', body: { signupToken: signup.signupToken, username: 'LateComer' } });
  assert.equal(r.status, 400, 'Signup tokens expire (15 min)');
  assert.equal(r.data.error, 'expired');

  const ticket = (await call('/api/account/link-ticket', { method: 'POST', token: aliceToken })).data.ticket;
  sqlite.prepare("UPDATE auth_pending SET expires_at = ? WHERE kind = 'link'").run(Date.now() - 1);
  const stale = await fakeRedirect('whoever', { mode: 'link', ticket });
  assert.equal(stale.page.headers.get('Location'), RETURN + '#rb_error=invalid_state', 'Link tickets expire (5 min)');
  assert.equal((await fakeRedirect('whoever', { mode: 'link' })).page.headers.get('Location'), RETURN + '#rb_error=invalid_state');
}
console.log('PASS single-use values: login codes, states, signup tokens and link tickets are single-use and expire.');

// ---- CSRF: the OAuth round trip is bound to the browser; optional client challenge -----------------
{
  const startUrl = (extra = '') => '/auth/fake/start?return=' + encodeURIComponent(RETURN) + extra;
  const stateOf = page => /name="state" value="([^"]+)"/.exec(page.data)[1];

  // Cookie: first-party on the Worker origin, HttpOnly, Lax, 10 min; __Host- + Secure over https.
  let r = await nav(startUrl(), { jar: newJar() });
  assert.match(r.headers.get('Set-Cookie'), /^rb_oauth=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/);
  const https = await nav('/auth/google/start?return=' + encodeURIComponent('https://chancrisp.github.io/riftborn/'), {
    base: 'https://riftborn-leaderboard.chanmanc10.workers.dev', jar: newJar(),
    e: { ...withProviders, ENVIRONMENT: 'production', AUTH_RETURN_ORIGINS: undefined, AUTH_RETURN_PATHS: undefined, FAKE_OAUTH: undefined }
  });
  assert.equal(https.status, 302);
  assert.match(https.headers.get('Set-Cookie'), /^__Host-rb_oauth=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
  assert.equal(new URL(https.headers.get('Location')).searchParams.get('redirect_uri'), 'https://riftborn-leaderboard.chanmanc10.workers.dev/auth/google/callback');

  // Login CSRF: the attacker's callback URL, opened in the victim's browser, is refused.
  const attacker = newJar(), victim = newJar();
  const page = await nav(startUrl(), { jar: attacker });
  r = await nav(`/auth/fake/callback?state=${stateOf(page)}&code=attacker-1`, { jar: victim });
  assert.equal(r.headers.get('Location'), RETURN + '#rb_error=invalid_state', 'A callback needs the browser that started it');
  const forged = await nav(startUrl(), { jar: attacker });
  r = await nav(`/auth/fake/callback?state=${stateOf(forged)}&code=attacker-1`, { jar: newJar() });
  assert.equal(r.headers.get('Location'), RETURN + '#rb_error=invalid_state', 'No cookie, no sign-in');
  const wrong = newJar();
  wrong.set('rb_oauth', 'w'.repeat(43));
  const forged2 = await nav(startUrl(), { jar: attacker });
  r = await nav(`/auth/fake/callback?state=${stateOf(forged2)}&code=attacker-1`, { jar: wrong });
  assert.equal(r.headers.get('Location'), RETURN + '#rb_error=invalid_state', 'A different nonce is refused');

  // Link CSRF: an attacker's link flow finished by a victim does not attach the victim's platform.
  const eve = await register('eve-1', 'Eve');
  const eveTicket = (await call('/api/account/link-ticket', { method: 'POST', token: eve.token })).data.ticket;
  const start = await nav('/auth/google/start?mode=link&ticket=' + eveTicket + '&return=' + encodeURIComponent(RETURN), { jar: attacker, e: withProviders });
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  stubProviders();
  try {
    r = await nav(`/auth/google/callback?code=victim-code&state=${state}`, { jar: victim, e: withProviders });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(r.headers.get('Location'), RETURN + '#rb_error=invalid_state');
  assert.deepEqual((await call('/api/account', { token: eve.token })).data.account.providers, ['fake'], 'Nothing was linked');

  // Two tabs signing in at once share the nonce, so both finish.
  const tabs = newJar();
  const one = await nav(startUrl(), { jar: tabs });
  const two = await nav(startUrl(), { jar: tabs });
  for (const tab of [one, two]) {
    r = await nav(`/auth/fake/callback?state=${stateOf(tab)}&code=tabs-1`, { jar: tabs });
    assert.ok(hashParam(r.headers.get('Location'), 'rb_login'), 'Parallel sign-ins both complete');
  }

  // Client challenge: a login code only redeems with the verifier of the page that started it.
  const verifier = 'v'.repeat(21) + 'erifier-0123456789abcd'; // 43 base64url characters, like 32 random bytes
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  assert.equal((await nav(startUrl('&challenge=short'))).status, 400);
  const redeem = async body => {
    const p = await nav(startUrl('&challenge=' + challenge));
    const back = await nav(`/auth/fake/callback?state=${stateOf(p)}&code=alice-1`);
    return call('/auth/session', { method: 'POST', body: { code: hashParam(back.headers.get('Location'), 'rb_login'), ...body } });
  };
  r = await redeem({});
  assert.equal(r.status, 400, 'Without the verifier a challenged code is refused');
  assert.equal(r.data.error, 'expired');
  r = await redeem({ verifier: 'x'.repeat(43) });
  assert.equal(r.status, 400, 'A wrong verifier is refused');
  r = await redeem({ verifier });
  assert.equal(r.status, 200);
  assert.equal(r.data.account.id, alice.id);
  const plain = await fakeLogin('alice-1');
  assert.ok(plain.token, 'Flows without a challenge still work (game not yet sending one)');
}
console.log('PASS CSRF: browser-bound OAuth round trip (login and link CSRF refused), parallel tabs, optional client challenge.');

// ---- rate limits ----------------------------------------------------------------------------
{
  const ip = '203.0.113.77';
  for (let i = 0; i < 60; i++) assert.equal((await call('/api/username-available?name=Someone', { ip })).status, 200);
  let r = await call('/api/username-available?name=Someone', { ip });
  assert.equal(r.status, 429, 'Username checks: 60 per 10 min per IP');
  assert.equal(r.data.error, 'rate_limited');
  assert.ok(Number(r.headers.get('Retry-After')) > 0);
  assert.equal((await call('/api/username-available?name=Someone')).status, 200, 'Other IPs are unaffected');

  const startIp = '203.0.113.78';
  for (let i = 0; i < 20; i++) assert.equal((await nav('/auth/fake/start?return=' + encodeURIComponent(RETURN), { ip: startIp })).status, 200);
  assert.equal((await nav('/auth/fake/start?return=' + encodeURIComponent(RETURN), { ip: startIp })).status, 429, 'Sign-in starts: 20 per 10 min per IP');

  const sessionIp = '203.0.113.79';
  for (let i = 0; i < 30; i++) await call('/auth/session', { method: 'POST', body: { code: 'x' }, ip: sessionIp });
  assert.equal((await call('/auth/session', { method: 'POST', body: { code: 'x' }, ip: sessionIp })).status, 429, 'Code exchange: 30 per 10 min per IP');

  const createIp = '203.0.113.80';
  for (let i = 0; i < 10; i++) await call('/api/account', { method: 'POST', body: { signupToken: 'x', username: 'Abc' }, ip: createIp });
  assert.equal((await call('/api/account', { method: 'POST', body: { signupToken: 'x', username: 'Abc' }, ip: createIp })).status, 429, 'Account creation: 10 per hour per IP');

  const bob = await register('bob-1', 'Bob');
  for (let i = 0; i < 10; i++) await call('/api/account/link-ticket', { method: 'POST', token: bob.token });
  assert.equal((await call('/api/account/link-ticket', { method: 'POST', token: bob.token })).status, 429, 'Link tickets: 10 per hour per account');
  let rev = 0;
  for (let i = 0; i < 120; i++) rev = (await call('/api/profile', { method: 'PUT', body: { profile: { i }, baseRev: rev }, token: bob.token })).data.rev;
  assert.equal(rev, 120);
  assert.equal((await call('/api/profile', { method: 'PUT', body: { profile: {}, baseRev: rev }, token: bob.token })).status, 429, 'Profile saves: 120 per hour per account');
  assert.ok(!JSON.stringify(q('SELECT key FROM rate_limits')).includes('203.0.113'), 'Limiter keys are hashed, never raw IPs');
}
console.log('PASS rate limits: fixed windows per hashed IP / account, 429 rate_limited with Retry-After.');

// ---- delete account ---------------------------------------------------------------------------
{
  const carol = await register('carol-1', 'Carol');
  await call('/api/profile', { method: 'PUT', body: { profile: { mine: true }, baseRev: 0 }, token: carol.token });
  for (const n of [40, 41]) assert.equal((await call('/api/scores', { method: 'POST', body: run(n), token: carol.token })).status, 200);
  const other = await fakeLogin('carol-1');
  let r = await call('/api/account', { method: 'DELETE', token: carol.token });
  assert.deepEqual(r.data, { ok: true });
  const rows = q('SELECT name, account_id FROM scores WHERE id IN (?, ?)', uid(40), uid(41));
  assert.equal(rows.length, 2, 'Leaderboard rows stay');
  for (const row of rows) {
    assert.equal(row.account_id, null);
    assert.match(row.name, /^EXILE-[0-9A-F]{4}$/, 'Anonymised guest name');
  }
  assert.equal(one('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', carol.account.id).n, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM identities WHERE account_id = ?', carol.account.id).n, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', carol.account.id).n, 0);
  assert.equal((await call('/api/account', { token: carol.token })).status, 401);
  assert.equal((await call('/api/account', { token: other.token })).status, 401, 'Every session of the account is gone');
  r = await call('/api/scores?mode=normal&version=all');
  assert.ok(r.data.scores.filter(s => s.score === 1040 || s.score === 1041).every(s => /^EXILE-/.test(s.name) && s.verified === false));
  assert.equal((await call('/api/username-available?name=carol')).data.available, true, 'The name is free again');
  const again = await fakeLogin('carol-1');
  assert.equal(again.needsUsername, true, 'The platform identity can start over');
  assert.equal((await call('/api/account', { method: 'DELETE' })).status, 401);
}
console.log('PASS delete account: account, identities, sessions and profile removed; score rows anonymised to EXILE-xxxx.');

// ---- a database without the new columns and tables (production today) ----------------------------
{
  const bare = openDatabase(':memory:');
  for (const file of fs.readdirSync('drizzle').filter(f => f.endsWith('.sql') && f < '0005').sort()) bare.exec(fs.readFileSync('drizzle/' + file, 'utf8'));
  bare.exec("INSERT INTO scores (id,name,score,kills,wave,seconds,created_at,played_at,death_mode) VALUES ('old','Old Timer',500,3,2,40,1700000000000,1700000000000,0)");
  const bareEnv = { ...env, DB: createD1(bare) };
  let r = await call('/api/scores', { e: bareEnv });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.scores.map(s => [s.name, s.verified, s.game_version]), [['Old Timer', false, null]]);
  const cols = bare.prepare("PRAGMA table_info('scores')").all().map(c => c.name);
  assert.ok(cols.includes('account_id'), 'account_id is added lazily');
  assert.ok(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_scores_account'").get(), 'with its index');
  const login = await fakeLogin('dora-1', { e: bareEnv });
  assert.equal(login.needsUsername, true, 'Account tables bootstrap on first use');
}
console.log('PASS lazy schema: tables and account_id column bootstrap on an old database; old rows read as unverified.');

console.log('PASS accounts: all flows.');
