// Preview links (scripts/pages-previews.mjs, scripts/cloudflare-pages-deploy.mjs --previews,
// scripts/cloudflare-pages-verify.mjs --previews, .github/workflows/previews.yml): only safe names
// that start with the version of the build they hold (v2-4-0, v2-4-0-logo; never "main", which would
// replace dev.riftborn.us), only gated + noindex builds whose HOST CONFIG
// gives the preview address nothing (never scores, not even leaderboard reads), the dev build's
// strict headers on every preview, stale previews deleted (production deployments never), and
// production outputs untouched.
// Stages into a temporary folder and fakes every Cloudflare call; local only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CF_MAX_LINE, CF_MAX_RULES, htmlUrlPath, inlineScripts, matchHeaders, parseHeaders, scriptHash } from '../scripts/pages-headers.mjs';
import {
  DIGEST_TAG, cleanupPlan, cloudflareApi, deleteDeployment, hostServices, isUnchanged, listPreviewDeployments, previewCommitMessage,
  previewDigest, previewNamePrefix, previewNameProblem, previewOrigin, previewProblems, previewVersionProblem, readStagedPreviews, stagePreviews
} from '../scripts/pages-previews.mjs';
import { deployPlan, previewDeployPlan } from '../scripts/cloudflare-pages-deploy.mjs';
import { checkPreviewsOnce, verifyDeployment } from '../scripts/cloudflare-pages-verify.mjs';
import { withHostConfig2_3_0 } from './fixtures/host-config-2.3.0.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riftborn-previews-'));
const read = file => fs.readFileSync(file, 'utf8');
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(file, base) : [path.relative(base, file).split(path.sep).join('/')];
}).sort();
const OFF = { scores: '', reads: '', feedback: '', accounts: '' };
const devBuild = JSON.parse(read('dev/version.json'));
// The previews below hold the dev build, so their names start with its version (2.3.0 -> v2-3-0):
// A is the untagged one, B a tagged one of the same version.
const V = previewNamePrefix(devBuild.version);
assert.ok(V, `dev/version.json version ${devBuild.version} is MAJOR.MINOR.PATCH`);
const A = V;
const B = `${V}-dash`;
const dots = text => text.replace(/\./g, '\\.');

// A preview as the source repo's .tools/deploy-preview.mjs stages it: the gated test build (dev/,
// gated by the same dev-gate.mjs) plus its preview.json.
function preview(base, name, { edit, info = {}, from = 'dev' } = {}) {
  const dir = path.join(base, 'previews', name);
  fs.cpSync(from, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'release-candidate.json'), { force: true });
  const version = JSON.parse(read(path.join(dir, 'version.json')));
  fs.writeFileSync(path.join(dir, 'preview.json'), JSON.stringify({ name, url: previewOrigin(name) + '/', version: version.version, build: version.build, branch: 'v2.4', ...info }));
  if (edit) fs.writeFileSync(path.join(dir, 'index.html'), edit(read(path.join(dir, 'index.html'))));
  return dir;
}

// ---- names and host rules ------------------------------------------------------------------------
for (const name of ['v2-4-0', 'v2-4-0-logo', 'v2-4-0-maps2', 'v10-0-12-x', `v2-4-0-${'x'.repeat(21)}`]) assert.equal(previewNameProblem(name), null, name);
for (const name of ['', 'logo', 'title-themes', 'v2-4', 'v2-4-dash', 'V2-4-0', 'v2.4.0', 'v2-4-0-', 'v2-4-0-Logo', 'v2-4-0-2d', 'v2-4-0-big-maps', 'a/b', `v2-4-0-${'x'.repeat(22)}`, 'main', '0123abcd', null]) {
  assert.ok(previewNameProblem(name), `${JSON.stringify(name)} refused`);
}
assert.match(previewNameProblem('main'), /production branch of riftborn-dev \(dev\.riftborn\.us\)/);
assert.match(previewNameProblem('deadbeef'), /deployment id/);
assert.match(previewNameProblem('logo'), /e\.g\. v2-4-0 or v2-4-0-logo/);
// The version binding: a name holds only a build of its own version (v2-4-0 or v2-4-0-<tag> for 2.4.0).
assert.equal(previewNamePrefix('2.4.0'), 'v2-4-0');
assert.equal(previewNamePrefix('2.4'), null);
assert.equal(previewVersionProblem('v2-4-0', '2.4.0'), null);
assert.equal(previewVersionProblem('v2-4-0-logo', '2.4.0'), null);
assert.match(previewVersionProblem('v2-3-0-logo', '2.4.0'), /does not start with v2-4-0, the version of its build \(v2\.4\.0\)/);
assert.ok(previewVersionProblem('v2-4-10', '2.4.1') && previewVersionProblem('v2-4-1', '2.4.10'), 'v2-4-10 and v2-4-1 are different versions');
assert.match(previewVersionProblem('v2-4-0', undefined), /not MAJOR\.MINOR\.PATCH/);
// The shared list (tests/preview-names.json): the source repo's .tools/deploy-preview.test.mjs checks
// its own rules (.tools/deploy-preview.mjs) against the same file, so the two copies cannot drift apart.
{
  const names = JSON.parse(read('tests/preview-names.json'));
  assert.ok(names.accepted.length >= 5 && names.refused.length >= 5 && names.versions.length >= 3);
  for (const name of names.accepted) assert.equal(previewNameProblem(name), null, `${JSON.stringify(name)} is accepted (tests/preview-names.json)`);
  for (const name of names.refused) assert.ok(previewNameProblem(name), `${JSON.stringify(name)} is refused (tests/preview-names.json)`);
  for (const { version, accepted, refused } of names.versions) {
    for (const name of accepted) assert.equal(previewNameProblem(name) || previewVersionProblem(name, version), null, `${JSON.stringify(name)} holds v${version} (tests/preview-names.json)`);
    for (const name of refused) assert.ok(previewNameProblem(name) || previewVersionProblem(name, version), `${JSON.stringify(name)} cannot hold v${version} (tests/preview-names.json)`);
  }
}
assert.equal(previewOrigin('v2-4-0-logo'), 'https://v2-4-0-logo.riftborn-dev.pages.dev');
const devHtml = read('dev/index.html');
const API = 'https://api.riftborn.us';
// The committed dev/ and live/ builds, whatever their version: from 2.3.1 (RIFTBORN_SCORE_READ_BASE)
// dev.riftborn.us's root page reads the live boards; before it, it reads where it posts (nowhere).
const devReads = devHtml.includes('RIFTBORN_SCORE_READ_BASE');
assert.deepEqual(hostServices(devHtml, `${previewOrigin(B)}/`), OFF, 'A preview address gets nothing');
assert.deepEqual(hostServices(devHtml, 'https://dev.riftborn.us/'), { scores: '', reads: devReads ? API : '', feedback: API, accounts: API }, 'The HOST CONFIG runner is real (dev.riftborn.us gets feedback and accounts, never scores)');
assert.deepEqual(hostServices(read('live/index.html'), 'https://riftborn.us/'), { scores: API, reads: API, feedback: API, accounts: API }, 'riftborn.us reads where it posts');
// Builds before 2.3.1 set no RIFTBORN_SCORE_READ_BASE: they read where they post, and so does the
// check. The frozen 2.3.0 HOST CONFIG (tests/fixtures) keeps this covered after dev/ and live/ move on.
{
  const html = withHostConfig2_3_0(devHtml);
  assert.ok(!html.includes('RIFTBORN_SCORE_READ_BASE'), '2.3.0 predates the read base');
  assert.deepEqual(hostServices(html, 'https://dev.riftborn.us/'), { scores: '', reads: '', feedback: API, accounts: API }, '2.3.0: dev.riftborn.us reads nothing');
  assert.deepEqual(hostServices(html, 'https://riftborn.us/'), { scores: API, reads: API, feedback: API, accounts: API }, '2.3.0: riftborn.us reads where it posts');
  assert.deepEqual(hostServices(html, `${previewOrigin(B)}/`), OFF, '2.3.0: a preview address gets nothing');
}
// The 2.3.1 HOST CONFIG: dev.riftborn.us's root page reads the live boards (never posts); riftborn.us
// reads where it posts; a preview address still gets nothing. withReads() rebuilds it on the frozen
// 2.3.0 block, so it works on any page; the committed dev/ build is checked too once it has one.
const withReads = html => {
  let out = withHostConfig2_3_0(html);
  for (const [from, to] of [
    ['scores = "", feedback = ""', 'scores = "", reads = "", feedback = ""'],
    ['} else if (h === "dev.riftborn.us") {', '} else if (h === "dev.riftborn.us") {\n    if (p === "/" || p === "/index.html") reads = API;'],
    ['window.RIFTBORN_SCORE_API_BASE = window.RIFTBORN_SCORE_API_BASE || scores;', 'window.RIFTBORN_SCORE_API_BASE = window.RIFTBORN_SCORE_API_BASE || scores;\n  window.RIFTBORN_SCORE_READ_BASE = window.RIFTBORN_SCORE_READ_BASE || reads || window.RIFTBORN_SCORE_API_BASE;']
  ]) {
    assert.ok(out.includes(from), 'HOST CONFIG anchor: ' + from);
    out = out.replace(from, () => to);
  }
  return out;
};
for (const [label, html] of [['2.3.1', withReads(devHtml)], ...(devReads ? [[`dev/ ${devBuild.version}`, devHtml]] : [])]) {
  assert.deepEqual(hostServices(html, 'https://dev.riftborn.us/'), { scores: '', reads: API, feedback: API, accounts: API }, `${label}: dev.riftborn.us reads the live boards and posts nothing`);
  assert.deepEqual(hostServices(html, 'https://dev.riftborn.us/classic/'), { scores: '', reads: '', feedback: API, accounts: API }, `${label}: only the root page reads`);
  assert.deepEqual(hostServices(html, 'https://riftborn.us/'), { scores: API, reads: API, feedback: API, accounts: API }, `${label}: riftborn.us reads where it posts`);
  assert.deepEqual(hostServices(html, `${previewOrigin(B)}/`), OFF, `${label}: a preview address gets nothing`);
}
console.log('PASS preview names: v<major>-<minor>-<patch> of the build plus an optional tag, safe Cloudflare branch aliases only (never main = dev.riftborn.us, never a deployment id); preview addresses get no scores, leaderboard reads, feedback or accounts (reads default to the score base before 2.3.1).');

// ---- staging -------------------------------------------------------------------------------------
const base = path.join(tmp, 'repo');
const out = path.join(tmp, 'out');
preview(base, B);
preview(base, A, { info: { branch: 'title-themes' } });
fs.writeFileSync(path.join(base, 'previews', 'stray.txt'), 'not a preview folder');
// Production outputs already built next to it are left exactly as they are.
for (const dir of ['live', 'dev']) {
  fs.mkdirSync(path.join(out, '_cf', dir), { recursive: true });
  fs.writeFileSync(path.join(out, '_cf', dir, 'index.html'), `production ${dir}`);
}
const staged = stagePreviews({ base, out });
assert.equal(staged.project, 'riftborn-dev');
assert.deepEqual(staged.previews.map(p => [p.name, p.origin, p.version, p.build, p.dir]), [
  [A, `https://${A}.riftborn-dev.pages.dev`, devBuild.version, devBuild.build, `_cf/previews/${A}`],
  [B, `https://${B}.riftborn-dev.pages.dev`, devBuild.version, devBuild.build, `_cf/previews/${B}`]
]);
assert.ok(staged.previews.every(p => /^[0-9a-f]{64}$/.test(p.digest)));
assert.deepEqual(readStagedPreviews(out), staged, 'previews.json is what the deploy reads');
for (const dir of ['live', 'dev']) assert.equal(read(path.join(out, '_cf', dir, 'index.html')), `production ${dir}`, `_cf/${dir} untouched`);
assert.deepEqual(fs.readdirSync(path.join(out, '_cf')).sort(), ['dev', 'live', 'previews']);

const REQUIRED = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow'
};
for (const p of staged.previews) {
  const dir = path.join(out, p.dir);
  const files = walk(dir);
  for (const file of ['index.html', 'version.json', 'preview.json', '404.html', 'robots.txt', '_headers']) assert.ok(files.includes(file), `${p.name} serves ${file}`);
  assert.ok(!files.includes('release-candidate.json') && !files.includes('.nojekyll'));
  assert.equal(read(path.join(dir, 'robots.txt')), 'User-agent: *\nDisallow: /\n');
  assert.equal(JSON.parse(read(path.join(dir, 'preview.json'))).digest, p.digest, 'The digest is served with the preview');
  assert.equal(previewDigest(dir), p.digest, 'and covers every file but preview.json');
  const text = read(path.join(dir, '_headers'));
  const rules = parseHeaders(text);
  assert.ok(rules.length <= CF_MAX_RULES && text.split('\n').every(line => line.length <= CF_MAX_LINE));
  for (const file of files.filter(name => name.endsWith('.html'))) {
    const headers = matchHeaders(rules, htmlUrlPath(file));
    const csp = headers.get('content-security-policy');
    assert.ok(csp && !csp.joined, `${p.name} ${file}: one CSP`);
    assert.match(csp.value, /connect-src 'self' https:\/\/api\.riftborn\.us https:\/\/riftborn-leaderboard\.chanmanc10\.workers\.dev(;|$)/, 'The dev build\'s policy');
    const allowed = new Set(csp.value.split(';').map(part => part.trim()).find(part => part.startsWith('script-src ')).split(/\s+/).slice(1));
    assert.ok(!allowed.has("'unsafe-inline'"));
    for (const script of inlineScripts(read(path.join(dir, file)))) assert.ok(allowed.has(scriptHash(script)), `${p.name} ${file}: inline script hashed`);
    for (const [name, value] of Object.entries(REQUIRED)) assert.equal(headers.get(name)?.value, value, `${p.name} ${file}: ${name}`);
    if (file !== '404.html') assert.equal(headers.get('cache-control')?.value, 'no-cache');
  }
  assert.equal(matchHeaders(rules, '/version.json').get('cache-control')?.value, 'no-store');
  for (const file of files.filter(name => /\.[0-9a-f]{8,}\.(js|css)$/.test(name))) assert.equal(matchHeaders(rules, '/' + file).get('cache-control')?.value, 'public, max-age=31536000, immutable');
}
// The same folder stages to the same digest; any change to it gives another.
const again = stagePreviews({ base, out });
assert.deepEqual(again.previews.map(p => p.digest), staged.previews.map(p => p.digest), 'Restaging the same build keeps its digest');
fs.appendFileSync(path.join(base, 'previews', B, 'version.json'), '\n');
assert.notEqual(stagePreviews({ base, out }).previews.find(p => p.name === B).digest, staged.previews.find(p => p.name === B).digest);
// No previews at all: an empty list (the deploy then removes whatever preview links are left).
assert.deepEqual(stagePreviews({ base: path.join(tmp, 'empty'), out: path.join(tmp, 'empty-out') }).previews, []);
console.log('PASS staging: each preview gets the dev build\'s headers (every inline script hashed, noindex, HSTS, cache rules), 404.html and robots.txt; a content digest; production outputs untouched.');

// ---- refused previews ----------------------------------------------------------------------------
const refused = (name, options, pattern) => {
  const bad = path.join(tmp, 'bad-' + Math.random().toString(16).slice(2));
  const badOut = path.join(tmp, 'bad-out');
  preview(bad, name, options);
  assert.throws(() => stagePreviews({ base: bad, out: badOut }), pattern, `${name}: ${pattern}`);
};
refused('main', {}, /production branch/);
refused('Bad_Name', {}, /preview name "Bad_Name"/);
refused('deadbeef', {}, /deployment id/);
refused('title-themes', {}, /preview name "title-themes": use v<major>-<minor>-<patch> of the build/);
// A name for another version than the build in the folder: the link would show the wrong version.
refused('v9-9-9-logo', {}, new RegExp(`previews/v9-9-9-logo: preview name "v9-9-9-logo" does not start with ${V}, the version of its build \\(v${dots(devBuild.version)}\\): restage it`));
refused(`${V}9`, {}, new RegExp(`does not start with ${V},`));
refused(`${V}-ungated`, { from: 'live' }, /no password gate[\s\S]*loads the game before the password gate opens[\s\S]*not noindex/);
refused(`${V}-scoring`, { edit: html => html.replace('} else if (h === "dev.riftborn.us") {', '} else if (/\\.pages\\.dev$/.test(h)) {\n    scores = API;\n  } else if (h === "dev.riftborn.us") {') }, new RegExp(`HOST CONFIG gives https://${V}-scoring\\.riftborn-dev\\.pages\\.dev scores`));
// 2.3.1: a preview that would read the live boards is refused as well (reported as reads).
refused(`${V}-reading`, { edit: html => withReads(html).replace('} else if (h === "dev.riftborn.us") {', '} else if (/\\.pages\\.dev$/.test(h)) {\n    reads = API;\n  } else if (h === "dev.riftborn.us") {') }, new RegExp(`HOST CONFIG gives https://${V}-reading\\.riftborn-dev\\.pages\\.dev reads \\(https://api\\.riftborn\\.us\\); a preview never posts or reads scores`));
{
  // ...while a 2.3.1 build that reads only on dev.riftborn.us stages as before.
  const ok = path.join(tmp, 'ok-reads');
  assert.deepEqual(previewProblems(preview(ok, `${V}-reads`, { edit: withReads }), `${V}-reads`), [], 'A 2.3.1 HOST CONFIG passes the preview check');
}
refused(`${V}-eager`, { edit: html => html.replace('</body>', '<script src="js/riftborn.0123456789.js" type="module"></script></body>') }, /loads the game before the password gate opens/);
refused(`${V}-nohostconfig`, { edit: html => html.replace('HOST CONFIG', 'HOST SETTINGS') }, /HOST CONFIG: expected one HOST CONFIG block, found 0/);
refused(`${V}-renamed`, { info: { name: 'other' } }, /preview\.json is for "other"/);
refused(`${V}-oldbuild`, { info: { build: 'f00' } }, /preview\.json build "f00" is not version\.json's/);
refused(`${V}-otherversion`, { info: { version: '9.9.9' } }, new RegExp(`preview\\.json version "9\\.9\\.9" is not version\\.json's "${dots(devBuild.version)}"`));
{
  const bad = path.join(tmp, 'bad-no-info');
  fs.rmSync(path.join(preview(bad, `${V}-noinfo`), 'preview.json'));
  assert.throws(() => stagePreviews({ base: bad, out: path.join(tmp, 'bad-out') }), /no preview\.json/);
}
{
  const bad = path.join(tmp, 'bad-no-version');
  const dir = preview(bad, `${V}-noversion`);
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ build: devBuild.build }));
  assert.throws(() => stagePreviews({ base: bad, out: path.join(tmp, 'bad-out') }), /version\.json has no version \(MAJOR\.MINOR\.PATCH\)/);
}
// The deploy reads previews.json again: a name that does not carry its version is refused there too.
{
  const forged = path.join(tmp, 'forged');
  fs.mkdirSync(path.join(forged, '_cf', 'previews'), { recursive: true });
  const write = previews => fs.writeFileSync(path.join(forged, '_cf', 'previews', 'previews.json'), JSON.stringify({ project: 'riftborn-dev', previews }));
  write([{ name: 'v9-9-9', version: devBuild.version, build: devBuild.build, digest: 'x' }]);
  assert.throws(() => readStagedPreviews(forged), new RegExp(`"v9-9-9" does not start with ${V}`));
  write([{ name: A, build: devBuild.build, digest: 'x' }]);
  assert.throws(() => readStagedPreviews(forged), /version null is not MAJOR\.MINOR\.PATCH/);
  write([{ name: B, version: devBuild.version, build: devBuild.build, digest: 'x' }]);
  assert.equal(readStagedPreviews(forged).previews[0].name, B);
}
console.log('PASS refused previews: main, bad or old-style names, a name for another version than its build, deployment-id lookalikes, ungated or indexable builds, a HOST CONFIG that would score or read the leaderboards (or is missing), and a preview.json for another build or version all stop the deploy.');

// ---- the deploy ----------------------------------------------------------------------------------
{
  const [first] = staged.previews;
  const plan = previewDeployPlan(staged.previews, { sha: 'abc1234' });
  assert.deepEqual(plan.map(step => step.name), [A, B]);
  assert.deepEqual(plan[0].deploy, [
    'pages', 'deploy', `_cf/previews/${A}`, '--project-name', 'riftborn-dev', '--branch', A,
    '--commit-hash', 'abc1234', '--commit-message', `Preview ${A}: v${devBuild.version} build ${devBuild.build} ${DIGEST_TAG}${first.digest.slice(0, 16)}`, '--commit-dirty=true'
  ]);
  assert.ok(plan.every(step => !step.deploy.includes('riftborn') && step.deploy[step.deploy.indexOf('--branch') + 1] !== 'main'), 'Never the live project, never the production branch');
  assert.throws(() => previewDeployPlan([{ name: 'main', build: 'x', digest: 'y' }]), /production branch/);
  assert.throws(() => previewDeployPlan([{ name: '../x', build: 'x', digest: 'y' }]), /preview name/);
  assert.deepEqual(deployPlan().map(step => step.dir), ['_cf/live', '_cf/dev'], 'The production plan has no previews');
  assert.deepEqual(deployPlan({ site: 'feedback' }).map(step => step.dir), ['_cf/feedback'], 'Nor does the inbox plan');
  assert.ok(previewCommitMessage(first).length <= 100);

  // Already served as staged -> skipped; anything else -> deployed.
  const dep = (id, branch, created, status = 'success', message = `Preview ${branch}: build x`, environment = 'preview') => ({
    id, environment, created_on: created, latest_stage: { name: 'deploy', status }, deployment_trigger: { metadata: { branch, commit_message: message } }
  });
  const tag = `${DIGEST_TAG}${first.digest.slice(0, 16)}`;
  assert.equal(isUnchanged([dep('a', A, '2026-10-01T10:00:00Z', 'success', `Preview x ${tag}`)], first), true);
  assert.equal(isUnchanged([dep('a', A, '2026-10-01T10:00:00Z', 'success', `Preview x ${DIGEST_TAG}0000000000000000`)], first), false, 'Another build');
  assert.equal(isUnchanged([dep('b', A, '2026-10-01T11:00:00Z', 'failure', `Preview x ${tag}`), dep('a', A, '2026-10-01T10:00:00Z', 'success', `Preview x ${tag}`)], first), false, 'The newest attempt failed');
  assert.equal(isUnchanged([dep('a', B, '2026-10-01T10:00:00Z', 'success', `Preview x ${tag}`)], first), false, 'Another preview');
  assert.equal(isUnchanged([], first), false);

  // Stale previews go (alias and all; "old-one" is also how a link from before the version names
  // goes away); a current preview keeps its newest successful build and anything newer; production
  // deployments are never considered.
  const deployments = [
    dep('p1', 'main', '2026-10-01T12:00:00Z', 'success', '', 'production'),
    dep('p0', 'main', '2026-09-01T12:00:00Z', 'success', '', 'production'),
    dep('s1', 'old-one', '2026-09-30T10:00:00Z'),
    dep('s2', 'old-one', '2026-09-29T10:00:00Z', 'failure'),
    dep('v3', B, '2026-10-01T13:00:00Z', 'failure'),
    dep('v2', B, '2026-10-01T12:00:00Z'),
    dep('v1', B, '2026-09-30T12:00:00Z'),
    dep('v0', B, '2026-09-29T12:00:00Z', 'failure'),
    dep('t1', A, '2026-10-01T09:00:00Z', 'active'),
    dep('m1', 'main', '2026-09-01T00:00:00Z'),
    dep('h1', 'hand-made', '2026-09-01T00:00:00Z', 'success', 'wrangler pages deploy by hand')
  ];
  assert.deepEqual(cleanupPlan(deployments, [B, A]), [
    { id: 's1', branch: 'old-one', force: true, why: 'preview removed' },
    { id: 's2', branch: 'old-one', force: true, why: 'preview removed' },
    { id: 'v1', branch: B, force: false, why: 'older build' },
    { id: 'v0', branch: B, force: false, why: 'older build' }
  ]);
  assert.deepEqual(cleanupPlan(deployments, []).map(item => item.id), ['s1', 's2', 't1', 'v3', 'v2', 'v1', 'v0'], 'With no previews left every preview deployment this tool made goes; production and hand-made ones never');
  assert.ok(cleanupPlan(deployments, []).every(item => item.force));

  // The Cloudflare API: every page of riftborn-dev's preview deployments, the token only in the
  // Authorization header, never in an error.
  const TOKEN = 'tok_0123456789abcdef', ACCOUNT = '0123456789abcdef0123456789abcdef';
  const calls = [];
  const pages = { 1: [dep('a', 'x', '1')], 2: [dep('b', 'y', '2')] };
  const paging = async (url, options) => {
    calls.push([url, options]);
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify({ success: true, result: pages[page] || [], result_info: { page, total_pages: 2 } }), { status: 200 });
  };
  const listed = await listPreviewDeployments({ token: TOKEN, accountId: ACCOUNT, fetchImpl: paging });
  assert.deepEqual(listed.map(d => d.id), ['a', 'b']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects/riftborn-dev/deployments?env=preview&page=1&per_page=25`);
  assert.deepEqual([calls[0][1].method, calls[0][1].headers], ['GET', { Authorization: `Bearer ${TOKEN}` }]);
  const short = async () => new Response(JSON.stringify({ success: true, result: [dep('a', 'x', '1')] }), { status: 200 });
  assert.equal((await listPreviewDeployments({ token: TOKEN, accountId: ACCOUNT, fetchImpl: short })).length, 1, 'No result_info: a short page is the last');
  await assert.rejects(listPreviewDeployments({ token: TOKEN, accountId: ACCOUNT, project: 'riftborn', fetchImpl: paging }), /only in riftborn-dev, never riftborn/);
  calls.length = 0;
  await deleteDeployment({ token: TOKEN, accountId: ACCOUNT, id: '0a1b2c3d-0000-4000-8000-000000000000', force: true, fetchImpl: paging });
  assert.equal(calls[0][0], `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects/riftborn-dev/deployments/0a1b2c3d-0000-4000-8000-000000000000?force=true`);
  assert.equal(calls[0][1].method, 'DELETE');
  await assert.rejects(deleteDeployment({ token: TOKEN, accountId: ACCOUNT, id: '../../projects', fetchImpl: paging }), /Not a deployment id/);
  await assert.rejects(deleteDeployment({ token: TOKEN, accountId: ACCOUNT, project: 'riftborn', id: 'abcdef12', fetchImpl: paging }), /never riftborn/);
  const denied = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `Authentication error for ${ACCOUNT}` }] }), { status: 403 });
  const error = await cloudflareApi({ token: TOKEN, accountId: ACCOUNT, route: '/pages/projects/riftborn-dev/deployments', fetchImpl: denied }).catch(e => e);
  assert.match(error.message, /^Cloudflare API GET \/accounts\/\*\*\*\/pages\/projects\/riftborn-dev\/deployments: HTTP 403 \(10000: Authentication error for \*\*\*\)$/);
  const offline = async () => { throw new TypeError(`fetch failed for ${TOKEN}`); };
  const down = await cloudflareApi({ token: TOKEN, accountId: ACCOUNT, route: '/x', fetchImpl: offline }).catch(e => e);
  assert.ok(!down.message.includes(TOKEN) && !down.message.includes(ACCOUNT) && /fetch failed/.test(down.message), 'Secrets scrubbed');

  // After the deploy: each link answers with the gate and the staged build (retried while it propagates).
  const site = (overrides = {}) => Object.fromEntries(staged.previews.flatMap(p => [
    [`${p.origin}/`, [200, '<div id="devGate"></div>']], [`${p.origin}/version.json`, [200, JSON.stringify({ build: p.build })]]
  ]).concat(Object.entries(overrides)));
  const fakeFetch = routes => async url => {
    const route = routes[url.replace(/[?&]t=\d+$/, '')];
    if (!route) throw new TypeError('fetch failed');
    return new Response(route[1], { status: route[0] });
  };
  assert.deepEqual(await checkPreviewsOnce({ previews: staged.previews, fetchImpl: fakeFetch(site()) }), []);
  const origin = staged.previews[1].origin;
  assert.match((await checkPreviewsOnce({ previews: staged.previews, fetchImpl: fakeFetch(site({ [`${origin}/version.json`]: [200, '{"build":"old"}'] })) })).join(), /serves build "old"/);
  assert.match((await checkPreviewsOnce({ previews: staged.previews, fetchImpl: fakeFetch(site({ [`${origin}/`]: [200, '<p>game</p>'] })) })).join(), /no password gate/);
  assert.match((await checkPreviewsOnce({ previews: staged.previews, fetchImpl: fakeFetch(site({ [`${origin}/`]: [404, ''] })) })).join(), /HTTP 404/);
  let attempts = 0;
  const late = async (url, options) => (++attempts <= 2 ? new Response('', { status: 404 }) : fakeFetch(site())(url, options));
  const result = await verifyDeployment({ previews: staged.previews, check: checkPreviewsOnce, fetchImpl: late, delayMs: 0, attempts: 3 });
  assert.deepEqual([result.ok, result.attempts], [true, 2]);
}
// The whole --previews run, with Wrangler and the Cloudflare API faked: an unchanged preview is
// skipped, a changed one deployed to its branch, a removed one deleted with its alias, the older build
// of a redeployed preview pruned, and production left alone.
{
  const { WRANGLER_VERSION, deployPreviews } = await import('../scripts/cloudflare-pages-deploy.mjs');
  const current = readStagedPreviews(out);
  const themes = current.previews.find(p => p.name === A);
  const env = { CI: 'true', GITHUB_REF: 'refs/heads/main', CLOUDFLARE_API_TOKEN: 'tok_0123456789abcdef', CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', COMMIT_SHA: 'abc1234' };
  const world = () => {
    let clock = 100;
    const state = {
      deployments: [
        { id: 'aaaa0001', environment: 'production', created_on: '2026-10-01T00:00:00Z', latest_stage: { status: 'success' }, deployment_trigger: { metadata: { branch: 'main', commit_message: 'Dev' } } },
        { id: 'aaaa0002', environment: 'preview', created_on: '2026-10-01T00:00:01Z', latest_stage: { status: 'success' }, deployment_trigger: { metadata: { branch: A, commit_message: previewCommitMessage(themes) } } },
        { id: 'aaaa0003', environment: 'preview', created_on: '2026-10-01T00:00:02Z', latest_stage: { status: 'success' }, deployment_trigger: { metadata: { branch: B, commit_message: `Preview ${B}: build old ${DIGEST_TAG}0000000000000000` } } },
        { id: 'aaaa0004', environment: 'preview', created_on: '2026-10-01T00:00:03Z', latest_stage: { status: 'success' }, deployment_trigger: { metadata: { branch: 'old-one', commit_message: 'Preview old-one: build x' } } }
      ],
      wrangler: [],
      deleted: [],
      failDelete: null
    };
    state.run = args => {
      state.wrangler.push(args.join(' '));
      if (args[1] === 'project') return { ok: false, output: 'A project with this name already exists. [code: 8000002]' };
      const branch = args[args.indexOf('--branch') + 1];
      state.deployments.push({ id: `bbbb${clock++}`, environment: 'preview', created_on: `2026-10-02T00:00:${clock}Z`, latest_stage: { status: 'success' }, deployment_trigger: { metadata: { branch, commit_message: args[args.indexOf('--commit-message') + 1] } } });
      return { ok: true, output: `Deployment alias URL: https://${branch}.riftborn-dev.pages.dev` };
    };
    state.fetchImpl = async (url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
      const u = new URL(url);
      if (options.method === 'DELETE') {
        const id = u.pathname.split('/').pop();
        if (state.failDelete === id) return new Response(JSON.stringify({ success: false, errors: [{ code: 8000000, message: 'nope' }] }), { status: 500 });
        state.deleted.push([id, u.searchParams.get('force') === 'true']);
        state.deployments = state.deployments.filter(d => d.id !== id);
        return new Response(JSON.stringify({ success: true, result: null }), { status: 200 });
      }
      const result = state.deployments.filter(d => d.environment === u.searchParams.get('env'));
      return new Response(JSON.stringify({ success: true, result, result_info: { page: 1, total_pages: 1 } }), { status: 200 });
    };
    return state;
  };
  const quiet = () => {};
  // The link checks of removed previews (plain GETs, never the token): gone at once; no git history; no waiting.
  const links = { aliasFetch: async () => new Response('', { status: 404 }), removedNames: () => ({ names: [], shallow: false }), sleep: async () => {} };
  const summaryFile = path.join(tmp, 'summary.md');
  const one = world();
  const result = await deployPreviews({ base: out, env: { ...env, GITHUB_STEP_SUMMARY: summaryFile }, run: one.run, fetchImpl: one.fetchImpl, installed: () => WRANGLER_VERSION, log: quiet, warn: quiet, ...links });
  assert.deepEqual({ rows: result.rows, removed: result.removed, tombstoned: result.tombstoned }, { rows: [[A, 'unchanged'], [B, 'deployed']], removed: ['old-one'], tombstoned: [] });
  assert.deepEqual(result.aliases, { 'old-one': 'removed' }, 'The removed preview link was checked and is gone');
  assert.equal(one.wrangler.length, 2, 'Project create (already there) and one deploy');
  assert.match(one.wrangler[1], new RegExp(`^pages deploy _cf/previews/${B} --project-name riftborn-dev --branch ${B} --commit-hash abc1234 --commit-message Preview ${B}: v${dots(devBuild.version)} `));
  assert.deepEqual(one.deleted, [['aaaa0004', true], ['aaaa0003', false]], `The removed preview (alias and all), then the replaced build of ${B}`);
  assert.deepEqual(one.deployments.map(d => [d.environment, d.deployment_trigger.metadata.branch]), [['production', 'main'], ['preview', A], ['preview', B]], 'Production untouched; one deployment per preview');
  assert.match(read(summaryFile), new RegExp(`\\| ${B} \\| v${dots(devBuild.version)} \\w+ \\| https://${B}\\.riftborn-dev\\.pages\\.dev/ \\| deployed \\|[\\s\\S]*Removed: old-one`));
  // Run again: nothing changed, nothing deployed, nothing deleted.
  const again = await deployPreviews({ base: out, env, run: one.run, fetchImpl: one.fetchImpl, installed: () => WRANGLER_VERSION, log: quiet, warn: quiet, ...links });
  assert.deepEqual(again, { rows: [[A, 'unchanged'], [B, 'unchanged']], removed: [], tombstoned: [], aliases: {} });
  assert.equal(one.wrangler.length, 3, 'Only the project check ran');
  // PREVIEW_REDEPLOY=1 (the manual run's "redeploy" box) deploys every preview.
  const two = world();
  assert.deepEqual((await deployPreviews({ base: out, env: { ...env, PREVIEW_REDEPLOY: '1' }, run: two.run, fetchImpl: two.fetchImpl, installed: () => WRANGLER_VERSION, log: quiet, warn: quiet, ...links })).rows,
    [[A, 'deployed'], [B, 'deployed']]);
  // A preview that cannot be removed fails the run (after the deploys); other refusals stop it first.
  const three = world();
  three.failDelete = 'aaaa0004';
  await assert.rejects(deployPreviews({ base: out, env, run: three.run, fetchImpl: three.fetchImpl, installed: () => WRANGLER_VERSION, log: quiet, warn: quiet, ...links }), /Could not remove these previews[\s\S]*old-one: Cloudflare API DELETE \/accounts\/\*\*\*\/pages\/projects\/riftborn-dev\/deployments\/aaaa0004: HTTP 500/);
  await assert.rejects(deployPreviews({ base: out, env: { ...env, GITHUB_REF: 'refs/heads/v2.4' }, run: three.run, fetchImpl: three.fetchImpl, installed: () => WRANGLER_VERSION, log: quiet }), /Refusing to deploy refs\/heads\/v2\.4/);
  await assert.rejects(deployPreviews({ base: out, env, run: three.run, fetchImpl: three.fetchImpl, installed: () => null, log: quiet }), /Wrangler [\d.]+ is not installed/);
  await assert.rejects(deployPreviews({ base: path.join(tmp, 'nothing'), env, log: quiet }), /previews\.json is missing/);
  const lines = [];
  await deployPreviews({ base: out, env: {}, dryRun: true, log: line => lines.push(line), removedNames: () => ({ names: [], shallow: false }) });
  assert.match(lines.join('\n'), new RegExp(`pages deploy _cf/previews/${A} --project-name riftborn-dev --branch ${A} [\\s\\S]*then delete the preview deployments made here in riftborn-dev for any branch but: ${A}, ${B}`));
}
console.log('PASS preview deploy: one riftborn-dev branch deployment per preview (never riftborn, never main), unchanged previews skipped, stale previews and older builds deleted (production never), paged API calls with the token kept out of errors, links checked after the deploy.');

// ---- workflows -------------------------------------------------------------------------------------
{
  const workflow = read('.github/workflows/previews.yml').replace(/\r\n/g, '\n');
  assert.match(workflow, /\non:\n  push:\n    branches: \[main\]\n    paths:\n      - 'previews\/\*\*'\n/, 'Previews deploy on a push to main that changes previews/');
  // ...and on a change to any repository file the preview scripts import (followed to the end).
  const paths = [...workflow.match(/\n    paths:\n((?: {6}(?:- .*|#.*)\n)+)/)[1].matchAll(/- '([^']+)'/g)].map(match => match[1]);
  const imported = new Set();
  const follow = file => {
    if (imported.has(file)) return;
    imported.add(file);
    for (const [, spec] of read(file).matchAll(/^(?:import|export)\b[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      follow(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
    }
  };
  for (const script of ['scripts/pages-previews.mjs', 'scripts/cloudflare-pages-deploy.mjs', 'scripts/cloudflare-pages-verify.mjs']) follow(script);
  assert.ok(['site.config.mjs', 'site.hosts.mjs', 'scripts/pages-headers.mjs', 'scripts/pages-templates.mjs'].every(file => imported.has(file)), [...imported].join(', '));
  for (const file of imported) assert.ok(paths.includes(file), `previews.yml redeploys the previews when ${file} changes`);
  assert.match(workflow, /\n    if: vars\.CF_PAGES_ENABLED == '1' && github\.ref == 'refs\/heads\/main'\n/, 'Only on main, only while Cloudflare Pages is on');
  assert.ok(workflow.includes('    environment: cloudflare-production\n'), 'The same environment (and token) as the production deploy');
  // The cleanup re-checks the links of previews removed by earlier pushes: the whole history (trees
  // only, no file contents) is checked out.
  const checkout = workflow.match(/\n      - uses: actions\/checkout@v4\n        with:\n((?: {10}.*\n)+)/)?.[1] || '';
  assert.ok(checkout.includes('          fetch-depth: 0\n') && checkout.includes('          filter: blob:none\n') && checkout.includes('          persist-credentials: false\n'), checkout);
  const steps = ['run: npm ci --prefix tools/wrangler --ignore-scripts', 'run: node scripts/pages-previews.mjs', 'run: node scripts/cloudflare-pages-deploy.mjs --previews', 'run: node scripts/cloudflare-pages-verify.mjs --previews'].map(step => workflow.indexOf(step));
  assert.ok(steps.every((at, i) => at !== -1 && (i === 0 || steps[i - 1] < at)), 'Install the pinned Wrangler, stage, deploy, check');
  assert.ok(workflow.includes('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}') && workflow.includes('CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}'));
  assert.ok(!/cancel-in-progress: true/.test(workflow), 'A deploy is never cut off halfway');
  const pages = read('.github/workflows/pages.yml').replace(/\r\n/g, '\n');
  assert.match(pages, /\non:\n  push:\n    branches: \[main\]\n(    #.*\n)*    paths-ignore:\n      - 'previews\/\*\*'\n/, 'A push that only changes previews/ never redeploys production');
  assert.ok(!read('scripts/build-pages.mjs').includes('previews'), 'The production build never reads previews/');
}
console.log('PASS preview workflow: main only, same environment and pinned Wrangler as production, stage -> deploy -> check; pages.yml ignores preview-only pushes.');

fs.rmSync(tmp, { recursive: true, force: true });

// The cleanup (link checks, tombstones, annotations) has its own file, run with these tests (npm test
// runs this file; package.json is left alone because cloudflare-worker.yml redeploys the Worker on
// any change to it).
await import('./preview-cleanup.mjs');
