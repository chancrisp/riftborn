// The riftborn.us move, end to end on this machine: builds the launched outputs (LAUNCHED forced on,
// the new hosts pointed at local servers), serves the github.io output (_site under /riftborn/) and
// the riftborn.us / dev.riftborn.us outputs (_cf/live, _cf/dev with their _headers) on three
// different local origins, and runs the real handoff pages against a seeded localStorage. Proves:
// every allowed key moves (compressed "z." and plain "j." payloads), excluded and foreign keys never
// do, the caps hold, the query rule, every legacy path goes to the right place, a hand-off loop
// stops, and the old copy is never touched. Local only: no network, nothing deployed.
//
// Manual browser check (the receiving side lives in the game's live/ build):
//   node tests/migration-handoff.mjs --serve
// keeps the servers up on fixed ports and prints what to open:
//   1. On http://127.0.0.1:8790/riftborn/feedback/ (same origin as the legacy game, no redirect)
//      open DevTools and seed data, e.g.
//        localStorage.setItem("riftborn-reborn-preferences-v1", JSON.stringify({ muted: true }))
//        localStorage.setItem("riftborn-reborn-profile-v1", "<a real profile JSON>")
//   2. Open http://127.0.0.1:8790/riftborn/ : it hands off to http://localhost:8791/#rb_migrate=...
//   3. On http://localhost:8791/ the game must remove the fragment at once, show "Your progress
//      moved with you to riftborn.us" once, and localStorage there must hold the moved keys
//      (profile merged, other keys kept if already present). Reopen step 2: nothing changes.
//   Same for /riftborn/classic/ (-> :8791/classic/) and /riftborn/dev/ (-> http://localhost:8792/).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createPagesServer } from '../scripts/serve-cf.mjs';
import { inlineScripts, scriptHash } from '../scripts/pages-headers.mjs';
import { MIGRATION } from '../site.config.mjs';

const serveMode = process.argv.includes('--serve');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riftborn-migration-'));
const listen = (server, port) => new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
const servers = {
  legacy: createPagesServer({ root: path.join(tmp, '_site'), mode: 'github', prefix: '/riftborn/' }),
  live: createPagesServer({ root: path.join(tmp, '_cf', 'live') }),
  dev: createPagesServer({ root: path.join(tmp, '_cf', 'dev') })
};
const ports = {
  legacy: await listen(servers.legacy, serveMode ? 8790 : 0),
  live: await listen(servers.live, serveMode ? 8791 : 0),
  dev: await listen(servers.dev, serveMode ? 8792 : 0)
};
// Three browser origins: 127.0.0.1 for "github.io", localhost:<port> for the two new hosts.
const LEGACY = `http://127.0.0.1:${ports.legacy}`;
const LIVE = `http://localhost:${ports.live}`;
const DEV = `http://localhost:${ports.dev}`;
const stopAll = () => Promise.all(Object.values(servers).map(server => new Promise(resolve => server.close(resolve))));

// Test-only overrides are refused in CI; this build goes to a temporary folder.
const { CI, GITHUB_ACTIONS, ...baseEnv } = process.env;
const built = spawnSync(process.execPath, ['scripts/build-pages.mjs'], {
  env: { ...baseEnv, RIFTBORN_PAGES_OUT: tmp, RIFTBORN_FORCE_LAUNCHED: '1', RIFTBORN_TEST_LIVE_ORIGIN: LIVE, RIFTBORN_TEST_DEV_ORIGIN: DEV },
  encoding: 'utf8'
});
assert.equal(built.status, 0, built.stdout + built.stderr);

if (serveMode) {
  console.log(`Serving the launched build (LAUNCHED forced on for this test only):
  github.io stand-in     ${LEGACY}/riftborn/   (classic: /riftborn/classic/, dev: /riftborn/dev/, feedback: /riftborn/feedback/)
  riftborn.us stand-in   ${LIVE}/              (with _headers: strict CSP)
  dev.riftborn.us        ${DEV}/
Seed localStorage on ${LEGACY}/riftborn/feedback/, then open ${LEGACY}/riftborn/. Ctrl+C to stop.`);
  const stop = () => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

const get = async (origin, pathname) => {
  const response = await fetch(origin.replace('localhost', '127.0.0.1') + pathname, { redirect: 'manual' });
  return { status: response.status, headers: response.headers, text: await response.text() };
};

// ---- a browser stand-in for the handoff pages -----------------------------------------------------
class FakeStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(key); }
  snapshot() { return Object.fromEntries(this.map); }
}

/** Runs the page's inline script(s) like a browser at `url`; resolves once it navigates or settles. */
async function runPage(html, url, { storage = new FakeStorage(), session = new FakeStorage(), compression = 'native' } = {}) {
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1, 'One inline script per page');
  const where = new URL(url);
  const elements = {};
  const document = { getElementById: id => (elements[id] ||= { id, href: '', textContent: '' }) };
  let replaced = null;
  const location = { href: where.href, pathname: where.pathname, search: where.search, hash: where.hash, replace(to) { replaced = String(to); } };
  let Compression = CompressionStream;
  if (compression === 'none') Compression = undefined;
  if (compression === 'no-deflate-raw') Compression = class extends CompressionStream { constructor(format) { if (format === 'deflate-raw') throw new TypeError('unsupported'); super(format); } };
  const run = new Function('window', 'document', 'location', 'localStorage', 'sessionStorage', 'CompressionStream', scripts[0]);
  run({}, document, location, storage, session, Compression);
  // Settled: it navigated, or it wrote a note instead (loop guard, early hand-off).
  for (let i = 0; i < 300 && replaced === null && !elements.rbNote?.textContent; i++) await new Promise(resolve => setTimeout(resolve, 10));
  return { replaced, elements, storage };
}

async function decode(url) {
  const hash = new URL(url).hash;
  const match = new RegExp(`^#${MIGRATION.param}=([A-Za-z0-9._-]+)$`).exec(hash);
  assert.ok(match, 'The hand-off URL carries #' + MIGRATION.param + '=<payload>: ' + hash.slice(0, 40));
  const [kind, body] = [match[1].slice(0, 2), match[1].slice(2)];
  const bytes = Buffer.from(body, 'base64url');
  let text;
  if (kind === 'z.') text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  else if (kind === 'j.') text = bytes.toString('utf8');
  else assert.fail('Unknown payload kind ' + kind);
  return { kind, length: match[1].length, data: JSON.parse(text) };
}

// The receiving side's acceptance rules (site.config.mjs MIGRATION): everything sent must pass them.
const accepted = key => !MIGRATION.never.includes(key) && (MIGRATION.extra.includes(key) || (key.startsWith(MIGRATION.prefix) && !MIGRATION.exclude.includes(key)));
function checkContract(data) {
  assert.equal(data.v, 1);
  assert.equal(data.from, 'chancrisp.github.io');
  assert.ok(Number.isFinite(data.at) && Math.abs(Date.now() - data.at) < 60000, 'at: a millisecond timestamp');
  const entries = Object.entries(data.keys);
  assert.ok(entries.length <= MIGRATION.maxKeys, 'At most 64 keys');
  let total = 0;
  for (const [key, value] of entries) {
    assert.ok(accepted(key), 'Only contract keys are sent: ' + key);
    assert.equal(typeof value, 'string');
    assert.ok(Buffer.byteLength(value) <= MIGRATION.maxValueBytes, 'Each value at most 256 KB');
    total += Buffer.byteLength(value) + Buffer.byteLength(key);
  }
  assert.ok(total <= MIGRATION.maxTotalBytes, 'At most 1 MB in all');
}

const SWORD = String.fromCodePoint(0x1f5e1);
const profile = JSON.stringify({ v: 3, name: 'Chan ' + SWORD + ' é中', bestScore: 123456, unlocks: Array.from({ length: 200 }, (_, i) => 'cosmetic-' + i) });
const seeded = () => new FakeStorage({
  'riftborn-reborn-profile-v1': profile,
  'riftborn-reborn-profile-v1-bak': profile,
  'riftborn-reborn-preferences-v1': JSON.stringify({ muted: true, volume: 0.4 }),
  'riftborn-reborn-scores-v1': JSON.stringify([{ score: 1000, name: 'Chan' }]),
  'riftborn-reborn-boards-v1': JSON.stringify({ weekly: [] }),
  'riftborn-reborn-score-outbox-v1': '[]',
  'riftborn-reborn-whats-new-seen-v1': '2.1.1',
  'riftborn-profile-v1': JSON.stringify({ classic: true, best: 42 }),
  'neon-crypt-preferences-v1': JSON.stringify({ volume: 1 }),
  // Never moved:
  'riftborn-reborn-session-v1': 'session-token-secret',
  'riftborn-reborn-login-verifier-v1': 'verifier-secret',
  'riftborn-reborn-account-sync-v1': '{}',
  'riftborn-reborn-account-reminded': '1',
  'riftborn-reborn-dev-accounts': 'http://127.0.0.1:8787',
  'riftborn-reborn-dev-mode-v1': 'true',
  'riftborn-reborn-dev-loadout-v1': '{}',
  'riftborn-dev-gate': 'gate-hash',
  'riftborn-score-outbox-v1': '[]',
  'some-other-project-key': 'not ours',
  'riftborn-reborn-huge': 'x'.repeat(MIGRATION.maxValueBytes + 1),
  ['riftborn-reborn-' + 'k'.repeat(120)]: 'key too long'
});
const MOVED = ['riftborn-reborn-profile-v1', 'riftborn-reborn-profile-v1-bak', 'riftborn-reborn-preferences-v1', 'riftborn-reborn-scores-v1', 'riftborn-reborn-boards-v1',
  'riftborn-reborn-score-outbox-v1', 'riftborn-reborn-whats-new-seen-v1', 'riftborn-profile-v1', 'neon-crypt-preferences-v1'].sort();

try {
  // ---- the servers answer like the real hosts ---------------------------------------------------------
  const legacyRoot = await get(LEGACY, '/riftborn/');
  assert.equal(legacyRoot.status, 200);
  assert.match(legacyRoot.text, /Riftborn has moved to <a id="rbTo" href="http:\/\/localhost:\d+\/">/, 'Noscript fallback: a line and a plain link');
  for (const [pathname, target] of [['/riftborn/classic/', LIVE + '/classic/'], ['/riftborn/dev/', DEV + '/']]) {
    const page = await get(LEGACY, pathname);
    assert.equal(page.status, 200, pathname);
    assert.ok(page.text.includes(`"target":"${target}"`), pathname + ' hands off to ' + target);
  }
  const unknown = await get(LEGACY, '/riftborn/some/old/path.html');
  assert.equal(unknown.status, 404);
  assert.ok(unknown.text.includes(`"target":"${LIVE}/"`), 'Unknown legacy paths hand off to the root');
  const privacy = await get(LEGACY, '/riftborn/privacy/');
  assert.ok(privacy.text.includes(`location.replace(${JSON.stringify(LIVE + '/privacy/')})`), 'Privacy: a plain redirect');
  assert.ok(!privacy.text.includes(MIGRATION.param), 'which carries no data');
  const inbox = await get(LEGACY, '/riftborn/feedback/');
  assert.ok(inbox.status === 200 && inbox.text.includes('inbox.js'), 'The feedback inbox stays on github.io');
  // No third-party (or any other) requests from the handoff pages: no src/href to load, a meta CSP
  // that allows only the page's own script.
  for (const page of [legacyRoot, unknown, privacy]) {
    assert.ok(!/\ssrc=/i.test(page.text), 'Nothing loaded by src');
    const style = /<style>([\s\S]*?)<\/style>/.exec(page.text)[1];
    assert.ok(!/@import|url\(/i.test(style), 'Nothing loaded by CSS');
    for (const link of page.text.match(/<link [^>]*>/g)) assert.match(link, /rel="(canonical|icon)"/);
    assert.match(page.text, /<link rel="icon" href="data:,">/, 'Not even a favicon request');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page.text)[1];
    assert.ok(csp.startsWith("default-src 'none'; script-src " + scriptHash(inlineScripts(page.text)[0]) + ';'), 'Only its own script may run');
  }
  const liveRoot = await get(LIVE, '/');
  assert.equal(liveRoot.status, 200);
  assert.match(liveRoot.headers.get('content-security-policy'), /^default-src 'self'; script-src 'self' 'sha256-/);
  assert.equal(liveRoot.headers.get('cache-control'), 'no-cache');
  assert.equal(liveRoot.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains', 'HSTS covers dev. and api. too (no preload)');
  assert.match(liveRoot.text, /<script type="module" src="js\/riftborn\.[0-9a-f]+\.js">/);
  assert.equal((await get(LIVE, '/classic/')).status, 200);
  assert.equal((await get(LIVE, '/privacy/')).status, 200);
  assert.equal((await get(LIVE, '/version.json')).headers.get('cache-control'), 'no-store');
  const moved = await get(LIVE, '/riftborn/classic/');
  assert.deepEqual([moved.status, moved.headers.get('location')], [301, '/classic/']);
  const missing = await get(LIVE, '/no/such/page');
  assert.equal(missing.status, 404);
  assert.match(missing.text, /PAGE NOT FOUND/);
  const devRoot = await get(DEV, '/');
  assert.equal(devRoot.status, 200);
  assert.match(devRoot.text, /id="devGate"/);
  assert.equal(devRoot.headers.get('x-robots-tag'), 'noindex, nofollow');
  console.log('PASS hosts: github.io stand-in serves handoff pages (root, classic, dev, 404) + privacy redirect + inbox; riftborn.us and dev stand-ins serve the game under _headers.');

  // ---- the root hand-off, compressed -------------------------------------------------------------------
  const storage = seeded();
  const before = storage.snapshot();
  const root = await runPage(legacyRoot.text, LEGACY + '/riftborn/', { storage });
  assert.ok(root.replaced && root.replaced.startsWith(LIVE + '/#' + MIGRATION.param + '='), 'Leaves with location.replace to the new root');
  const payload = await decode(root.replaced);
  assert.equal(payload.kind, 'z.', 'Compressed where CompressionStream exists');
  checkContract(payload.data);
  assert.deepEqual(Object.keys(payload.data.keys).sort(), MOVED, 'Exactly the contract keys move');
  for (const key of MOVED) assert.equal(payload.data.keys[key], before[key], 'Moved unchanged: ' + key);
  assert.equal(payload.data.keys['riftborn-reborn-profile-v1'], profile, 'Unicode survives the trip');
  const marker = JSON.parse(storage.getItem(MIGRATION.marker));
  assert.equal(marker.to, LIVE + '/');
  assert.equal(marker.keys, MOVED.length);
  const after = storage.snapshot();
  delete after[MIGRATION.marker];
  assert.deepEqual(after, before, 'The old copy is never changed (only the marker is added)');
  assert.equal(root.elements.rbTo.href, root.replaced, 'The fallback link carries the data too');
  // Idempotent: again, the same data.
  const again = await decode((await runPage(legacyRoot.text, LEGACY + '/riftborn/', { storage })).replaced);
  assert.deepEqual(again.data.keys, payload.data.keys, 'A second visit sends the same data (the marker is never sent)');
  console.log(`PASS root hand-off (z.): ${MOVED.length} keys moved, session/verifier/sync/reminder/dev-accounts/dev-gate/foreign/oversized keys left behind, old copy untouched (${payload.length} characters).`);

  // ---- plain payload fallback ---------------------------------------------------------------------------
  for (const compression of ['none', 'no-deflate-raw']) {
    const result = await runPage(legacyRoot.text, LEGACY + '/riftborn/', { storage: seeded(), compression });
    const plain = await decode(result.replaced);
    assert.equal(plain.kind, 'j.', 'Plain JSON without deflate-raw (' + compression + ')');
    checkContract(plain.data);
    assert.deepEqual(plain.data.keys, payload.data.keys);
  }
  console.log('PASS plain hand-off (j.): without CompressionStream, and where deflate-raw is unsupported.');

  // ---- caps -------------------------------------------------------------------------------------------------
  {
    const many = seeded();
    for (let i = 0; i < 80; i++) many.setItem('riftborn-reborn-extra-' + String(i).padStart(2, '0'), 'v' + i);
    const capped = await decode((await runPage(legacyRoot.text, LEGACY + '/riftborn/', { storage: many })).replaced);
    checkContract(capped.data);
    assert.equal(Object.keys(capped.data.keys).length, MIGRATION.maxKeys, '64 keys at most');
    for (const key of MIGRATION.priority.filter(key => many.getItem(key) !== null)) assert.ok(key in capped.data.keys, 'Priority keys survive the key cap: ' + key);

    const heavy = seeded();
    const big = n => Array.from({ length: 250 * 1024 }, (_, i) => String.fromCharCode(97 + ((i * 7 + n) % 26))).join('');
    for (let i = 0; i < 5; i++) heavy.setItem('riftborn-reborn-big-' + i, big(i));
    const total = await decode((await runPage(legacyRoot.text, LEGACY + '/riftborn/', { storage: heavy })).replaced);
    checkContract(total.data);
    assert.ok('riftborn-reborn-profile-v1' in total.data.keys, 'The profile survives the total cap');
    assert.ok(Object.keys(total.data.keys).filter(key => key.startsWith('riftborn-reborn-big-')).length < 5, 'The 1 MB total drops what does not fit');

    // Incompressible data without compression: the URL stays under the limit, least important keys left behind.
    const noisy = seeded();
    for (let i = 0; i < 4; i++) noisy.setItem('riftborn-reborn-noise-' + i, randomBytes(180 * 1024).toString('base64'));
    const fitted = await decode((await runPage(legacyRoot.text, LEGACY + '/riftborn/', { storage: noisy, compression: 'none' })).replaced);
    checkContract(fitted.data);
    assert.ok(fitted.length <= MIGRATION.maxFragmentChars, 'The hand-off URL stays under ~1 MB');
    assert.ok('riftborn-reborn-profile-v1' in fitted.data.keys && 'riftborn-reborn-preferences-v1' in fitted.data.keys, 'and keeps the important keys');
  }
  console.log('PASS caps: 64 keys, 256 KB per value, 1 MB in all, URL length; the profile and settings always go first.');

  // ---- query, other paths, loop guard ----------------------------------------------------------------------
  {
    const practice = await runPage(legacyRoot.text, LEGACY + '/riftborn/?practice=stage1', { storage: seeded() });
    assert.ok(practice.replaced.startsWith(LIVE + '/?practice=stage1#' + MIGRATION.param + '='), 'A plain query like ?practice= survives');
    const odd = await runPage(legacyRoot.text, LEGACY + '/riftborn/?next=javascript:alert(1)', { storage: seeded() });
    assert.ok(odd.replaced.startsWith(LIVE + '/#'), 'Any other query is dropped');
    const stale = await runPage(legacyRoot.text, LEGACY + '/riftborn/#rb_login=old', { storage: seeded() });
    assert.ok(!stale.replaced.includes('rb_login'), 'An old fragment is dropped');

    const classicPage = (await get(LEGACY, '/riftborn/classic/')).text;
    const classic = await runPage(classicPage, LEGACY + '/riftborn/classic/', { storage: seeded() });
    assert.ok(classic.replaced.startsWith(LIVE + '/classic/#' + MIGRATION.param + '='));
    assert.equal((await decode(classic.replaced)).data.keys['riftborn-profile-v1'], JSON.stringify({ classic: true, best: 42 }), 'Classic saves move with the classic edition');
    const devPage = (await get(LEGACY, '/riftborn/dev/')).text;
    const dev = await runPage(devPage, LEGACY + '/riftborn/dev/', { storage: seeded() });
    assert.ok(dev.replaced.startsWith(DEV + '/#' + MIGRATION.param + '='));
    assert.ok(!('riftborn-dev-gate' in (await decode(dev.replaced)).data.keys), 'The dev gate key never moves');
    const lost = await runPage(unknown.text, LEGACY + '/riftborn/some/old/path.html', { storage: seeded() });
    assert.ok(lost.replaced.startsWith(LIVE + '/#' + MIGRATION.param + '='));
    const moveOnly = await runPage(privacy.text, LEGACY + '/riftborn/privacy/', { storage: seeded() });
    assert.equal(moveOnly.replaced, LIVE + '/privacy/');

    // Sent back here again and again within a minute: the fourth time it stops and keeps the link.
    const session = new FakeStorage();
    const loopStorage = seeded();
    for (let i = 0; i < 3; i++) assert.ok((await runPage(legacyRoot.text, LEGACY + '/riftborn/', { storage: loopStorage, session })).replaced);
    const stopped = await runPage(legacyRoot.text, LEGACY + '/riftborn/', { storage: loopStorage, session });
    assert.equal(stopped.replaced, null, 'A hand-off loop stops');
    assert.ok(stopped.elements.rbTo.href.includes('#' + MIGRATION.param + '='), 'and the link still carries the data');
    assert.match(stopped.elements.rbNote.textContent, /progress is safe/);
    // Nothing is logged anywhere.
    assert.ok(!/console\./.test(legacyRoot.text));
  }
  console.log('PASS paths: ?practice= kept, other queries and fragments dropped; classic, dev, 404 and privacy go to the right place; a hand-off loop stops.');

  // ---- pre-launch riftborn.us never bounces a hand-off back ----------------------------------------------
  {
    const out = path.join(tmp, 'pre');
    const pre = spawnSync(process.execPath, ['scripts/build-pages.mjs'], { env: { ...baseEnv, RIFTBORN_PAGES_OUT: out, RIFTBORN_FORCE_LAUNCHED: '0' }, encoding: 'utf8' });
    assert.equal(pre.status, 0, pre.stderr);
    const page = fs.readFileSync(path.join(out, '_cf', 'live', 'index.html'), 'utf8');
    const visit = await runPage(page, 'https://riftborn.us/?practice=stage1');
    assert.equal(visit.replaced, 'https://chancrisp.github.io/riftborn/?practice=stage1', 'Before launch riftborn.us sends visitors to github.io');
    assert.equal((await runPage(page, 'https://riftborn.us/classic/')).replaced, 'https://chancrisp.github.io/riftborn/classic/');
    const early = await runPage(page, 'https://riftborn.us/#rb_migrate=z.abc');
    assert.equal(early.replaced, null, 'but never sends a hand-off back (no loop while the deploys finish)');
    assert.match(early.elements.rbNote.textContent, /Reload this page in a minute/);
  }
  console.log('PASS pre-launch riftborn.us: sends visitors to github.io, never bounces a hand-off.');

  // ---- the classic edition's receiving side (riftborn.us/classic/) -----------------------------------------
  {
    const classicLive = await get(LIVE, '/classic/');
    const scripts = inlineScripts(classicLive.text);
    const importer = scripts.find(text => text.includes('RIFTBORN_CLASSIC_IMPORT = new Promise'));
    const loader = scripts.find(text => text.includes('var wait = window.RIFTBORN_CLASSIC_IMPORT'));
    assert.ok(importer && loader, 'The classic page carries the importer and the game loader');
    const head = classicLive.text.slice(0, classicLive.text.indexOf('</head>'));
    assert.equal(head.indexOf('<script'), head.indexOf('<script>(function () {\n"use strict";\nvar C = {"fragment":"#rb_migrate="'), 'The importer is the first script, before anything reads storage');
    assert.ok(!/<script type="module"/.test(classicLive.text), 'The classic game module no longer starts on its own');
    assert.match(loader, /s\.src = "game\.js\?v=\d+";/, 'The loader starts the same game module');
    assert.ok(classicLive.text.indexOf(loader) > classicLive.text.indexOf('id="devMetrics"'), 'after the whole page is parsed');
    const csp = classicLive.headers.get('content-security-policy');
    for (const text of scripts) assert.ok(csp.includes(scriptHash(text)), 'riftborn.us allows every classic inline script by hash');
    assert.ok(!/console\./.test(importer), 'Nothing is logged');
    assert.ok(!(await get(LEGACY, '/riftborn/classic/')).text.includes('RIFTBORN_CLASSIC_IMPORT'), 'github.io never imports');

    const toastText = MIGRATION.toast;
    /** Loads the classic page like a browser at `url`: head (importer), body, loader, DOMContentLoaded. */
    async function runClassic(url, { storage = new FakeStorage(), session = new FakeStorage(), hostname } = {}) {
      const where = new URL(url);
      const history = [];
      const location = { href: where.href, pathname: where.pathname, search: where.search, hash: where.hash, hostname: hostname ?? where.hostname };
      const appended = [];
      const ready = [];
      const element = tag => ({ tagName: tag.toUpperCase(), className: '', textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
      const body = { appendChild(child) { child.parentNode = body; appended.push(child); return child; }, removeChild(child) { appended.splice(appended.indexOf(child), 1); } };
      const document = { body: null, readyState: 'loading', createElement: element, addEventListener: (type, fn) => type === 'DOMContentLoaded' && ready.push(fn) };
      const window = { localStorage: storage, sessionStorage: session };
      const historyApi = { state: null, replaceState(state, title, to) { history.push(to); location.hash = ''; } };
      const run = (script, extra = {}) => new Function('window', 'document', 'location', 'history', 'localStorage', 'sessionStorage', 'console', script)(window, document, location, historyApi, storage, session, extra.console);
      const logged = [];
      const quiet = new Proxy({}, { get: () => (...args) => logged.push(args) });
      run(importer, { console: quiet });
      const hashAfterHead = location.hash;
      document.body = body; // the parser reaches the end of <body>
      run(loader);
      const startedEarly = appended.some(child => child.tagName === 'SCRIPT');
      document.readyState = 'interactive';
      for (const fn of ready) fn();
      if (window.RIFTBORN_CLASSIC_IMPORT) await window.RIFTBORN_CLASSIC_IMPORT;
      await new Promise(resolve => setTimeout(resolve, 0));
      const game = appended.filter(child => child.tagName === 'SCRIPT');
      const toasts = appended.filter(child => child.className.startsWith('moved-toast'));
      return { history, hashAfterHead, startedEarly, game, toasts, storage, session, logged, waited: !!window.RIFTBORN_CLASSIC_IMPORT };
    }
    const handOver = async (storage, pathname = '/riftborn/classic/', compression) => (await runPage((await get(LEGACY, pathname)).text, LEGACY + pathname, { storage, compression })).replaced;

    // A classic player follows an old /classic/ bookmark to a riftborn.us that has never seen them.
    const oldDevice = seeded();
    const to = await handOver(oldDevice);
    assert.ok(to.startsWith(LIVE + '/classic/#' + MIGRATION.param + '=z.'));
    const fresh = await runClassic(to);
    assert.deepEqual(fresh.history, ['/classic/'], 'The fragment leaves the address bar at once (history.replaceState)');
    assert.equal(fresh.hashAfterHead, '', 'before anything else runs');
    assert.equal(fresh.startedEarly, false, 'The classic game waits for the import (it reads localStorage as it loads)');
    assert.equal(fresh.game.length, 1, 'then starts, once');
    assert.equal(fresh.game[0].src, JSON.parse(/s\.src = ("[^"]+");/.exec(loader)[1]));
    assert.equal(fresh.game[0].type, 'module');
    for (const key of MOVED) assert.equal(fresh.storage.getItem(key), oldDevice.getItem(key), 'Moved to /classic/: ' + key);
    for (const key of Object.keys(fresh.storage.snapshot())) assert.ok(MOVED.includes(key) || key === MIGRATION.receive.doneKey, 'Nothing else arrives: ' + key);
    assert.equal(fresh.storage.getItem('riftborn-profile-v1'), JSON.stringify({ classic: true, best: 42 }), 'The classic profile arrives');
    assert.equal(fresh.session.getItem(MIGRATION.receive.pendingKey), null, 'Nothing left pending');
    assert.equal(fresh.toasts.length, 1, 'The "moved" toast shows');
    assert.equal(fresh.toasts[0].textContent, toastText);
    assert.equal(fresh.toasts[0].attributes.role, 'status');
    assert.deepEqual(fresh.logged, [], 'Nothing logged');
    // Visiting the old /classic/ address again: harmless, no second toast.
    const before = fresh.storage.snapshot();
    const again = await runClassic(await handOver(oldDevice), { storage: fresh.storage });
    assert.deepEqual(again.storage.snapshot(), before, 'Importing again changes nothing');
    assert.equal(again.toasts.length, 0, 'The toast shows once');
    // Then the old root address: the classic profile is already here and stays (no fresh copy was
    // ever created on riftborn.us/classic/, so nothing was lost).
    assert.equal(fresh.storage.getItem('riftborn-profile-v1'), oldDevice.getItem('riftborn-profile-v1'));

    // A device that already has data on riftborn.us: absent keys are set; present keys keep their
    // value; rebuilt-game data it already has (the Journal etc.) is left pending in this tab for the
    // rebuilt game's own merge, never folded in or overwritten here.
    const mine = new FakeStorage({
      'riftborn-profile-v1': JSON.stringify({ classic: true, best: 7, newer: true }),
      'riftborn-reborn-profile-v1': JSON.stringify({ v: 3, name: 'Here', bestScore: 5 }),
      [MIGRATION.receive.doneKey]: '{"at":1,"from":"chancrisp.github.io"}'
    });
    const mixed = await runClassic(await handOver(seeded()), { storage: mine });
    assert.equal(mine.getItem('riftborn-profile-v1'), JSON.stringify({ classic: true, best: 7, newer: true }), 'A present classic profile keeps its value');
    assert.equal(mine.getItem('riftborn-reborn-profile-v1'), JSON.stringify({ v: 3, name: 'Here', bestScore: 5 }), 'The Journal here is never overwritten');
    assert.equal(mine.getItem('riftborn-migration-profile-v1'), null, 'nor staged by the classic page');
    assert.equal(mine.getItem('neon-crypt-preferences-v1'), JSON.stringify({ volume: 1 }), 'An absent key is set');
    assert.equal(mine.getItem('riftborn-reborn-scores-v1'), JSON.stringify([{ score: 1000, name: 'Chan' }]));
    const pending = mixed.session.getItem(MIGRATION.receive.pendingKey);
    assert.ok(pending && pending.startsWith('z.'), 'The payload waits in this tab for the rebuilt game (its importer merges the Journal)');
    assert.equal(mixed.toasts.length, 0, 'No second toast on a device that already took a hand-over');
    assert.equal(mixed.game.length, 1);
    // A reload before the rebuilt game runs: the pending payload is imported again, harmlessly.
    const reload = await runClassic(LIVE + '/classic/', { storage: mine, session: mixed.session });
    assert.deepEqual(reload.history, [], 'Nothing to take off the address bar');
    assert.equal(reload.game.length, 1);
    assert.equal(mine.getItem('riftborn-profile-v1'), JSON.stringify({ classic: true, best: 7, newer: true }));

    // Plain payloads (j.), a classic-only device (nothing left pending).
    const classicOnly = new FakeStorage({ 'riftborn-profile-v1': JSON.stringify({ classic: true, best: 42 }), 'neon-crypt-preferences-v1': '{"volume":0}' });
    const plainTo = await handOver(classicOnly, '/riftborn/classic/', 'none');
    assert.ok(plainTo.includes('#' + MIGRATION.param + '=j.'));
    const plainRun = await runClassic(plainTo);
    assert.deepEqual(plainRun.storage.snapshot()['neon-crypt-preferences-v1'], '{"volume":0}');
    assert.equal(plainRun.session.getItem(MIGRATION.receive.pendingKey), null);

    // Malformed payloads, the wrong host, no hand-over at all: the fragment still leaves, nothing is
    // written, nothing is logged, the game starts.
    for (const bad of ['z.@@@', 'z.' + Buffer.from('not deflate').toString('base64url'), 'j.' + Buffer.from('{"v":2,"from":"chancrisp.github.io","keys":{}}').toString('base64url'),
      'j.' + Buffer.from(JSON.stringify({ v: 1, from: 'evil.example', at: 1, keys: { 'riftborn-profile-v1': 'x' } })).toString('base64url'), 'x.abc', '']) {
      const run = await runClassic(LIVE + '/classic/#' + MIGRATION.param + '=' + bad);
      assert.deepEqual(run.history, ['/classic/'], 'The fragment leaves: ' + bad.slice(0, 12));
      assert.deepEqual(run.storage.snapshot(), {}, 'Nothing written: ' + bad.slice(0, 12));
      assert.equal(run.session.getItem(MIGRATION.receive.pendingKey), null);
      assert.deepEqual([run.game.length, run.toasts.length, run.logged.length], [1, 0, 0]);
    }
    const elsewhere = await runClassic(to.replace(LIVE, 'https://chancrisp.github.io'), { hostname: 'chancrisp.github.io' });
    assert.deepEqual(elsewhere.storage.snapshot(), {}, 'Only riftborn.us (and local test servers) accept a hand-over');
    const contractKeys = { 'riftborn-reborn-session-v1': 's', 'riftborn-dev-gate': 'g', 'riftborn-reborn-dev-accounts': 'd', 'some-other-project-key': 'o', 'riftborn-profile-v1': 'p' };
    const forged = 'j.' + Buffer.from(JSON.stringify({ v: 1, from: 'chancrisp.github.io', at: 1, keys: contractKeys })).toString('base64url');
    const guarded = await runClassic(LIVE + '/classic/#' + MIGRATION.param + '=' + forged);
    assert.deepEqual(guarded.storage.snapshot()['riftborn-profile-v1'], 'p');
    for (const key of Object.keys(contractKeys).filter(key => key !== 'riftborn-profile-v1')) assert.equal(guarded.storage.getItem(key), null, 'Never accepted: ' + key);
    const plain = await runClassic(LIVE + '/classic/');
    assert.deepEqual([plain.history.length, plain.waited, plain.game.length, plain.startedEarly], [0, false, 1, true], 'No hand-over: the game starts right away, as before');

    // Local only: the classic importer's limits and keys match the rebuilt game's importer (sibling checkout).
    const gameMigration = path.resolve('..', 'riftborn', 'src', 'meta', 'migration.js');
    if (fs.existsSync(gameMigration)) {
      const source = fs.readFileSync(gameMigration, 'utf8');
      const storageSource = fs.readFileSync(path.resolve('..', 'riftborn', 'src', 'core', 'storage.js'), 'utf8');
      assert.ok(source.includes(`MIGRATION_PENDING_KEY = "${MIGRATION.receive.pendingKey}"`), 'Same pending key as the game');
      assert.ok(source.includes(`const KEY_RE = /${MIGRATION.receive.keyPattern}/;`), 'Same key rule as the game');
      assert.ok(source.includes('payload: 3_000_000') && MIGRATION.receive.maxPayloadChars === 3_000_000);
      assert.ok(source.includes('json: 4 * 1024 * 1024') && MIGRATION.receive.maxJsonBytes === 4 * 1024 * 1024);
      assert.ok(source.includes('value: 256 * 1024') && source.includes('total: 1024 * 1024') && source.includes('keys: 64'));
      assert.ok(source.includes(`MOVED_TEXT = "${MIGRATION.toast}"`) && source.includes(`MOVED_TOAST_MS = ${MIGRATION.receive.toastMs}`));
      assert.ok(storageSource.includes(`migrationDone: "${MIGRATION.receive.doneKey}"`) && storageSource.includes(`profile: "${MIGRATION.receive.profileKey}"`));
      for (const key of [...MIGRATION.exclude, ...MIGRATION.extra]) assert.ok(source.includes(`"${key}"`), 'The game knows ' + key);
      console.log('PASS classic importer limits and keys match the rebuilt game (../riftborn).');
    }
  }
  console.log('PASS classic hand-over: riftborn.us/classic/ imports before the classic game starts, takes the fragment off at once, sets absent keys, keeps present ones, leaves rebuilt-game merges to the rebuilt game, ignores malformed payloads, toasts once, is idempotent.');

  // ---- the receiving side --------------------------------------------------------------------------------
  const liveFiles =[liveRoot.text, ...[...liveRoot.text.matchAll(/src="(js\/[^"]+)"/g)].map(match => fs.readFileSync(path.join(tmp, '_cf', 'live', match[1]), 'utf8'))].join('\n');
  if (liveFiles.includes(MIGRATION.param)) console.log('NOTE the live/ build reads #' + MIGRATION.param + ': run `node tests/migration-handoff.mjs --serve` for the browser round trip.');
  else console.log('NOTE the live/ build in this repo does not read #' + MIGRATION.param + ' yet (the game-side import lands with the 2.2 build); build-pages refuses a real launch until it does.');
} finally {
  await stopAll();
  fs.rmSync(tmp, { recursive: true, force: true });
}
