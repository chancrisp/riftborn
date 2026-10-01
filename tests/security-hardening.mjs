// 2.2 pre-launch security review fixes that span files: the Worker answers only over https in
// production and pins itself with HSTS, riftborn.us's HSTS covers its subdomains, the feedback
// inbox carries a strict CSP and renders nothing as HTML, and the privacy page matches the code.
// Local only: never touches the network or a deployed Worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../cloudflare/worker.js';
import { inlineScripts, scriptHash } from '../scripts/pages-headers.mjs';
import { HOSTS } from '../site.hosts.mjs';

const ORIGIN = 'https://riftborn.us';
const API = 'https://api.riftborn.us';
// Any handler touching the database would throw: a refused plaintext request must never get that far.
const untouchable = { prepare() { throw new Error('the database was reached'); } };
const prod = { ENVIRONMENT: 'production', ALLOWED_ORIGINS: ORIGIN, DB: untouchable, FEEDBACK_ADMIN_KEY: 'a'.repeat(32), AUTH_SIGNING_KEY: 'k'.repeat(43) };
const fetchWorker = (url, init = {}, env = prod) => worker.fetch(new Request(url, init), env, { waitUntil() {} });

// ---- production is https-only: nothing is processed over plaintext -----------------------------------
{
  const plain = API.replace('https:', 'http:');
  const bearer = { Authorization: 'Bearer ' + 'q'.repeat(43), Origin: ORIGIN };
  for (const [path, init] of [
    ['/api/scores', {}],
    ['/api/scores', { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{}' }],
    ['/api/account', { headers: bearer }],
    ['/api/profile', { method: 'PUT', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{}' }],
    ['/api/feedback', { headers: { Authorization: 'Bearer ' + prod.FEEDBACK_ADMIN_KEY, Origin: ORIGIN } }],
    ['/auth/logout', { method: 'POST', headers: bearer }],
    ['/auth/session', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' }]
  ]) {
    const r = await fetchWorker(plain + path, init);
    assert.equal(r.status, 403, `${init.method || 'GET'} ${path} over http is refused`);
    assert.deepEqual(await r.json(), { error: 'https_required' });
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
  }
  // Sign-in navigations are sent to the same URL over https (never a token in them).
  for (const method of ['GET', 'HEAD']) {
    const r = await fetchWorker(plain + '/auth/google/start?challenge=abc&return=x', { method });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('Location'), API + '/auth/google/start?challenge=abc&return=x');
  }
  const workersDev = await fetchWorker('http://riftborn-leaderboard.chanmanc10.workers.dev/api/scores');
  assert.equal(workersDev.status, 403, 'The workers.dev host too');
  // The local harness (not production) still runs over http.
  const local = await fetchWorker('http://127.0.0.1:8787/elsewhere', {}, { ...prod, ENVIRONMENT: 'development' });
  assert.equal(local.status, 404);
  assert.equal(local.headers.get('Strict-Transport-Security'), null, 'No HSTS over http');
}
console.log('PASS https only: production refuses every plaintext API request (403 https_required) before any handler, sign-in navigations move to https.');

// ---- every https answer carries HSTS ------------------------------------------------------------------
{
  const cases = [
    ['/elsewhere', {}, 404],
    ['/api/scores', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } }, 204],
    ['/api/auth/providers', { headers: { Origin: ORIGIN } }, 200],
    ['/api/scores', { headers: { Origin: 'https://evil.example' } }, 403]
  ];
  for (const [path, init, status] of cases) {
    const r = await fetchWorker(API + path, init);
    assert.equal(r.status, status, path);
    assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=31536000', 'HSTS on ' + path);
  }
  const hop = await fetchWorker('https://riftborn-leaderboard.chanmanc10.workers.dev/auth/google/start?challenge=abc');
  assert.equal(hop.status, 302, 'workers.dev sign-in hops to api.riftborn.us');
  assert.equal(hop.headers.get('Strict-Transport-Security'), 'max-age=31536000');
  assert.equal(hop.headers.get('Location'), API + '/auth/google/start?challenge=abc', 'Redirect headers are kept');
  const preflight = await fetchWorker(API + '/api/account', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'CORS headers are kept');
}
console.log('PASS HSTS: every https answer of the Worker (API, preflight, redirect, 404) pins the host.');

// ---- riftborn.us HSTS covers its subdomains (no preload) -----------------------------------------------
{
  const source = fs.readFileSync('scripts/pages-headers.mjs', 'utf8');
  const hsts = /Strict-Transport-Security: ([^']+)'/.exec(source)[1];
  assert.equal(hsts, 'max-age=31536000; includeSubDomains');
  assert.ok(!/preload/i.test(hsts), 'preload stays an owner decision');
}
console.log('PASS Pages HSTS: includeSubDomains, no preload.');

// ---- the feedback inbox: strict CSP, nothing rendered as HTML -------------------------------------------
{
  const html = fs.readFileSync('feedback/index.html', 'utf8');
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(meta, 'The inbox sets a CSP (GitHub Pages cannot send headers)');
  assert.ok(html.indexOf(meta[0]) < html.search(/<(link|script|style)\b/i), 'The CSP comes before every script, style and link');
  const policy = Object.fromEntries(meta[1].split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(policy['default-src'], ["'none'"]);
  assert.deepEqual(policy['base-uri'], ["'none'"]);
  assert.deepEqual(policy['form-action'], ["'none'"]);
  assert.deepEqual(policy['object-src'], ["'none'"]);
  assert.ok(!/unsafe-inline|unsafe-eval|\*|data:.*script/.test(policy['script-src'].join(' ') + (policy['style-src'] || []).join(' ')), 'No inline or eval code, no wildcard');
  // script-src: the same-origin module and the hash of every inline script, nothing else.
  const hashes = inlineScripts(html).map(scriptHash);
  assert.deepEqual([...policy['script-src']].sort(), ["'self'", ...hashes].sort(), 'Every inline script is listed by its hash');
  const script = fs.readFileSync('feedback/inbox.js', 'utf8');
  const api = /const API = '([^']+)'/.exec(script)[1];
  // The inbox moved to feedback.riftborn.us: both copies talk to api.riftborn.us, and only to it.
  assert.equal(api, HOSTS.api, 'The inbox uses api.riftborn.us (not the workers.dev address)');
  assert.deepEqual(policy['connect-src'], [api], 'The inbox may reach its API, and nothing else');
  assert.ok(!script.includes(HOSTS.workersDev), 'No workers.dev address left in the inbox');
  assert.deepEqual(JSON.parse(/const HOMES = (\[[^\]]*\])/.exec(script)[1].replace(/'/g, '"')), [new URL(HOSTS.feedback).hostname, new URL(HOSTS.legacyOrigin).hostname], 'The inbox knows its two homes');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(script), 'Nothing is rendered as HTML');
  assert.ok(!/style\s*=|<style/i.test(html.replace(meta[0], '')), 'No inline styles (style-src is same-origin only)');
  // The key: sessionStorage only (this tab). No "Remember on this device" option any more, and a copy
  // an older inbox kept in localStorage is deleted at startup, never read.
  assert.ok(!/id="remember"|Remember on this device/i.test(html), 'No option to keep the key on the device');
  assert.ok(!/el\.remember|#remember/.test(script), 'The script has no remember path');
  const keyWrites = [...script.matchAll(/write\('(\w+)', STORE_KEY, ([^)]*)\)/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(keyWrites.filter(([kind]) => kind === 'localStorage'), [['localStorage', "''"]], 'localStorage: the key is only ever deleted');
  assert.ok(!/read\('localStorage', STORE_KEY\)/.test(script), 'localStorage is never read for the key');
  assert.ok(keyWrites.some(([kind, value]) => kind === 'sessionStorage' && value === 'key'), 'The key lives in sessionStorage');
  // Run the start of the page against fake storages: an old remembered key is deleted, not used.
  const start = script.slice(script.indexOf('const storage = kind =>'), script.indexOf('let cursor'));
  const fake = (entries = {}) => ({ data: { ...entries }, getItem(k) { return k in this.data ? this.data[k] : null; }, setItem(k, v) { this.data[k] = String(v); }, removeItem(k) { delete this.data[k]; } });
  const storeKey = /const STORE_KEY = '([^']+)'/.exec(script)[1];
  for (const [local, session, expected] of [[{ [storeKey]: 'old-remembered' }, {}, ''], [{ [storeKey]: 'old-remembered', other: 'kept' }, { [storeKey]: 'this-tab' }, 'this-tab']]) {
    const win = { localStorage: fake(local), sessionStorage: fake(session) };
    const key = new Function('window', 'STORE_KEY', `${start}; return key;`)(win, storeKey);
    assert.equal(key, expected, 'The key comes from this tab only');
    assert.equal(win.localStorage.getItem(storeKey), null, 'An old remembered key is deleted at startup');
    if (local.other) assert.equal(win.localStorage.getItem('other'), 'kept', 'Nothing else is touched');
  }
}
console.log('PASS inbox: meta CSP (no inline code, inline scripts hashed, https API only), textContent rendering, key kept for this tab only (an old remembered copy is deleted).');

// ---- the privacy page matches the code ------------------------------------------------------------------
{
  const privacy = fs.readFileSync('privacy/index.html', 'utf8').replace(/\s+/g, ' ');
  const feedback = fs.readFileSync('server/feedback-api.js', 'utf8');
  const excerpt = Number(/entry\.message\.length > (\d+) \? entry\.message\.slice\(0, \1\)/.exec(feedback)[1]);
  assert.ok(feedback.includes('DISCORD_WEBHOOK_URL'), 'The Worker can post feedback to Discord...');
  assert.ok(privacy.includes('Feedback also goes to Discord'), '...and the privacy page says so');
  assert.ok(privacy.includes(`up to ${excerpt} characters`), 'with the same excerpt length');
  assert.ok(!/never sold or shared\./.test(privacy) && !privacy.includes('never shared with anyone else'), 'No blanket "never shared" claim');
  for (const detail of ['wave', 'Rift Score', 'statue count and curse', 'random id']) assert.ok(privacy.includes(detail), 'Leaderboard rows: ' + detail);
  assert.ok(privacy.includes('when each platform was linked') && privacy.includes('last saved to the account'), 'All stored dates');
  assert.ok(privacy.includes('stops working after 10 minutes'), 'The sign-in check value is described as the game handles it');
  // "a scrambled, one-way version" of the IP: every limiter key goes through a keyed hash.
  assert.ok(privacy.includes('scrambled, one-way version'));
  for (const file of ['server/feedback-api.js', 'server/scores-api.js']) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\.limit\(\{ key[^}]*\}\)/g)) assert.ok(!/key: ip\b/.test(match[0]), `${file}: limiter keyed by hash, not the raw address: ${match[0]}`);
  }
}
console.log('PASS privacy page: Discord disclosure, leaderboard fields, stored dates, sign-in check value and hashed limiter keys match the code.');
