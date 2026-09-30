// The Cloudflare Pages outputs (_cf/live, _cf/dev), before and after launch: every inline script of
// every page is allowed by the CSP that Cloudflare would attach to that page (matched with
// Cloudflare's own _headers rules), the security and cache headers are there, and the pre-launch /
// launched layouts hold exactly what the plan says. Builds into a temporary folder; local only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CF_MAX_LINE, CF_MAX_RULES, htmlUrlPath, inlineScripts, matchHeaders, parseHeaders, parseRedirects, matchRedirect, scriptHash } from '../scripts/pages-headers.mjs';
import { HOSTS, LAUNCHED, ciLaunchRefusals, resolveSiteConfig } from '../site.config.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riftborn-pages-'));
// The test-only overrides are refused in CI; these builds go to a temporary folder, so drop the
// CI markers for the child only.
const { CI, GITHUB_ACTIONS, ...baseEnv } = process.env;
function build(name, extra = {}) {
  const out = path.join(tmp, name);
  const result = spawnSync(process.execPath, ['scripts/build-pages.mjs'], {
    env: { ...baseEnv, RIFTBORN_PAGES_OUT: out, RIFTBORN_SCORE_API_BASE: HOSTS.workersDev, ...extra }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, `build ${name} failed:\n${result.stdout}\n${result.stderr}`);
  return out;
}
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(file, base) : [path.relative(base, file).split(path.sep).join('/')];
}).sort();

const REQUIRED = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin'
};

/** Problems with one Cloudflare output: [] when every inline script is covered. */
function auditOutput(dir, { noindex = false } = {}) {
  const problems = [];
  const text = fs.readFileSync(path.join(dir, '_headers'), 'utf8');
  const rules = parseHeaders(text);
  if (rules.length > CF_MAX_RULES) problems.push(`${rules.length} rules`);
  for (const line of text.split('\n')) if (line.length > CF_MAX_LINE) problems.push(`line of ${line.length} characters`);
  const files = walk(dir);
  for (const file of files.filter(name => name.endsWith('.html'))) {
    const urlPath = htmlUrlPath(file);
    const headers = matchHeaders(rules, urlPath);
    const csp = headers.get('content-security-policy');
    if (!csp) { problems.push(`${urlPath}: no CSP`); continue; }
    if (csp.joined) problems.push(`${urlPath}: CSP set by two rules (Cloudflare would join them)`);
    const scriptSrc = csp.value.split(';').map(part => part.trim()).find(part => part.startsWith('script-src ')) || '';
    const allowed = new Set(scriptSrc.split(/\s+/).slice(1));
    if (allowed.has("'unsafe-inline'") || allowed.has("'unsafe-eval'")) problems.push(`${urlPath}: script-src is not strict`);
    for (const script of inlineScripts(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      if (!allowed.has(scriptHash(script))) problems.push(`${urlPath}: inline script not in the CSP: ${script.slice(0, 60).replace(/\s+/g, ' ')}`);
    }
    for (const [name, value] of Object.entries(REQUIRED)) if (headers.get(name)?.value !== value) problems.push(`${urlPath}: ${name} missing`);
    if (!/camera=\(\)/.test(headers.get('permissions-policy')?.value || '')) problems.push(`${urlPath}: Permissions-Policy missing`);
    if (noindex !== /noindex/.test(headers.get('x-robots-tag')?.value || '')) problems.push(`${urlPath}: X-Robots-Tag ${noindex ? 'missing' : 'unexpected'}`);
    if (file !== '404.html' && headers.get('cache-control')?.value !== 'no-cache') problems.push(`${urlPath}: HTML must be no-cache`);
  }
  for (const file of files.filter(name => /\.[0-9a-f]{8,}\.(js|css)$/.test(name))) {
    if (matchHeaders(rules, '/' + file).get('cache-control')?.value !== 'public, max-age=31536000, immutable') problems.push(`/${file}: hashed bundle not immutable`);
  }
  for (const file of files.filter(name => name.endsWith('version.json'))) {
    if (matchHeaders(rules, '/' + file).get('cache-control')?.value !== 'no-store') problems.push(`/${file}: version.json must be no-store`);
  }
  return problems;
}

const cspOf = dir => matchHeaders(parseHeaders(fs.readFileSync(path.join(dir, '_headers'), 'utf8')), '/').get('content-security-policy').value;

// ---- the committed switch --------------------------------------------------------------------
assert.equal(LAUNCHED, false, 'LAUNCHED stays false until the launch commit');
assert.throws(() => resolveSiteConfig({ CI: 'true', RIFTBORN_FORCE_LAUNCHED: '1' }), /not allowed in CI/, 'Overrides are refused in CI');
assert.throws(() => resolveSiteConfig({ RIFTBORN_TEST_LIVE_ORIGIN: 'http://localhost:1/x' }), /exact/);
assert.equal(resolveSiteConfig({}).launched, false);
assert.equal(resolveSiteConfig({ RIFTBORN_FORCE_LAUNCHED: '1' }).launchedForReal, false, 'A forced local build is not a real launch');
console.log('PASS site config: LAUNCHED is a committed false, test overrides refused in CI.');

// ---- before launch -------------------------------------------------------------------------------
const pre = build('pre');
{
  const live = path.join(pre, '_cf', 'live');
  assert.deepEqual(walk(live), ['404.html', '_headers', 'assets/crypt-pixel.ttf', 'index.html', 'privacy/index.html'],
    'Pre-launch riftborn.us holds only the privacy page and the pages that send visitors to github.io');
  const root = fs.readFileSync(path.join(live, 'index.html'), 'utf8');
  assert.match(root, /"https:\/\/chancrisp\.github\.io\/riftborn\/"/, 'The root page sends visitors to the github.io game');
  assert.match(root, /location\.replace\(dest\)/);
  assert.match(root, /rb_migrate=/, 'and never bounces a hand-off back (no loop if github.io launches first)');
  assert.deepEqual(auditOutput(live), []);
  const privacy = fs.readFileSync(path.join(live, 'privacy', 'index.html'), 'utf8');
  assert.match(privacy, /<link rel="canonical" href="https:\/\/riftborn\.us\/privacy\/">/);
  // _site is today's github.io game.
  const site = path.join(pre, '_site');
  for (const file of ['index.html', 'classic/index.html', 'dev/index.html', 'feedback/index.html', 'privacy/index.html', '.nojekyll']) assert.ok(fs.existsSync(path.join(site, file)), '_site keeps ' + file);
  assert.match(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), /window\.RIFTBORN_SCORE_API_BASE="https:\/\/riftborn-leaderboard\.chanmanc10\.workers\.dev"/);
  assert.ok(!fs.existsSync(path.join(site, '404.html')), 'No catch-all before launch');
  // dev.riftborn.us: the gated test build, noindex.
  const dev = path.join(pre, '_cf', 'dev');
  const devHtml = fs.readFileSync(path.join(dev, 'index.html'), 'utf8');
  assert.match(devHtml, /id="devGate"/, 'The password gate from .tools/deploy-dev.mjs is in place');
  assert.deepEqual(auditOutput(dev, { noindex: true }), []);
  assert.equal(fs.readFileSync(path.join(dev, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n');
  // The gate's own script is hashed into the policy (the dev gate is injected before headers are made).
  const gate = inlineScripts(devHtml).find(script => script.includes('riftborn-dev-gate'));
  assert.ok(gate && cspOf(dev).includes(scriptHash(gate)));
}
console.log('PASS pre-launch: riftborn.us = privacy + send-to-github.io page, github.io unchanged, dev.riftborn.us gated; every inline script hashed.');

// ---- after launch --------------------------------------------------------------------------------
const post = build('post', { RIFTBORN_FORCE_LAUNCHED: '1' });
{
  const live = path.join(post, '_cf', 'live');
  const files = walk(live);
  for (const file of ['index.html', 'version.json', 'classic/index.html', 'privacy/index.html', '404.html', '_headers', '_redirects']) assert.ok(files.includes(file), 'riftborn.us serves ' + file);
  assert.ok(files.some(file => /^js\/riftborn\.[0-9a-f]+\.js$/.test(file)), 'with the game bundle');
  assert.deepEqual(auditOutput(live), []);
  const csp = cspOf(live);
  assert.match(csp, /(^|; )default-src 'self'(;|$)/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.riftborn\.us https:\/\/riftborn-leaderboard\.chanmanc10\.workers\.dev(;|$)/);
  for (const part of ["object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "img-src 'self' data: blob:", "font-src 'self'", "worker-src 'self' blob:"]) assert.ok(csp.includes(part), part);
  // The classic edition's import map and edits are inline scripts too: all hashed.
  const classic = fs.readFileSync(path.join(live, 'classic', 'index.html'), 'utf8');
  assert.ok(inlineScripts(classic).some(script => script.includes('"imports"')), 'classic import map found');
  assert.match(classic, /Classic edition: no leaderboard/);
  assert.ok(!fs.readFileSync(path.join(live, 'index.html'), 'utf8').includes('window.RIFTBORN_SCORE_API_BASE="'), 'No build-time score base on riftborn.us: the game picks its host config');
  const redirects = parseRedirects(fs.readFileSync(path.join(live, '_redirects'), 'utf8'));
  assert.deepEqual(matchRedirect(redirects, '/riftborn/classic/'), { location: '/classic/', status: 301 });
  assert.deepEqual(matchRedirect(redirects, '/riftborn/'), { location: '/', status: 301 });
  assert.equal(matchRedirect(redirects, '/'), null);
  // github.io: handoff pages only, and the feedback inbox.
  const site = path.join(post, '_site');
  assert.deepEqual(walk(site).filter(file => !file.startsWith('feedback/')), ['.nojekyll', '404.html', 'classic/index.html', 'dev/index.html', 'index.html', 'privacy/index.html']);
  assert.ok(fs.existsSync(path.join(site, 'feedback', 'inbox.js')), 'The feedback inbox stays on github.io');
  // A tampered page is caught (the audit is not vacuous).
  const tampered = path.join(tmp, 'tampered');
  fs.cpSync(live, tampered, { recursive: true });
  fs.appendFileSync(path.join(tampered, 'classic', 'index.html'), '<script>alert(1)</script>');
  const problems = auditOutput(tampered);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^\/classic\/: inline script not in the CSP: alert\(1\)/);
  // CRLF checkouts hash like the browser does (the HTML parser turns CRLF into LF).
  assert.equal(scriptHash(inlineScripts('<script>a\r\nb</script>')[0]), scriptHash('a\nb'));
  // Two rules setting one header would be joined by Cloudflare: detected.
  const joined = matchHeaders(parseHeaders('/*\n  Content-Security-Policy: a\n/x\n  Content-Security-Policy: b\n'), '/x').get('content-security-policy');
  assert.deepEqual([joined.value, joined.joined], ['a, b', true]);
}
console.log('PASS launched: riftborn.us = game + classic + privacy with strict CSP (all inline scripts hashed, tamper detected), github.io = handoff pages + feedback inbox.');

// ---- the deploy workflow ---------------------------------------------------------------------------
{
  const { deployPlan, deployRefusals, wranglerEnv, WRANGLER_DIR, WRANGLER_VERSION } = await import('../scripts/cloudflare-pages-deploy.mjs');
  const plan = deployPlan({ sha: 'abc1234', message: 'Launch riftborn.us\nmore' });
  assert.deepEqual(plan.map(step => [step.project, step.dir]), [['riftborn', '_cf/live'], ['riftborn-dev', '_cf/dev']], 'riftborn.us first');
  assert.deepEqual(plan[0].create, ['pages', 'project', 'create', 'riftborn', '--production-branch', 'main']);
  assert.deepEqual(plan[1].deploy, ['pages', 'deploy', '_cf/dev', '--project-name', 'riftborn-dev', '--branch', 'main', '--commit-hash', 'abc1234', '--commit-message', 'Launch riftborn.us', '--commit-dirty=true']);
  const dry = spawnSync(process.execPath, ['scripts/cloudflare-pages-deploy.mjs', '--dry-run'], { encoding: 'utf8', env: baseEnv });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /pages project create riftborn --production-branch main/);
  const outputs = spawnSync(process.execPath, ['scripts/site-config.mjs'], { encoding: 'utf8' }).stdout;
  assert.equal(outputs, 'launched=false\nlive_project=riftborn\ndev_project=riftborn-dev\n');

  // Wrangler holds the production token: exact-pinned by a lockfile, never fetched at deploy time,
  // run without a shell and with only the environment it needs.
  assert.match(WRANGLER_VERSION, /^\d+\.\d+\.\d+$/, 'Wrangler is pinned to an exact version');
  const lock = JSON.parse(fs.readFileSync(path.join(WRANGLER_DIR, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].dependencies.wrangler, WRANGLER_VERSION, 'The lockfile matches package.json');
  assert.equal(lock.packages['node_modules/wrangler'].version, WRANGLER_VERSION);
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name && !entry.link) assert.match(entry.integrity || '', /^sha512-/, 'Every locked package carries an integrity hash: ' + name);
  }
  const deploySource = fs.readFileSync('scripts/cloudflare-pages-deploy.mjs', 'utf8');
  assert.ok(!/spawnSync\(\s*['"]npx|--yes|shell:\s*true|env:\s*process\.env\b/.test(deploySource), 'No npx, no shell, not the whole environment');
  assert.ok(deploySource.includes('spawnSync(process.execPath, [WRANGLER_BIN'), 'The locally installed, pinned Wrangler runs');
  const env = wranglerEnv({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', PATH: '/bin', HOME: '/home/runner', CI: 'true', GITHUB_TOKEN: 'gh', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc', FEEDBACK_ADMIN_KEY: 'k', AUTH_SIGNING_KEY: 's' });
  assert.deepEqual(env, { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', CI: 'true', PATH: '/bin', HOME: '/home/runner', WRANGLER_SEND_METRICS: 'false' }, 'Only the Cloudflare credentials and the basics reach Wrangler');

  // Only main deploys to production (a manual run on another branch never replaces riftborn.us).
  const account = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' };
  assert.deepEqual(deployRefusals({ ...account, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' }), []);
  assert.match(deployRefusals({ ...account, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/v2.2' }).join(), /Refusing to deploy refs\/heads\/v2\.2 to production/);
  assert.match(deployRefusals({ ...account, CI: 'true' }).join(), /Refusing to deploy an unknown ref/);
  assert.match(deployRefusals({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' }).join(), /CLOUDFLARE_API_TOKEN/);
  const ci = { CI: 'true', CF_PAGES_ENABLED: '1', GITHUB_REF: 'refs/heads/main' };
  assert.deepEqual(ciLaunchRefusals({ launched: true, env: ci }), [], 'A launch from main with Cloudflare on builds');
  assert.match(ciLaunchRefusals({ launched: true, env: { ...ci, GITHUB_REF: 'refs/heads/v2.2' } }).join(), /refs\/heads\/v2\.2, not refs\/heads\/main/, 'A launched build of another branch is refused');
  assert.match(ciLaunchRefusals({ launched: true, env: { ...ci, CF_PAGES_ENABLED: '' } }).join(), /CF_PAGES_ENABLED/);
  assert.deepEqual(ciLaunchRefusals({ launched: false, env: { CI: 'true', GITHUB_REF: 'refs/heads/v2.2' } }), [], 'Before launch any branch builds');
  assert.deepEqual(ciLaunchRefusals({ launched: true, env: {} }), [], 'Local builds are not CI');

  const workflow = fs.readFileSync('.github/workflows/pages.yml', 'utf8').replace(/\r\n/g, '\n');
  assert.match(workflow, /\n  cloudflare:\n(    #.*\n)*    if: vars\.CF_PAGES_ENABLED == '1' && github\.ref == 'refs\/heads\/main'\n    needs: build\n/, 'The Cloudflare job runs only on main, and only once CF_PAGES_ENABLED is 1');
  const job = workflow.slice(workflow.indexOf('\n  cloudflare:\n'), workflow.indexOf('\n  deploy:\n'));
  const install = job.indexOf('run: npm ci --prefix tools/wrangler --ignore-scripts');
  const deployStep = job.indexOf('run: node scripts/cloudflare-pages-deploy.mjs');
  const verifyStep = job.indexOf("if: needs.build.outputs.launched == 'true'\n        run: node scripts/cloudflare-pages-verify.mjs");
  assert.ok(install !== -1 && install < deployStep && deployStep < verifyStep, 'Install the pinned Wrangler, deploy, then (launched) check the real hosts');
  assert.ok(job.includes('cache-dependency-path: tools/wrangler/package-lock.json'));
  assert.ok(job.includes('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}') && job.includes('CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}'));
  assert.ok(workflow.includes('CF_PAGES_ENABLED: ${{ vars.CF_PAGES_ENABLED }}'), 'The build knows the switch (a launch without Cloudflare is refused)');
  assert.ok(workflow.includes('needs: [build, cloudflare]') && workflow.includes("needs.build.outputs.launched != 'true'"), 'After launch github.io waits for Cloudflare');
  assert.ok(workflow.includes('uses: actions/deploy-pages@v4'), 'The GitHub Pages deploy stays');
}
console.log('PASS deploy workflow: Cloudflare job only on main and gated on CF_PAGES_ENABLED, Wrangler pinned by lockfile with a minimal environment, project create + deploy per output (riftborn.us first), github.io waits for it after launch.');

// ---- after a launched deploy: the real hosts must serve it before github.io hands over ------------
{
  const { checkOnce, expectedBuilds, verifyDeployment, HANDOFF_READER } = await import('../scripts/cloudflare-pages-verify.mjs');
  const LIVE = 'https://riftborn.us', DEV = 'https://dev.riftborn.us';
  const game = `<script>var m = "${HANDOFF_READER}";</script>`;
  const site = (overrides = {}) => ({
    [`${LIVE}/version.json`]: [200, JSON.stringify({ build: 'live123' })],
    [`${LIVE}/`]: [200, game],
    [`${LIVE}/classic/`]: [200, game],
    [`${DEV}/`]: [200, game],
    [`${DEV}/version.json`]: [200, JSON.stringify({ build: 'dev456' })],
    ...overrides
  });
  const requests = [];
  const fakeFetch = routes => async (url, options) => {
    requests.push([url, options]);
    const route = routes[url.replace(/[?&]t=\d+$/, '')];
    if (!route) throw new TypeError('fetch failed');
    if (route === 'hang') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    return new Response(route[1], { status: route[0] });
  };
  const expected = { live: 'live123', dev: 'dev456' };
  assert.deepEqual(await checkOnce({ live: LIVE, dev: DEV, expected, fetchImpl: fakeFetch(site()) }), [], 'Everything served as deployed');
  assert.ok(requests.every(([url, options]) => /[?&]t=\d+$/.test(url) && options.redirect === 'manual' && options.cache === 'no-store'), 'Fresh, and a redirect is not an answer');
  const problems = async overrides => (await checkOnce({ live: LIVE, dev: DEV, expected, fetchImpl: fakeFetch(site(overrides)) })).join('\n');
  assert.match(await problems({ [`${LIVE}/version.json`]: [200, JSON.stringify({ build: 'old999' })] }), /serves build "old999", just deployed "live123"/, 'An older deployment still served');
  assert.match(await problems({ [`${LIVE}/`]: [200, '<p>Riftborn is coming to riftborn.us soon</p>'] }), /riftborn\.us\/: does not read the hand-over/, 'The pre-launch page (no reader)');
  assert.match(await problems({ [`${LIVE}/classic/`]: [200, '<script type="module" src="game.js"></script>'] }), /\/classic\/: does not read the hand-over/);
  assert.match(await problems({ [`${LIVE}/`]: [301, ''] }), /riftborn\.us\/: HTTP 301/);
  assert.match(await problems({ [`${LIVE}/`]: undefined, [`${LIVE}/version.json`]: undefined }), /riftborn\.us\/version\.json: fetch failed/, 'DNS / TLS failures count');
  assert.match(await problems({ [`${DEV}/`]: 'hang' }), /dev\.riftborn\.us\/: timed out/);
  assert.match(await problems({ [`${DEV}/version.json`]: [200, '{}'] }), /dev\.riftborn\.us\/version\.json: serves build undefined/);
  assert.match((await checkOnce({ live: LIVE, dev: DEV, expected: { live: null, dev: null }, fetchImpl: fakeFetch(site()) })).join(), /no build to compare/);
  // Retries while the deployment propagates, and gives up (non-zero exit in CI) if it never does.
  let calls = 0;
  const propagating = async (url, options) => (++calls <= 5 ? new Response('', { status: 522 }) : fakeFetch(site())(url, options));
  const late = await verifyDeployment({ live: LIVE, dev: DEV, expected, fetchImpl: propagating, delayMs: 0 });
  assert.deepEqual([late.ok, late.attempts], [true, 2]);
  const never = await verifyDeployment({ live: LIVE, dev: DEV, expected, fetchImpl: fakeFetch({}), attempts: 3, delayMs: 0 });
  assert.deepEqual([never.ok, never.attempts], [false, 3]);
  // It compares against the builds actually deployed (_cf/*/version.json of the launched build).
  const deployed = expectedBuilds(post);
  assert.equal(deployed.live, JSON.parse(fs.readFileSync(path.join(post, '_cf', 'live', 'version.json'), 'utf8')).build);
  assert.equal(deployed.dev, JSON.parse(fs.readFileSync(path.join(post, '_cf', 'dev', 'version.json'), 'utf8')).build);
  assert.deepEqual(expectedBuilds(path.join(tmp, 'nothing-here')), { live: null, dev: null });
}
console.log('PASS launch check: github.io hands over only once riftborn.us / dev.riftborn.us serve the new build and read the hand-over (older build, pre-launch page, redirects, DNS/TLS failures and timeouts all fail it; propagation is retried).');

fs.rmSync(tmp, { recursive: true, force: true });
