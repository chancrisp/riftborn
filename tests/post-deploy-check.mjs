// The post-deploy check (scripts/post-deploy-check.mjs, run by .github/workflows/post-deploy-check.yml
// after every deploy) without a network or a browser. Proves:
//   - version.json must match the committed live/ and dev/ builds field for field;
//   - the social tags and key files are read from the page the way link previews and browsers see
//     them (attribute order, entities, srcset, same origin only);
//   - what is required comes from the committed live/index.html: a build without link-preview tags
//     (2.2.1, e.g. after a rollback) passes without them, one with them fails when they are missing,
//     and the served page must still link every file the committed one does;
//   - every HTTP GET is retried (timeouts, network errors, 408, 429, 5xx) with a backoff, nothing else;
//   - a newer deploy of main (running, or already served) supersedes the check: no failure, no alert;
//   - --dry-run reads only the checkout;
//   - the page is muted and the welcome popup and patch notes are pre-answered before it loads, and
//     the check can never send a write (only GET, HEAD and OPTIONS pass);
//   - only the listed outside noise (Cloudflare's injected beacon) is downgraded to a warning;
//   - annotations, the job summary and the Discord alert carry the result, scrubbed, one line, and
//     the alert can never ping anyone or go anywhere but a Discord webhook;
//   - the workflow is wired to the deploy workflow's exact name, reads only, checks out the deployed
//     commit, installs the pinned Playwright without install scripts, and keeps the webhook in env.
// Local only; nothing is fetched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEPLOY_WORKFLOW, EXTRA_PAGES, GET_TRIES, PLAYWRIGHT_DIR, PRELOAD_SESSION, PRELOAD_STORAGE, SOCIAL_TAGS, TOLERATED, checkLiveFiles, checkVersion, committedPage,
  discordPayload, dryRun, escData, expectedVersions, get, githubContext, isDiscordWebhook, isWriteRequest, linkedFiles, metaTags, missingCommittedFiles,
  newerDeploy, pageExpectations, report, retryable, sameBuild, scrub, sendAlert, servedAsPage, socialImages, socialProblems, splitTolerated, supersededReason,
  versionProblem
} from '../scripts/post-deploy-check.mjs';
import { HOSTS } from '../site.config.mjs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// --- version.json --------------------------------------------------------------------------------
{
  const committed = { version: '2.3.0', build: '9a695e9391', builtAt: '2026-10-01T03:21:56.004Z' };
  assert.equal(versionProblem(JSON.stringify(committed), committed), null);
  assert.equal(versionProblem(JSON.stringify({ ...committed, extra: 1 }), committed), null, 'extra served fields are fine');
  assert.match(versionProblem(JSON.stringify({ ...committed, build: 'c31fa5068b', version: '2.2.1' }), committed), /serves v2\.2\.1 \(build c31fa5068b\), the commit has v2\.3\.0/);
  assert.ok(versionProblem(JSON.stringify({ ...committed, builtAt: 'x' }), committed), 'a rebuilt same-version build is a different build');
  assert.equal(versionProblem('<html>', committed), 'is not JSON');
  assert.equal(versionProblem('null', committed), 'is not a JSON object');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riftborn-check-'));
  try {
    fs.mkdirSync(path.join(tmp, 'live'));
    fs.writeFileSync(path.join(tmp, 'live', 'version.json'), JSON.stringify(committed));
    assert.deepEqual(expectedVersions(tmp), { live: committed, dev: null });
    fs.mkdirSync(path.join(tmp, 'dev'));
    fs.writeFileSync(path.join(tmp, 'dev', 'version.json'), '{"version":"2.4.0"}');
    assert.equal(expectedVersions(tmp).dev, null, 'a version.json without a build is no build');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // This checkout: both outputs carry a build, so the workflow always has something to compare with.
  const here = expectedVersions();
  assert.ok(here.live?.build && here.dev?.build, 'live/version.json and dev/version.json carry a build');
}
console.log('PASS version.json: served = committed, field for field (version, build, builtAt); broken or missing files are problems.');

// --- social tags and key files -------------------------------------------------------------------
{
  const html = `<!doctype html><html><head>
    <meta charset="utf-8">
    <meta property="og:type" content="website">
    <meta content="https://riftborn.us/" property="og:url">
    <meta property="og:title" content="Riftborn &ndash; a PS1-style browser shooter">
    <meta property="og:title" content="second one is ignored">
    <meta property='og:description' content='Free &amp; no download'>
    <meta property="og:image" content="https://riftborn.us/assets/riftborn-card.jpg?v=1">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="https://riftborn.us/assets/riftborn-card.jpg?v=1">
    <link rel="icon" href="assets/favicon.ico" sizes="16x16 32x32 48x48">
    <link rel="apple-touch-icon" href="/assets/apple-touch-icon-180.png">
    <link rel="preload" href="assets/ps1-atlas.png" as="image">
    <link rel="modulepreload" href="js/riftborn.abc.js">
    <link rel="stylesheet" href="css/riftborn.def.css">
    <link rel="canonical" href="https://riftborn.us/">
    <link rel="preconnect" href="https://api.riftborn.us">
    <link rel="stylesheet" href="https://fonts.example/x.css">
  </head><body>
    <picture><source media="(min-width:700px)" srcset="assets/title-x3.png 3x, assets/title-x2.png 2x"><img src="assets/title.png#frag" alt=""></picture>
    <img src="data:image/png;base64,AAAA" alt="">
    <script type="module" src="js/riftborn.abc.js"></script>
    <a href="https://riftborn.us/privacy/">PRIVACY</a>
  </body></html>`;
  const tags = metaTags(html);
  assert.equal(tags.get('og:url'), 'https://riftborn.us/', 'attribute order does not matter');
  assert.equal(tags.get('og:title'), 'Riftborn &ndash; a PS1-style browser shooter', 'the first tag wins; unknown entities stay as written');
  assert.equal(tags.get('og:description'), 'Free & no download', 'single quotes and &amp;');
  assert.deepEqual(socialProblems(tags), []);
  assert.deepEqual(socialImages(tags), ['https://riftborn.us/assets/riftborn-card.jpg?v=1'], 'og:image and twitter:image are fetched once');

  const missing = new Map(tags);
  missing.delete('og:image');
  missing.delete('twitter:card');
  assert.deepEqual(socialProblems(missing), ['missing og:image, twitter:card (link previews break)']);
  assert.match(socialProblems(new Map([...tags, ['og:url', 'https://riftborn.pages.dev/']])).join(), /og:url is https:\/\/riftborn\.pages\.dev\//);
  assert.match(socialProblems(new Map([...tags, ['og:image', '/assets/card.jpg']])).join(), /og:image is not an absolute https:\/\/ URL/);
  assert.deepEqual(socialProblems(tags, 'http://localhost:8791'), [], 'a local run accepts the real og:url');
  assert.ok(SOCIAL_TAGS.includes('og:image') && SOCIAL_TAGS.includes('twitter:card'));

  assert.deepEqual(linkedFiles(html, 'https://riftborn.us/'), [
    'https://riftborn.us/assets/favicon.ico',
    'https://riftborn.us/assets/apple-touch-icon-180.png',
    'https://riftborn.us/assets/ps1-atlas.png',
    'https://riftborn.us/js/riftborn.abc.js',
    'https://riftborn.us/css/riftborn.def.css',
    'https://riftborn.us/assets/title-x3.png',
    'https://riftborn.us/assets/title-x2.png',
    'https://riftborn.us/assets/title.png'
  ], 'same-origin files only: no canonical, preconnect, other hosts, data: URLs or <a> links; no duplicates');
  assert.deepEqual(EXTRA_PAGES, ['/classic/', '/privacy/']);
  assert.equal(servedAsPage('https://riftborn.us/js/riftborn.abc.js', 'text/html; charset=utf-8'), true, 'a missing file behind a catch-all page fails');
  assert.equal(servedAsPage('https://riftborn.us/js/riftborn.abc.js', 'text/javascript'), false);
  assert.equal(servedAsPage('https://riftborn.us/classic/', 'text/html'), false, 'pages are HTML');
  assert.equal(servedAsPage('https://riftborn.us/x/index.html', 'text/html'), false);

  // The committed live page passes as it is: every social tag it has is well formed (a build without
  // them, e.g. after a rollback to 2.2.1, is not asked for any), and every file it links is in live/.
  const live = read('live/index.html');
  const committed = pageExpectations(live);
  assert.deepEqual(socialProblems(metaTags(live), HOSTS.live, committed.social), [], 'live/index.html: the social tags it has are complete and well formed');
  if (committed.social.length) assert.deepEqual(committed.social, SOCIAL_TAGS, 'a page with the social card carries every tag');
  assert.deepEqual(missingCommittedFiles(), [], 'every file live/index.html links is in live/');
  const files = linkedFiles(live, `${HOSTS.live}/`);
  for (const file of files) {
    const local = decodeURIComponent(new URL(file).pathname).slice(1);
    assert.ok(fs.existsSync(new URL(`../live/${local}`, import.meta.url)), `live/index.html links ${local}, which live/ has`);
  }
  assert.ok(files.some(file => /\/js\/riftborn\.[0-9a-f]+\.js$/.test(file)) && files.some(file => /\/css\/riftborn\.[0-9a-f]+\.css$/.test(file)), 'the game bundle and stylesheet are key files');
}
console.log('PASS social tags and key files: read like link previews and browsers do, same origin only, and the committed live page is complete.');

// --- what the committed page requires (rollbacks) -------------------------------------------------
{
  // A page from before the social card (2.2.1, 2.2.0): a data: favicon, no Open Graph or Twitter tags.
  const old = `<!doctype html><html><head><meta charset="utf-8"><title>Riftborn</title>
    <meta name="description" content="A PS1-style survival shooter.">
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">
    <link rel="preload" href="assets/ps1-atlas.png" as="image" crossorigin="anonymous">
    <link rel="preload" href="assets/crypt-pixel.ttf" as="font" type="font/ttf" crossorigin>
    <link rel="stylesheet" href="css/riftborn.12aac50236.css">
  </head><body><h1 class="brand-title">RIFT<span>BORN</span></h1>
    <script type="module" src="js/riftborn.c31fa5068b.js"></script></body></html>`;
  const oldExpect = pageExpectations(old);
  assert.deepEqual(oldExpect, {
    social: [], cardImages: [],
    files: ['/assets/ps1-atlas.png', '/assets/crypt-pixel.ttf', '/css/riftborn.12aac50236.css', '/js/riftborn.c31fa5068b.js']
  }, 'a pre-card page requires no social tags and no card image, only the files it links');
  assert.deepEqual(socialProblems(metaTags(old), HOSTS.live, oldExpect.social), [], 'and passes the tag check without any');
  assert.match(socialProblems(metaTags(old)).join(), /missing og:type/, '(the full list would fail it)');

  // A fake riftborn.us: path -> { type, text }; anything else is a 404.
  const site = pages => async url => {
    const u = new URL(url);
    const hit = pages[u.pathname + u.search];
    return hit ? { status: 200, type: hit.type, text: hit.text || '', bytes: hit.bytes ?? Math.max(1, (hit.text || '').length), tries: 1 } : { status: 404, type: 'text/plain', text: 'Not found', bytes: 9, tries: 1 };
  };
  const typeOf = file => ({ png: 'image/png', jpg: 'image/jpeg', ico: 'image/x-icon', ttf: 'font/ttf', css: 'text/css', js: 'text/javascript' })[file.split('?')[0].split('.').pop()] || 'application/octet-stream';
  const pagesFor = (html, extra = {}) => Object.fromEntries([
    ['/', { type: 'text/html', text: html }],
    ...pageExpectations(html).files.map(file => [file, { type: typeOf(file), bytes: 100 }]),
    ...EXTRA_PAGES.map(p => [p, { type: 'text/html', text: '<!doctype html>' }]),
    ...Object.entries(extra)
  ]);
  const okAll = checks => checks.every(check => check.ok);

  // Rolled back to 2.2.1: served = committed, no social tags anywhere -> healthy.
  const rolledBack = await checkLiveFiles(HOSTS.live, oldExpect, { getImpl: site(pagesFor(old)) });
  assert.ok(okAll(rolledBack), JSON.stringify(rolledBack));
  assert.deepEqual(rolledBack.map(check => check.name), ['Open Graph and Twitter tags', 'key files'], 'no card image check for a page without one');
  assert.match(rolledBack[0].detail, /not required: the committed live\/index\.html has none/);
  assert.match(rolledBack[1].detail, /^6 files and pages answer 200$/);

  // The committed live/ page served as committed: tags, card image and files pass; a local run
  // checks its own copy of the card image.
  const live = read('live/index.html');
  const committed = pageExpectations(live);
  const card = Object.fromEntries(committed.cardImages.map(url => new URL(url)).map(u => [u.pathname + u.search, { type: 'image/jpeg', bytes: 50000 }]));
  const today = await checkLiveFiles(HOSTS.live, committed, { getImpl: site(pagesFor(live, card)) });
  assert.ok(okAll(today), JSON.stringify(today));
  assert.equal(today.some(check => check.name.startsWith('card image ')), committed.cardImages.length > 0, 'the card image is fetched exactly when the committed page names one');
  const fetched = [];
  const localSite = site(pagesFor(live, card));
  const localRun = await checkLiveFiles('http://localhost:8791', committed, { getImpl: url => (fetched.push(url), localSite(url)) });
  assert.ok(okAll(localRun), JSON.stringify(localRun));
  assert.ok(fetched.every(url => url.startsWith('http://localhost:8791/')), 'a local run never fetches riftborn.us');

  // A committed page with the card, served without og:image (or without the card file, or as an old
  // cached page that links other files): fails.
  const carded = old.replace('<title>', `<meta property="og:type" content="website"><meta property="og:url" content="${HOSTS.live}/"><meta property="og:title" content="Riftborn"><meta property="og:description" content="d"><meta property="og:image" content="${HOSTS.live}/assets/riftborn-card.jpg?v=2"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${HOSTS.live}/assets/riftborn-card.jpg?v=2"><title>`);
  const cardedExpect = pageExpectations(carded);
  assert.deepEqual(cardedExpect.social, SOCIAL_TAGS);
  const withCard = { '/assets/riftborn-card.jpg?v=2': { type: 'image/jpeg', bytes: 1000 } };
  assert.ok(okAll(await checkLiveFiles(HOSTS.live, cardedExpect, { getImpl: site(pagesFor(carded, withCard)) })));
  const noImage = carded.replace(/<meta property="og:image"[^>]*>/, '');
  const stripped = await checkLiveFiles(HOSTS.live, cardedExpect, { getImpl: site({ ...pagesFor(carded, withCard), '/': { type: 'text/html', text: noImage } }) });
  assert.match(stripped.find(check => !check.ok).detail, /missing og:image/, 'a tag the committed page has must be served');
  const noCardFile = await checkLiveFiles(HOSTS.live, cardedExpect, { getImpl: site(pagesFor(carded)) });
  assert.equal(noCardFile.find(check => !check.ok).name, 'card image /assets/riftborn-card.jpg?v=2', 'the committed card image must answer');
  const stale = await checkLiveFiles(HOSTS.live, oldExpect, { getImpl: site({ ...pagesFor(old), '/': { type: 'text/html', text: old.replace('css/riftborn.12aac50236.css', 'css/riftborn.0000000000.css') } }) });
  assert.match(stale.find(check => !check.ok).detail, /the served page does not link \/css\/riftborn\.12aac50236\.css/, 'an old cached page is caught');
  assert.match(stale.find(check => !check.ok).detail, /\/css\/riftborn\.0000000000\.css HTTP 404/, 'and what it links is still fetched');
  const down = await checkLiveFiles(HOSTS.live, oldExpect, { getImpl: async () => ({ status: 503, type: '', text: '', bytes: 0, tries: GET_TRIES }) });
  assert.deepEqual(down, [{ site: 'riftborn.us', name: 'game page', ok: false, detail: `HTTP 503 (${GET_TRIES} tries)` }]);

  // --dry-run: offline, from a checkout's own files (here: a 2.2.1-shaped one).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riftborn-check-old-'));
  try {
    for (const dir of ['live/assets', 'live/css', 'live/js']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'live', 'index.html'), old);
    fs.writeFileSync(path.join(tmp, 'live', 'version.json'), '{"version":"2.2.1","build":"c31fa5068b","builtAt":"2026-09-30T19:00:48.321Z"}');
    for (const file of oldExpect.files.slice(0, 3)) fs.writeFileSync(path.join(tmp, 'live', file), 'x');
    assert.deepEqual(committedPage(tmp), oldExpect);
    assert.deepEqual(missingCommittedFiles(tmp), ['/js/riftborn.c31fa5068b.js']);
    assert.equal(dryRun(tmp).ok, false, 'a committed page that links a file live/ lacks fails the dry run');
    fs.writeFileSync(path.join(tmp, 'live', 'js', 'riftborn.c31fa5068b.js'), 'x');
    const dry = dryRun(tmp);
    assert.equal(dry.ok, true);
    assert.match(dry.lines.join('\n'), /v2\.2\.1 \(build c31fa5068b[\s\S]*not in this checkout[\s\S]*social tags required: none[\s\S]*card images: none required/);
    assert.equal(committedPage(path.join(tmp, 'nothing')), null);
    assert.deepEqual(missingCommittedFiles(path.join(tmp, 'nothing')), ['live/index.html']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
console.log('PASS committed page: a build is asked only for the tags, card image and files its committed live/index.html has (a 2.2.1 rollback passes, a stripped tag or an old cached page fails); --dry-run reads only the checkout.');

// --- retries -------------------------------------------------------------------------------------
{
  // Every GET: retried on no answer, 408, 429 and 5xx, with a growing pause; never on a real answer.
  for (const status of [0, 408, 429, 500, 502, 503, 504]) assert.equal(retryable(status), true, String(status));
  for (const status of [200, 301, 304, 400, 403, 404]) assert.equal(retryable(status), false, String(status));
  const answer = (status, text = '{}') => ({ status, headers: { get: () => 'application/json' }, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
  const scripted = steps => {
    const calls = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        const step = steps.shift();
        if (step instanceof Error) throw step;
        return answer(step);
      }
    };
  };
  const waits = [];
  const sleep = async ms => { waits.push(ms); };
  const flaky = scripted([503, 200]);
  const ok = await get('https://riftborn.us/version.json', { fetchImpl: flaky.fetchImpl, sleep });
  assert.deepEqual([ok.status, ok.tries, ok.text], [200, 2, '{}']);
  assert.deepEqual(waits, [2000]);
  assert.match(flaky.calls[0].url, /^https:\/\/riftborn\.us\/version\.json\?t=\d+$/, 'site requests skip caches');
  assert.equal(flaky.calls[0].init.headers['Cache-Control'], 'no-cache');
  waits.length = 0;
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const dead = scripted([timeout(), timeout(), timeout()]);
  const failed = await get('https://riftborn.us/', { fetchImpl: dead.fetchImpl, sleep });
  assert.deepEqual([failed.status, failed.error, failed.tries, dead.calls.length], [0, 'timed out', GET_TRIES, GET_TRIES]);
  assert.deepEqual(waits, [2000, 4000], 'backing off between tries');
  const missing = scripted([404]);
  assert.equal((await get('https://riftborn.us/x.png', { fetchImpl: missing.fetchImpl, sleep })).tries, 1, 'a 404 is an answer: no retry');
  const api = scripted([200]);
  await get('https://api.github.com/repos/o/r', { fetchImpl: api.fetchImpl, sleep, fresh: false, headers: { Accept: 'application/vnd.github+json' } });
  assert.equal(api.calls[0].url, 'https://api.github.com/repos/o/r', 'API calls keep their URL');
  assert.equal(api.calls[0].init.headers.Accept, 'application/vnd.github+json');
  // version.json: each try is a retried GET; no answer, then the right build, passes.
  const version = { version: '2.3.0', build: '9a695e9391' };
  const sequence = [{ status: 0, error: 'timed out', tries: 3, text: '' }, { status: 200, text: JSON.stringify(version), tries: 1 }];
  assert.deepEqual(await checkVersion('https://riftborn.us', version, { delayMs: 0, getImpl: async () => sequence.shift() }), { ok: true, detail: 'v2.3.0 (build 9a695e9391), on try 2' });
  assert.deepEqual(await checkVersion('https://riftborn.us', version, { attempts: 1, getImpl: async () => ({ status: 502, tries: 3, text: '' }) }), { ok: false, detail: 'HTTP 502 (3 tries)' });
  // The only fetch the script makes outside get() is the Discord alert (sendAlert), so every GET retries.
  const script = read('scripts/post-deploy-check.mjs');
  assert.deepEqual(script.match(/\bawait fetch\w*\(/g), ['await fetchImpl(', 'await fetchImpl('], 'one fetch in get(), one in sendAlert()');
}
console.log('PASS retries: every GET is tried up to 3 times on a timeout, a network error, 408, 429 or 5xx, backing off 2 s then 4 s; never on a real answer.');

// --- superseded by a newer deploy ----------------------------------------------------------------
{
  const mine = { live: { version: '2.3.0', build: 'aaaaaaaaaa', builtAt: '1' }, dev: { version: '2.3.0', build: 'aaaaaaaaaa', builtAt: '1' } };
  const next = { version: '2.3.1', build: 'bbbbbbbbbb', builtAt: '2' };
  const checkedSha = 'a'.repeat(40);
  const sites = { live: 'riftborn.us', dev: 'dev.riftborn.us' };
  const newer = { sha: 'b'.repeat(40), live: next, dev: mine.dev, running: 0 };
  assert.ok(sameBuild(next, next) && !sameBuild(mine.live, next) && !sameBuild(null, next));
  assert.equal(supersededReason({ checkedSha, expected: mine, newer, served: { live: next, dev: mine.dev }, sites }),
    'riftborn.us serves v2.3.1 (build bbbbbbbbbb), the newer live/version.json on main (bbbbbbb)');
  assert.equal(supersededReason({ checkedSha, expected: mine, newer: { ...newer, running: 1 }, served: { live: mine.live }, sites }), 'a newer deploy of main (bbbbbbb) is still running');
  assert.equal(supersededReason({ checkedSha, expected: mine, newer, served: { live: { version: '2.2.1', build: 'c31fa5068b' } }, sites }), '', 'a third build is a real mismatch');
  assert.equal(supersededReason({ checkedSha, expected: mine, newer: { ...newer, live: mine.live }, served: { live: mine.live }, sites }), '', 'main with the same builds (e.g. a previews-only push) is nothing newer');
  assert.equal(supersededReason({ checkedSha, expected: mine, newer: { ...newer, sha: checkedSha, running: 1 }, served: { live: next }, sites }), '', 'main still at the checked commit: never superseded');
  assert.equal(supersededReason({ checkedSha: '', expected: mine, newer: { ...newer, running: 1 }, served: {}, sites }), '', 'no checked commit (a local run): never superseded');
  assert.equal(supersededReason({ checkedSha, expected: mine, newer: null, served: { live: next }, sites }), '', 'GitHub could not say: report as is');

  // newerDeploy: main's head, the deploy runs and main's version.json files (read only, with the token).
  const calls = [];
  const answers = route => {
    if (route.endsWith('/branches/main')) return { commit: { sha: newer.sha } };
    if (route.includes(`/actions/workflows/${DEPLOY_WORKFLOW}/runs?branch=main`)) return { workflow_runs: [{ status: 'in_progress', head_sha: newer.sha }, { status: 'completed', head_sha: checkedSha }, { status: 'queued', head_sha: checkedSha }] };
    if (route.includes('/contents/live/version.json?ref=')) return next;
    return null;
  };
  const getImpl = async (url, options) => {
    calls.push({ url, options });
    const u = new URL(url);
    const body = answers(u.pathname + u.search);
    return body ? { status: 200, text: JSON.stringify(body), tries: 1 } : { status: 404, text: '{"message":"Not Found"}', tries: 1 };
  };
  assert.deepEqual(await newerDeploy({ repo: 'chancrisp/riftborn', token: 'ghs_token', sha: checkedSha }, { getImpl }), { sha: newer.sha, live: next, dev: null, running: 1 });
  assert.ok(calls.every(call => call.url.startsWith('https://api.github.com/repos/chancrisp/riftborn/') && call.options.fresh === false && call.options.headers.Authorization === 'Bearer ghs_token'));
  assert.ok(calls.some(call => call.url.endsWith(`/contents/live/version.json?ref=${newer.sha}`) && call.options.headers.Accept === 'application/vnd.github.raw+json'), "version.json at main's exact head");
  calls.length = 0;
  assert.deepEqual(await newerDeploy({ repo: 'chancrisp/riftborn', token: '', sha: newer.sha }, { getImpl }), { sha: newer.sha, live: null, dev: null, running: 0 }, 'main at the checked commit: nothing more is asked');
  assert.equal(calls.length, 1);
  assert.ok(!('Authorization' in calls[0].options.headers), 'no token, no Authorization header');
  assert.equal(await newerDeploy({ repo: 'chancrisp/riftborn', token: '', sha: checkedSha }, { getImpl: async () => ({ status: 0, text: '', tries: 3 }) }), null, 'GitHub down: unknown');
  assert.equal(githubContext(process.cwd(), {}), null, 'outside GitHub Actions: off');
  assert.equal(githubContext(process.cwd(), { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bad repo' }), null);

  // The report: one notice, no failure, no alert.
  const expected = { live: mine.live };
  const checks = [{ site: 'riftborn.us', name: 'version.json', ok: false, detail: 'serves v2.3.1 (build bbbbbbbbbb), the commit has v2.3.0 (build aaaaaaaaaa)' }];
  const superseded = report({ checks, expected, superseded: 'riftborn.us serves v2.3.1 (build bbbbbbbbbb), the newer live/version.json on main (bbbbbbb)' });
  assert.equal(superseded.ok, true);
  assert.equal(superseded.alert, '');
  assert.equal(superseded.superseded, true);
  assert.deepEqual(superseded.annotations, ["::notice title=Post-deploy check superseded::riftborn.us, committed v2.3.0 (build aaaaaaaaaa): superseded, riftborn.us serves v2.3.1 (build bbbbbbbbbb), the newer live/version.json on main (bbbbbbb); that deploy's own check covers it"]);
  assert.match(superseded.summary, /^### Post-deploy check: superseded[\s\S]*\| superseded \| riftborn\.us \| version\.json \|/);
  assert.equal(report({ checks, expected }).ok, false, 'without a newer deploy the same mismatch fails');
}
console.log('PASS superseded: when main moved on and its deploy is running or already served, a failed check passes as superseded, with a notice and no alert; otherwise a mismatch fails.');

// --- muted, no popups, no writes -----------------------------------------------------------------
{
  assert.deepEqual(JSON.parse(PRELOAD_STORAGE['riftborn-reborn-preferences-v1']), { muted: true, master: 0 });
  assert.equal(PRELOAD_STORAGE['riftborn-reborn-welcome-v1'], '1');
  assert.equal(PRELOAD_SESSION['riftborn-reborn-whats-new-visit-v1'], '1');
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) assert.equal(isWriteRequest(method), false, method);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) assert.equal(isWriteRequest(method), true, method);

  const script = read('scripts/post-deploy-check.mjs');
  assert.ok(!/click\(\s*['"]#start['"]/.test(script) && !/#start['"]?\s*\)\s*\.click/.test(script), 'START RUN is never clicked');
  assert.ok(script.includes("'--mute-audio'"), 'Chrome itself is muted as well');
  assert.ok(/route\.abort\(/.test(script) && /isWriteRequest\(request\.method\(\)\)/.test(script), 'every write from the page is aborted');

  const beacon = "console: Loading the script 'https://static.cloudflareinsights.com/beacon.min.js/v31edd' violates the following Content Security Policy directive";
  const [real, known] = splitTolerated([beacon, 'uncaught: boom', 'GET https://static.cloudflareinsights.com/beacon.min.js/v31edd csp']);
  assert.deepEqual(real, ['uncaught: boom']);
  assert.equal(known.length, 2);
  assert.deepEqual(splitTolerated(['console: https://evil.example/static.cloudflareinsights.com.js failed'])[0].length, 1, 'only the beacon path is tolerated');
  assert.ok(TOLERATED.length <= 2, 'the tolerated list stays short');
}
console.log('PASS no sound, no run, no writes: muted and popups pre-answered before load, START RUN never clicked, writes aborted; only the Cloudflare beacon is tolerated.');

// --- reporting and the Discord alert -------------------------------------------------------------
{
  const expected = { live: { version: '2.3.0', build: 'abc' } };
  const passing = report({ checks: [{ site: 'riftborn.us', name: 'version.json', ok: true, detail: 'v2.3.0' }, { site: 'riftborn.us', name: 'zero console errors', ok: true, detail: 'none', warning: '1 known' }], expected });
  assert.equal(passing.ok, true);
  assert.equal(passing.alert, '');
  assert.deepEqual(passing.annotations, [
    '::warning title=Post-deploy check%3A riftborn.us::zero console errors: 1 known',
    '::notice title=Post-deploy check::riftborn.us, committed v2.3.0 (build abc): healthy, 2 checks passed'
  ]);
  assert.match(passing.summary, /^### Post-deploy check: passed/);
  assert.match(passing.summary, /\| warn \| riftborn\.us \| zero console errors \| 1 known \|/);

  const hook = 'https://discord.com/api/webhooks/123/secret-token_value';
  const checks = Array.from({ length: 10 }, (_, i) => ({ site: 'riftborn.us', name: `check ${i}`, ok: false, detail: i ? `bad | ${i}` : `posted to ${hook}\nsecond line` }));
  const failing = report({ checks, expected, runUrl: 'https://github.com/chancrisp/riftborn/actions/runs/1' });
  assert.equal(failing.ok, false);
  assert.equal(failing.annotations.filter(line => line.startsWith('::error')).length, 9, '8 errors plus one "more in the summary" line');
  assert.ok(failing.annotations.every(line => !line.includes(hook) && !line.includes('secret-token')), 'no webhook URL in annotations');
  assert.ok(!failing.summary.includes('secret-token'), 'no webhook URL in the summary');
  assert.match(failing.summary, /bad \\\| 1/, 'pipes are escaped in the table');
  assert.match(failing.alert, /^Riftborn post-deploy check FAILED: riftborn\.us, committed v2\.3\.0 \(build abc\): 10 problems\. First: riftborn\.us check 0: posted to \[webhook url\] second line https:\/\/github\.com\/chancrisp\/riftborn\/actions\/runs\/1$/);
  assert.ok(!/[\r\n]/.test(failing.alert), 'the alert is one line (it travels as a job output)');
  assert.equal(escData('50%\nx'), '50%25%0Ax');
  assert.equal(scrub('x'.repeat(500), 20).length, 20);

  assert.deepEqual(discordPayload('@everyone deploy broke'), { content: '@everyone deploy broke', allowed_mentions: { parse: [] } }, 'never pings');
  assert.ok(isDiscordWebhook(hook) && isDiscordWebhook('https://discordapp.com/api/webhooks/1/a') && isDiscordWebhook('https://canary.discord.com/api/v10/webhooks/1/a-b'));
  for (const bad of ['', 'http://discord.com/api/webhooks/1/a', 'https://discord.com.evil.example/api/webhooks/1/a', 'https://evil.example/?u=https://discord.com/api/webhooks/1/a', 'https://discord.com/api/webhooks/1/a/../../x']) {
    assert.equal(isDiscordWebhook(bad), false, bad);
  }

  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 204 }; };
  assert.deepEqual(await sendAlert({ webhook: hook, text: 'Riftborn post-deploy check FAILED', fetchImpl }), { sent: true, note: 'Discord alert sent (HTTP 204)' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: 'Riftborn post-deploy check FAILED', allowed_mentions: { parse: [] } });
  assert.equal((await sendAlert({ webhook: '', text: 'x', fetchImpl })).sent, false);
  assert.equal((await sendAlert({ webhook: 'https://evil.example/hook', text: 'x', fetchImpl })).sent, false);
  assert.equal((await sendAlert({ webhook: hook, text: '  ', fetchImpl })).sent, false);
  assert.equal(calls.length, 1, 'nothing is sent without text or to a non-Discord URL');
  const failed = await sendAlert({ webhook: hook, text: 'x', fetchImpl: async () => { throw new Error(`connect failed ${hook}`); } });
  assert.equal(failed.sent, false);
  assert.ok(!failed.note.includes('secret-token'), 'a failed send never prints the webhook URL');
  assert.equal((await sendAlert({ webhook: hook, text: 'x', fetchImpl: async () => ({ ok: false, status: 404 }) })).note, 'Discord answered HTTP 404: no alert');
}
console.log('PASS reporting: annotations (capped), job summary and a one-line Discord alert, scrubbed; the alert never pings and only ever goes to a Discord webhook.');

// --- the workflow --------------------------------------------------------------------------------
{
  const workflow = read('.github/workflows/post-deploy-check.yml');
  const deployName = read('.github/workflows/pages.yml').match(/^name:\s*(.+)$/m)[1].trim();
  assert.ok(workflow.includes(`workflows: [${deployName}]`), `the check follows the deploy workflow by its exact name ("${deployName}"); renaming pages.yml's name breaks the trigger`);
  assert.match(workflow, /types: \[completed\]\s+branches: \[main\]/);
  assert.match(workflow, /^permissions:\s+contents: read\s*$/m, 'reads only');
  assert.match(workflow.match(/^permissions:[\s\S]*?^\S/m)[0], /^  actions: read$/m, 'and reads the deploy runs (superseded detection)');
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/, 'with the job token (read only), never a secret');
  assert.ok(!/write/.test(workflow.match(/^permissions:[\s\S]*?^\S/m)[0]), 'no write permission at the top');
  assert.match(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/, 'checks the commit that was deployed');
  assert.match(workflow, /persist-credentials: false/);
  assert.ok(workflow.includes(`npm ci --prefix ${PLAYWRIGHT_DIR} --ignore-scripts`), 'the pinned Playwright, without install scripts');
  assert.match(workflow, /run: node scripts\/post-deploy-check\.mjs\n/);
  assert.match(workflow, /run: node scripts\/post-deploy-check\.mjs --alert/);
  for (const line of workflow.split('\n').filter(line => /^\s*run:/.test(line))) assert.ok(!line.includes('${{'), `no expression is pasted into a shell line: ${line.trim()}`);
  assert.match(workflow, /DISCORD_WEBHOOK_URL: \$\{\{ secrets\.DISCORD_WEBHOOK_URL \}\}/);
  assert.equal((workflow.match(/secrets\./g) || []).length, 1, 'the webhook is the only secret it reads');
  assert.match(workflow, /alert:[\s\S]*if: failure\(\) && needs\.check\.result == 'failure'[\s\S]*environment: cloudflare-production/, 'the alert runs only on a failed check, in the environment that holds the webhook');

  const pkg = JSON.parse(read(`${PLAYWRIGHT_DIR}/package.json`));
  const lock = JSON.parse(read(`${PLAYWRIGHT_DIR}/package-lock.json`));
  assert.deepEqual(Object.keys(pkg.dependencies), ['playwright-core'], 'Playwright core only (no bundled browser download)');
  assert.match(pkg.dependencies['playwright-core'], /^\d+\.\d+\.\d+$/, 'exact-pinned');
  assert.equal(lock.packages['node_modules/playwright-core'].version, pkg.dependencies['playwright-core'], 'the lockfile pins the same version');
  assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/playwright-core'], 'nothing else is installed');
  assert.match(lock.packages['node_modules/playwright-core'].integrity, /^sha512-/);
}
console.log('PASS workflow: follows the deploy workflow by name, reads only, checks the deployed commit, pinned Playwright without install scripts, webhook only in env.');
