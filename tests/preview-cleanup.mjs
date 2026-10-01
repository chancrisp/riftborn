// The preview cleanup (scripts/pages-previews.mjs, scripts/cloudflare-pages-deploy.mjs --previews):
// removed previews' deployments deleted, then their links checked; a link that still serves its old
// build gets a "preview removed" page (the tombstone), which later runs keep and never redeploy; a
// branch staged again deploys over it; previews removed in git history are checked even when
// Cloudflare lists nothing for them; everything reported as scrubbed GitHub annotations.
// Wrangler, the Cloudflare API, the preview links and git are all faked; local only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DIGEST_TAG, aliasNameProblem, aliasState, annotationLines, branchOf, buildOf, cleanupPlan, isTombstone, isUnchanged, listPreviewDeployments,
  madeByPreviews, previewCleanup, previewCommitMessage, previewOrigin, removedPreviewNames, scrubPublic, tombstoneCommitMessage, tombstoneFiles,
  waitForAlias, workflowCommand
} from '../scripts/pages-previews.mjs';
import { WRANGLER_VERSION, deployPreviews, readSavedListing, tombstonePlan } from '../scripts/cloudflare-pages-deploy.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riftborn-preview-cleanup-'));
const TOKEN = 'tok_0123456789abcdef', ACCOUNT = '0123456789abcdef0123456789abcdef';
const L = 'v2-3-1-looks', S = 'v2-3-1-styles', F = 'v2-3-0-fail', R = 'v2-4-0-old';
const GATE = '<div id="devGate"></div>';
const preview = (name, build, digest) => ({ name, version: name.replace(/^v(\d+)-(\d+)-(\d+).*$/, '$1.$2.$3'), build, digest, origin: previewOrigin(name) });
const dep = (id, branch, created, { status = 'success', message = `Preview ${branch}: v2.4.0 build b-${id} ${DIGEST_TAG}0000000000000000`, environment = 'preview', aliases, meta = true } = {}) => ({
  id, environment, created_on: created, latest_stage: { name: 'deploy', status },
  deployment_trigger: { type: 'ad_hoc', metadata: { ...(meta ? { branch } : {}), commit_message: message } },
  ...(aliases ? { aliases } : {})
});
const tomb = (id, branch, created, status = 'success') => dep(id, branch, created, { status, message: tombstoneCommitMessage(branch) });

// ---- the plan: tombstones kept, older deployments deleted, nothing loops ---------------------------
{
  assert.equal(tombstoneCommitMessage(L), `Preview ${L}: removed`);
  assert.ok(isTombstone(tomb('t1', L, '1')) && madeByPreviews(tomb('t1', L, '1')), 'A tombstone is one of ours');
  assert.ok(!isTombstone(dep('d1', L, '1')), 'A preview build is not a tombstone');
  assert.ok(!isTombstone(dep('d2', L, '1', { message: `Preview ${S}: removed` })), "Another branch's tombstone message is not this branch's");
  assert.equal(buildOf(dep('d3', L, '1', { message: previewCommitMessage(preview(L, 'abc123', 'f'.repeat(64))) })), 'abc123');
  assert.equal(buildOf(tomb('t2', L, '1')), null);

  const deployments = [
    dep('p1', 'main', '2026-10-01T12:00:00Z', { environment: 'production', message: 'Dev' }),
    dep('h1', 'hand-made', '2026-10-01T12:00:00Z', { message: 'wrangler pages deploy by hand' }),
    // F: removed; its tombstone failed -> a plain removal again (all forced, link checked)
    tomb('f2', F, '2026-10-01T09:00:00Z', 'failure'),
    dep('f1', F, '2026-10-01T08:00:00Z'),
    // L: removed earlier and tombstoned: the tombstone stays, older deployments go (not forced)
    tomb('l3', L, '2026-10-01T20:00:00Z'),
    dep('l2', L, '2026-10-01T19:00:00Z'),
    dep('l1', L, '2026-10-01T18:00:00Z'),
    // S: current, staged again over its tombstone: newest build kept, the tombstone is an older build now
    dep('s2', S, '2026-10-01T22:00:00Z'),
    tomb('s1', S, '2026-10-01T15:00:00Z'),
    dep('s0', S, '2026-10-01T14:00:00Z'),
    // R: tombstoned once, staged again, removed again: a plain removal (everything, forced)
    dep('r2', R, '2026-10-01T21:00:00Z'),
    tomb('r1', R, '2026-10-01T10:00:00Z')
  ];
  const cleanup = previewCleanup(deployments, [S], { known: [L, 'v2-2-0', S, 'main', 'Bad Name', '0a1b2c3d'] });
  assert.deepEqual(cleanup.deletions, [
    { id: 'f2', branch: F, force: true, why: 'preview removed' },
    { id: 'f1', branch: F, force: true, why: 'preview removed' },
    { id: 'l2', branch: L, force: false, why: 'older than its "preview removed" page' },
    { id: 'l1', branch: L, force: false, why: 'older than its "preview removed" page' },
    { id: 's1', branch: S, force: false, why: 'older build' },
    { id: 's0', branch: S, force: false, why: 'older build' },
    { id: 'r2', branch: R, force: true, why: 'preview removed' },
    { id: 'r1', branch: R, force: true, why: 'preview removed' }
  ]);
  assert.deepEqual(cleanupPlan(deployments, [S]), cleanup.deletions, 'cleanupPlan is the same deletions');
  assert.deepEqual(cleanup.removed.map(entry => [entry.branch, entry.check, entry.tombstone, entry.oldBuild, entry.found, entry.fromHistory]), [
    [F, 'wait', null, 'b-f1', 2, false],
    [L, 'once', 'l3', 'b-l2', 3, false],
    [R, 'wait', null, 'b-r2', 2, false],
    ['v2-2-0', 'once', null, null, 0, true]
  ], 'Removed branches: checked after their deletions (wait), once when settled; a name from git history only once; current, production and impossible names never');
  assert.deepEqual(cleanup.current, [{ branch: S, found: 3, older: 2 }]);
  assert.ok(!cleanup.deletions.some(item => ['p1', 'h1', 'l3'].includes(item.id)), 'Production, hand-made deployments and a kept tombstone are never deleted');

  // The old build is the newest one that deployed: a failed deployment never held the alias.
  const failedNewest = previewCleanup([dep('n2', L, '2026-10-01T12:00:00Z', { status: 'failure' }), dep('n1', L, '2026-10-01T11:00:00Z')], []);
  assert.deepEqual([failedNewest.removed[0].oldBuild, failedNewest.deletions.map(item => [item.id, item.force])], ['b-n1', [['n2', true], ['n1', true]]]);
  assert.equal(previewCleanup([dep('n3', L, '1', { status: 'failure' })], []).removed[0].oldBuild, null);

  // No loop: a branch whose only deployment is its tombstone has nothing to do, run after run.
  const settled = previewCleanup([tomb('l3', L, '2026-10-01T20:00:00Z')], [], { known: [L] });
  assert.deepEqual([settled.deletions, settled.removed.map(entry => [entry.branch, entry.check, entry.tombstone])], [[], [[L, 'once', 'l3']]]);
  // A branch staged again is never "already served" by its tombstone: it deploys over it.
  assert.equal(isUnchanged([tomb('l3', L, '2026-10-01T20:00:00Z')], preview(L, 'x', 'f'.repeat(64))), false);
  // The existing behaviour: with no previews left every deployment made here goes, forced.
  assert.ok(cleanupPlan(deployments.filter(d => !isTombstone(d)), []).every(item => item.force));

  // The branch: metadata.branch; else the branch alias (never an 8-hex deployment address); else the
  // name in this tool's commit message.
  assert.equal(branchOf(dep('a1', L, '1', { meta: false, aliases: [`https://${L}.riftborn-dev.pages.dev`] })), L);
  assert.equal(branchOf(dep('a2', 'x', '1', { meta: false, message: `Preview ${S}: build y`, aliases: ['https://0a1b2c3d.riftborn-dev.pages.dev'] })), S);
  assert.equal(branchOf(dep('a3', 'x', '1', { meta: false, message: 'by hand', aliases: ['https://elsewhere.example.pages.dev'] })), '');
  assert.deepEqual(cleanupPlan([dep('a4', L, '1', { meta: false })], []).map(item => [item.id, item.branch]), [['a4', L]], 'Still found without branch metadata');
  assert.equal(aliasNameProblem('old-one'), null, 'Names from before the version names can still get a tombstone');
  assert.match(aliasNameProblem('main'), /production branch/);
}

// ---- the listing: capped pages, duplicates, missing fields -------------------------------------------
{
  const all = Array.from({ length: 23 }, (_, i) => dep(`dd${String(i).padStart(6, '0')}`, L, `2026-10-01T00:00:${String(59 - i).padStart(2, '0')}Z`));
  delete all[5].environment;
  const calls = [];
  // Cloudflare caps per_page at 10 and gives no total_pages: total_count decides; page 2 repeats one.
  const capped = async url => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const result = page === 2 ? [all[9], ...all.slice(10, 20)] : all.slice((page - 1) * 10, page * 10);
    return new Response(JSON.stringify({ success: true, result, result_info: { page, per_page: 10, total_count: 23 } }), { status: 200 });
  };
  const listed = await listPreviewDeployments({ token: TOKEN, accountId: ACCOUNT, fetchImpl: capped });
  assert.equal(calls.length, 3);
  assert.equal(listed.length, 23, 'Every deployment once');
  assert.deepEqual(listed.listing, { pages: 3, totalCount: 23, duplicates: 1 });
  assert.ok(!Object.keys(listed).includes('listing'), 'The report data is not an element');
  assert.equal(listed.find(d => d.id === all[5].id).environment, 'preview', 'From an env=preview listing');
}

// ---- git history: every previews/<name> ever removed -------------------------------------------------
{
  const asked = [];
  const git = args => {
    asked.push(args.join(' '));
    return args[0] === 'rev-parse' ? 'false\n' : 'previews/v2-3-1-looks/index.html\r\nprevious/x/index.html\n\npreviews/v2-3-1-looks/preview.json\npreviews/v2-3-1-looks/js/index.html\npreviews/old-one/index.html\n';
  };
  assert.deepEqual(removedPreviewNames('.', { git }), { names: ['old-one', L], shallow: false });
  assert.ok(asked[1].includes('--no-renames') && asked[1].includes('--diff-filter=D'), 'Trees only: no rename detection, so a blobless checkout never fetches contents');
  assert.equal(removedPreviewNames('.', { git: args => (args[0] === 'rev-parse' ? 'true\n' : '') }).shallow, true);
  // This checkout's own history (when it is whole): v2-3-1-looks was removed in 6a721a1.
  try {
    const real = removedPreviewNames();
    if (!real.shallow) assert.ok(real.names.includes(L), real.names.join(', '));
  } catch (error) {
    if (!/not a git repository/i.test(error.message)) throw error;
  }
}

// ---- the link check ------------------------------------------------------------------------------------
const site = routes => async (url, options = {}) => {
  assert.ok(!options.headers?.Authorization, 'The link check never sends credentials');
  assert.match(url, /[?&]t=\d+$/, 'Cache-busted');
  const route = routes[url.replace(/[?&]t=\d+$/, '')];
  if (route instanceof Error) throw route;
  return route ? new Response(route[1], { status: route[0] }) : new Response('Not found', { status: 404 });
};
{
  const origin = previewOrigin(L);
  const serving = { [`${origin}/version.json`]: [200, '{"version":"2.3.1","build":"631a95e35d"}'], [`${origin}/`]: [200, GATE] };
  const check = (routes, oldBuild = '631a95e35d') => aliasState({ name: L, oldBuild, fetchImpl: typeof routes === 'function' ? routes : site(routes) });
  assert.deepEqual(await check({}), { state: 'removed', build: null, detail: 'version.json HTTP 404, page HTTP 404' }, 'Gone');
  assert.deepEqual(await check(serving), { state: 'serving', build: '631a95e35d', detail: 'version.json serves build 631a95e35d' }, 'Still the old build');
  assert.equal((await check(serving, null)).state, 'serving', 'Old build unknown: any build still served counts');
  // Any build counts: the alias can stick to an older deployment than the newest listed (the newest
  // failed) or to one the listing missed; the old build only names it.
  assert.deepEqual(await check({ ...serving, [`${origin}/version.json`]: [200, '{"build":"other"}'] }),
    { state: 'serving', build: 'other', detail: 'version.json serves build other; the newest deployed build listed was 631a95e35d' }, 'Not the old build: still serving');
  assert.equal((await check({ [`${origin}/version.json`]: [404, ''], [`${origin}/`]: [200, GATE] })).state, 'serving', 'No version.json, but the gated build is still there');
  // Only 404 or 410 on both is gone; a 5xx, a redirect or an unexpected page is not known to be gone.
  assert.equal((await check({ [`${origin}/version.json`]: [410, ''], [`${origin}/`]: [404, ''] })).state, 'removed');
  assert.deepEqual(await check({ [`${origin}/version.json`]: [503, ''], [`${origin}/`]: [503, ''] }), { state: 'error', build: null, detail: 'version.json HTTP 503, page HTTP 503' }, 'A 5xx from the edge is not gone');
  assert.equal((await check({ [`${origin}/version.json`]: [404, ''], [`${origin}/`]: [502, ''] })).state, 'error');
  assert.equal((await check({ [`${origin}/version.json`]: [404, ''], [`${origin}/`]: [302, ''] })).state, 'error');
  assert.equal((await check({ [`${origin}/version.json`]: [404, ''], [`${origin}/`]: [200, '<p>something else</p>'] })).state, 'error');
  assert.equal((await check({ [`${origin}/version.json`]: [200, tombstoneFiles(L)['version.json']], [`${origin}/`]: [200, tombstoneFiles(L)['index.html']] })).state, 'tombstone');
  const down = await check(async () => { throw new TypeError('fetch failed'); });
  assert.equal(down.state, 'error', 'A network error is reported, never thrown');
  assert.match(down.detail, /fetch failed/);
  // Watched until it goes (two requests per attempt), or given up on after `attempts`.
  let requests = 0;
  const late = (url, options) => (++requests <= 4 ? site(serving) : site({}))(url, options);
  const slept = [];
  const gone = await waitForAlias({ name: L, oldBuild: '631a95e35d', fetchImpl: late, attempts: 5, delayMs: 5000, sleep: async ms => slept.push(ms) });
  assert.deepEqual([gone.state, gone.attempts, slept], ['removed', 3, [5000, 5000]]);
  const stuck = await waitForAlias({ name: L, oldBuild: '631a95e35d', fetchImpl: site(serving), attempts: 3, delayMs: 0, sleep: async () => {} });
  assert.deepEqual([stuck.state, stuck.attempts, typeof stuck.seconds], ['serving', 3, 'number']);
  // A transient 5xx right after the deletions keeps it checking, never stops it as "removed".
  let hits = 0;
  const flaky = (url, options) => (++hits <= 2 ? site({ [`${origin}/version.json`]: [503, ''], [`${origin}/`]: [503, ''] }) : site({}))(url, options);
  const settledLater = await waitForAlias({ name: L, oldBuild: '631a95e35d', fetchImpl: flaky, attempts: 5, delayMs: 0, sleep: async () => {} });
  assert.deepEqual([settledLater.state, settledLater.attempts], ['removed', 2]);
  const down5xx = await waitForAlias({ name: L, fetchImpl: site({ [`${origin}/version.json`]: [503, ''], [`${origin}/`]: [503, ''] }), attempts: 3, delayMs: 0, sleep: async () => {} });
  assert.deepEqual([down5xx.state, down5xx.attempts], ['error', 3]);
}

// ---- annotations: escaped, scrubbed, at most 10 per level --------------------------------------------
{
  assert.equal(workflowCommand('warning', 'Preview cleanup', `x: failed for ${TOKEN} at /accounts/${ACCOUNT}/ 100%\nnext, Bearer abc.def`, [TOKEN, ACCOUNT]),
    '::warning title=Preview cleanup::x: failed for *** at /accounts/***/ 100%25%0Anext, Bearer ***');
  assert.equal(workflowCommand('notice', 'a:b,c', 'm'), '::notice title=a%3Ab%2Cc::m');
  assert.equal(scrubPublic(`id ${ACCOUNT} kept 0a1b2c3d-0000-4000-8000-000000000000 digest ${'a'.repeat(16)}`), `id *** kept 0a1b2c3d-0000-4000-8000-000000000000 digest ${'a'.repeat(16)}`, 'An account id goes even when not passed in; deployment ids and digests stay');
  assert.throws(() => workflowCommand('debug', 't', 'm'), /Unknown annotation level/);
  const lines = annotationLines([...Array.from({ length: 13 }, (_, i) => ({ level: 'notice', message: `n${i}` })), { level: 'warning', message: 'w' }]);
  assert.equal(lines.length, 11);
  assert.equal(lines[0], '::warning title=Preview cleanup::w');
  assert.equal(lines[10], '::notice title=Preview cleanup::4 more: n9 | n10 | n11 | n12');
}

// ---- the tombstone ---------------------------------------------------------------------------------------
{
  const files = tombstoneFiles(L);
  assert.deepEqual(Object.keys(files).sort(), ['404.html', '_headers', 'index.html', 'robots.txt', 'version.json']);
  assert.ok(files['index.html'].includes('<meta name="robots" content="noindex,nofollow">') && files['index.html'].includes('This preview was removed'));
  assert.ok(!/<script/i.test(files['index.html']) && !files['index.html'].includes('devGate'), 'Nothing to run and nothing to gate');
  assert.deepEqual(JSON.parse(files['version.json']), { preview: L, removed: true, build: null });
  const style = files['index.html'].match(/<style>([^<]*)<\/style>/)[1];
  assert.ok(files._headers.includes(`style-src 'sha256-${crypto.createHash('sha256').update(style).digest('base64')}'`) && files._headers.includes("default-src 'none'"), files._headers);
  assert.match(files._headers, /X-Robots-Tag: noindex, nofollow/);
  assert.deepEqual(tombstonePlan(L, { sha: 'abc1234' }).deploy, ['pages', 'deploy', `_cf/preview-tombstones/${L}`, '--project-name', 'riftborn-dev', '--branch', L, '--commit-hash', 'abc1234', '--commit-message', `Preview ${L}: removed`, '--commit-dirty=true']);
  assert.throws(() => tombstonePlan('main'), /production branch/);
  assert.throws(() => tombstonePlan('0a1b2c3d'), /deployment id/);
  assert.throws(() => tombstonePlan('../x'), /not a branch alias/);
  assert.throws(() => tombstoneFiles('main'), /production branch/);
}
console.log('PASS preview cleanup plan: a removed branch whose newest deployment is its "preview removed" page keeps it (older ones deleted, never redeployed), a failed or outdated tombstone does not count, a branch staged again deploys over it; listing pages, duplicates and missing fields handled; removed names from git history; link check (gone, still serving, tombstone, network error) and scrubbed annotations.');

// ---- whole --previews runs ---------------------------------------------------------------------------------
{
  const base = path.join(tmp, 'site');
  const builds = { [S]: preview(S, 'sbuild', 'a'.repeat(64)), [L]: preview(L, 'lbuild', 'b'.repeat(64)) };
  const stage = names => {
    const out = path.join(base, '_cf', 'previews');
    fs.rmSync(out, { recursive: true, force: true });
    for (const name of names) {
      fs.mkdirSync(path.join(out, name), { recursive: true });
      fs.writeFileSync(path.join(out, name, 'index.html'), GATE);
      fs.writeFileSync(path.join(out, name, '_headers'), '/*\n');
    }
    fs.writeFileSync(path.join(out, 'previews.json'), JSON.stringify({ project: 'riftborn-dev', previews: names.map(name => ({ ...builds[name], dir: `_cf/previews/${name}` })) }));
  };
  const env = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, COMMIT_SHA: 'abc1234' };
  const built = (name, id, created) => dep(id, name, created, { message: previewCommitMessage(builds[name]) });
  const world = ({ deployments = [], sticky = [], known = [] } = {}) => {
    let clock = 0;
    const state = {
      deployments, wrangler: [], deleted: [], gets: [], failDelete: new Map(), failDeploy: false, lists: 0, failListFrom: 0, hidden: new Set(), sticky: new Set(sticky), known,
      links: Object.fromEntries(deployments.filter(d => d.environment === 'preview').map(d => [branchOf(d), { version: [200, JSON.stringify({ build: buildOf(d) })], page: [200, GATE] }]))
    };
    state.run = args => {
      state.wrangler.push(args.join(' '));
      if (args[1] === 'project') return { ok: false, output: 'A project with this name already exists. [code: 8000002]' };
      if (state.failDeploy) return { ok: false, output: 'Deploy failed' };
      const branch = args[args.indexOf('--branch') + 1];
      const message = args[args.indexOf('--commit-message') + 1];
      clock++;
      state.deployments.push(dep(`cccc${String(clock).padStart(4, '0')}`, branch, `2026-10-02T00:00:${String(clock).padStart(2, '0')}Z`, { message }));
      // The branch alias now serves what was just deployed.
      const dir = path.join(base, args[2]);
      const version = args[2].includes('tombstones') ? fs.readFileSync(path.join(dir, 'version.json'), 'utf8') : JSON.stringify({ build: buildOf(state.deployments.at(-1)) });
      state.links[branch] = { version: [200, version], page: [200, fs.readFileSync(path.join(dir, 'index.html'), 'utf8')] };
      return { ok: true, output: `Deployment alias URL: https://${branch}.riftborn-dev.pages.dev` };
    };
    state.fetchImpl = async (url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      const u = new URL(url);
      if (options.method === 'DELETE') {
        const id = u.pathname.split('/').pop();
        if (state.failDelete.has(id)) return new Response(JSON.stringify({ success: false, errors: [{ code: 8000000, message: state.failDelete.get(id) }] }), { status: 500 });
        const gone = state.deployments.find(d => d.id === id);
        state.deleted.push([id, u.searchParams.get('force') === 'true']);
        state.deployments = state.deployments.filter(d => d.id !== id);
        const branch = branchOf(gone);
        // The 2026-10-01 case: a "sticky" link keeps serving after every deployment of it is gone.
        if (!state.sticky.has(branch) && !state.deployments.some(d => branchOf(d) === branch)) delete state.links[branch];
        return new Response(JSON.stringify({ success: true, result: null }), { status: 200 });
      }
      // failListFrom: the n-th listing and later fail (the first listing of a run is before its deploys).
      if (state.failListFrom && ++state.lists >= state.failListFrom) return new Response(JSON.stringify({ success: false, errors: [{ code: 8000000, message: `upstream error for ${ACCOUNT} ${TOKEN}` }] }), { status: 502 });
      const result = state.deployments.filter(d => d.environment === u.searchParams.get('env') && !state.hidden.has(d.id));
      return new Response(JSON.stringify({ success: true, result, result_info: { page: 1, total_pages: 1, total_count: result.length } }), { status: 200 });
    };
    state.aliasFetch = async (url, options = {}) => {
      assert.ok(!options.headers?.Authorization, 'Never the token');
      state.gets.push(url);
      const u = new URL(url);
      const link = state.links[u.hostname.split('.')[0]];
      if (link instanceof Error) throw link;
      if (!link) return new Response('Not found', { status: 404 });
      const [status, text] = u.pathname === '/version.json' ? link.version : link.page;
      return new Response(text, { status });
    };
    state.go = async (overrides = {}) => {
      const lines = [];
      state.lines = lines;
      return deployPreviews({
        base, env, run: state.run, fetchImpl: state.fetchImpl, aliasFetch: state.aliasFetch, removedNames: () => ({ names: state.known, shallow: false }),
        sleep: async () => {}, linkWait: { attempts: 3, delayMs: 0 }, installed: () => WRANGLER_VERSION, log: line => lines.push(String(line)), warn: () => {}, ...overrides
      });
    };
    state.annotations = () => state.lines.filter(line => line.startsWith('::'));
    return state;
  };
  const deploys = state => state.wrangler.filter(line => line.startsWith('pages deploy'));
  const noSecrets = lines => assert.ok(lines.every(line => !line.includes(TOKEN) && !line.includes(ACCOUNT)), lines.join('\n'));

  // 1. A removed preview whose link goes once its deployments are deleted: reported, nothing else.
  stage([S]);
  const one = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), built(L, 'aaaa0002', '2026-10-01T09:00:00Z')] });
  const summaryFile = path.join(tmp, 'summary.md');
  let result = await one.go({ env: { ...env, GITHUB_STEP_SUMMARY: summaryFile } });
  assert.deepEqual(result, { rows: [[S, 'unchanged']], removed: [L], tombstoned: [], aliases: { [L]: 'removed' } });
  assert.deepEqual(one.deleted, [['aaaa0002', true]]);
  assert.deepEqual(deploys(one), [], 'No tombstone needed');
  assert.deepEqual(one.annotations(), [
    `::notice title=Preview cleanup::Listed 2 preview deployments in riftborn-dev (1 page, Cloudflare total_count 2): ${L} 1, ${S} 1.`,
    `::notice title=Preview cleanup::${L} (not in previews/): found 1 deployment, deleted 1 (forced). https://${L}.riftborn-dev.pages.dev/ no longer serves build lbuild (version.json HTTP 404, page HTTP 404; after 0s).`,
    `::notice title=Preview cleanup::Current previews: ${S} (newest kept, no older builds).`
  ]);
  assert.ok(one.gets.some(url => url.startsWith(`https://${L}.riftborn-dev.pages.dev/version.json?t=`)) && one.gets.some(url => /^https:\/\/v2-3-1-looks\.riftborn-dev\.pages\.dev\/\?t=\d+$/.test(url)), 'version.json and the page, cache-busted');
  const summary = fs.readFileSync(summaryFile, 'utf8');
  assert.ok(summary.includes(`| ${S} | v2.3.1 sbuild | https://${S}.riftborn-dev.pages.dev/ | unchanged |`) && summary.includes(`Removed: ${L}`) && summary.includes('#### Preview cleanup') && summary.includes('no longer serves build lbuild'), summary);

  // 2. The 2026-10-01 case: the link still serves the old build after the deletions -> warning, then
  //    the tombstone (recognisable commit message), and the link serves it.
  const two = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), built(L, 'aaaa0002', '2026-10-01T09:00:00Z')], sticky: [L] });
  result = await two.go();
  assert.deepEqual(result, { rows: [[S, 'unchanged']], removed: [L], tombstoned: [L], aliases: { [L]: 'tombstone' } });
  assert.deepEqual(deploys(two), [`pages deploy _cf/preview-tombstones/${L} --project-name riftborn-dev --branch ${L} --commit-hash abc1234 --commit-message Preview ${L}: removed --commit-dirty=true`]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, '_cf', 'preview-tombstones', L, 'version.json'), 'utf8')), { preview: L, removed: true, build: null });
  let annotations = two.annotations();
  assert.ok(annotations.includes(`::warning title=Preview cleanup::${L} (not in previews/): found 1 deployment, deleted 1 (forced). But https://${L}.riftborn-dev.pages.dev/ still serves build lbuild after 0s (version.json serves build lbuild): deploying a "preview removed" page over it.`), annotations.join('\n'));
  assert.ok(annotations.includes(`::notice title=Preview cleanup::${L}: "preview removed" page deployed (commit message "Preview ${L}: removed"); https://${L}.riftborn-dev.pages.dev/ now serves it after 0s. Later runs keep it and never deploy it again.`), annotations.join('\n'));
  // Next run: the tombstone is the branch's newest deployment -> kept, not redeployed, nothing deleted.
  result = await two.go();
  assert.deepEqual(result, { rows: [[S, 'unchanged']], removed: [], tombstoned: [], aliases: { [L]: 'tombstone' } });
  assert.equal(deploys(two).length, 1, 'Never deployed again');
  assert.ok(two.annotations().includes(`::notice title=Preview cleanup::Removed previews already settled (link checked): ${L} ("preview removed" page).`), two.annotations().join('\n'));
  // A deployment older than the tombstone turning up later is deleted without force; the tombstone stays.
  two.deployments.push(built(L, 'aaaa0009', '2026-10-01T08:00:00Z'));
  await two.go();
  assert.deepEqual(two.deleted.at(-1), ['aaaa0009', false]);
  assert.equal(deploys(two).length, 1);
  assert.ok(two.deployments.some(isTombstone));
  // 3. The branch comes back: it deploys over its tombstone, which goes as an older build.
  stage([L, S]);
  const tombId = two.deployments.find(isTombstone).id;
  result = await two.go();
  assert.deepEqual(result.rows, [[L, 'deployed'], [S, 'unchanged']]);
  assert.match(deploys(two).at(-1), new RegExp(`^pages deploy _cf/previews/${L} --project-name riftborn-dev --branch ${L} .*--commit-message Preview ${L}: v2\\.3\\.1 build lbuild `));
  assert.deepEqual(two.deleted.at(-1), [tombId, false]);
  assert.ok(!two.deployments.some(isTombstone));
  assert.deepEqual(result.aliases, {}, 'A current preview is not a removed one');
  stage([S]);

  // 4. A network error while checking: a warning, no crash, no tombstone; the next run checks again.
  const four = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), built(L, 'aaaa0002', '2026-10-01T09:00:00Z')] });
  four.links[L] = new TypeError('fetch failed');
  four.sticky.add(L);
  result = await four.go();
  assert.deepEqual([result.removed, result.tombstoned, result.aliases], [[L], [], { [L]: 'error' }]);
  assert.ok(four.annotations().some(line => line.startsWith(`::warning title=Preview cleanup::${L} (not in previews/): found 1 deployment, deleted 1 (forced). Could not check https://${L}.riftborn-dev.pages.dev/ (`)), four.annotations().join('\n'));
  assert.deepEqual(deploys(four), []);

  // 5. Cloudflare lists nothing for a preview removed in git history, yet its link still serves:
  //    warning + tombstone; then settled, even when the listing misses the tombstone too (no loop).
  const five = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z')], known: [L, S] });
  five.links[L] = { version: [200, '{"version":"2.3.1","build":"631a95e35d"}'], page: [200, GATE] };
  result = await five.go();
  assert.deepEqual([result.removed, result.tombstoned, result.aliases], [[], [L], { [L]: 'tombstone' }]);
  assert.ok(five.annotations().includes(`::warning title=Preview cleanup::${L}: removed from previews/ (git history) and Cloudflare lists no deployment of it made here, yet https://${L}.riftborn-dev.pages.dev/ still serves build 631a95e35d (version.json serves build 631a95e35d): deploying a "preview removed" page over it.`), five.annotations().join('\n'));
  five.hidden.add(five.deployments.find(isTombstone).id);
  result = await five.go();
  assert.deepEqual([result.tombstoned, result.aliases], [[], { [L]: 'tombstone' }]);
  assert.equal(deploys(five).length, 1, 'The link already shows the tombstone: never deployed again');
  // ...and one already gone is only listed as settled.
  const gone = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z')], known: [L] });
  await gone.go();
  assert.ok(gone.annotations().includes(`::notice title=Preview cleanup::Removed previews already settled (link checked): ${L} (gone: version.json HTTP 404, page HTTP 404).`), gone.annotations().join('\n'));
  // ...and one still served by deployments whose commit message is not recognised as this
  //    workflow's (a silent miss of the plain cleanup): never deleted, named in the report, and the
  //    link retired by a tombstone all the same (the name was a preview of this repo).
  const foreign = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), dep('eeee0001', L, '2026-10-01T09:00:00Z', { message: 'v2.3.1 build 631a95e35d' })], known: [L] });
  foreign.links[L] = { version: [200, '{"build":"631a95e35d"}'], page: [200, GATE] };
  result = await foreign.go();
  assert.deepEqual([result.tombstoned, foreign.deleted], [[L], []]);
  assert.ok(foreign.deployments.some(d => d.id === 'eeee0001'), 'Never deleted');
  assert.ok(foreign.annotations().includes(`::notice title=Preview cleanup::Listed 2 preview deployments in riftborn-dev (1 page, Cloudflare total_count 2): ${S} 1; 1 not made by this workflow (left alone): ${L} 1.`), foreign.annotations().join('\n'));
  assert.ok(foreign.annotations().includes(`::warning title=Preview cleanup::${L}: removed from previews/ (git history), yet https://${L}.riftborn-dev.pages.dev/ still serves build 631a95e35d (version.json serves build 631a95e35d); Cloudflare lists 1 deployment of it not recognised as made by this workflow (newest: eeee0001 "v2.3.1 build 631a95e35d"), left in place: deploying a "preview removed" page over it.`), foreign.annotations().join('\n'));
  await foreign.go();
  assert.equal(deploys(foreign).length, 1, 'Then settled: never deployed again');

  // 6. Failures: annotations and the error never carry the token or account id; a forced delete or a
  //    tombstone that fails still fails the run (after reporting).
  const six = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), built(L, 'aaaa0002', '2026-10-01T09:00:00Z')], sticky: [L] });
  six.failDelete.set('aaaa0002', `denied for ${ACCOUNT} with ${TOKEN}`);
  await assert.rejects(six.go(), error => /Could not remove these previews/.test(error.message) && !error.message.includes(TOKEN) && !error.message.includes(ACCOUNT));
  noSecrets(six.lines);
  assert.ok(six.annotations().some(line => line.startsWith(`::warning title=Preview cleanup::${L}: could not delete deployment aaaa0002 (forced): Cloudflare API DELETE /accounts/***/pages/projects/riftborn-dev/deployments/aaaa0002: HTTP 500 (8000000: denied for *** with ***)`)), six.annotations().join('\n'));
  assert.deepEqual(six.deleted, []);
  assert.equal(deploys(six).length, 1, 'The link still served the old build: tombstoned anyway');
  const seven = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), built(L, 'aaaa0002', '2026-10-01T09:00:00Z')], sticky: [L] });
  seven.failDeploy = true;
  await assert.rejects(seven.go(), /Could not remove these previews[\s\S]*deploying its "preview removed" page failed/);
  assert.ok(seven.annotations().some(line => line.startsWith(`::warning title=Preview cleanup::${L}: deploying the "preview removed" page failed`)));
  for (const failed of [six, seven]) assert.ok(failed.annotations()[0].startsWith(`::error title=Preview cleanup::Could not remove 1 preview (their links may still work): ${L}: `), failed.annotations().join('\n'));

  // 6b. The removed branch's newest deployment failed and its alias sticks to the older one (or to
  //     one the listing missed): any build served is still serving -> warning + tombstone.
  const older = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), dep('aaaa0003', L, '2026-10-01T09:30:00Z', { status: 'failure', message: previewCommitMessage({ ...builds[L], build: 'newbuild' }) }), built(L, 'aaaa0002', '2026-10-01T09:00:00Z')], sticky: [L] });
  older.links[L] = { version: [200, JSON.stringify({ build: 'lbuild' })], page: [200, GATE] };
  result = await older.go();
  assert.deepEqual([result.tombstoned, result.aliases, older.deleted], [[L], { [L]: 'tombstone' }, [['aaaa0003', true], ['aaaa0002', true]]]);
  assert.ok(older.annotations().includes(`::warning title=Preview cleanup::${L} (not in previews/): found 2 deployments, deleted 2 (forced). But https://${L}.riftborn-dev.pages.dev/ still serves build lbuild after 0s (version.json serves build lbuild): deploying a "preview removed" page over it.`), older.annotations().join('\n'));
  const missed = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), built(L, 'aaaa0002', '2026-10-01T09:00:00Z')], sticky: [L] });
  missed.links[L] = { version: [200, JSON.stringify({ build: 'unlisted' })], page: [200, GATE] };
  result = await missed.go();
  assert.deepEqual(result.tombstoned, [L]);
  assert.ok(missed.annotations().some(line => line.includes(`still serves build unlisted after 0s (version.json serves build unlisted; the newest deployed build listed was lbuild)`)), missed.annotations().join('\n'));

  // 6c. A 5xx from the edge right after the deletions is not "removed": checked again until it is
  //     404; one that stays 5xx only warns (no tombstone), never reported as gone.
  const flaky = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), built(L, 'aaaa0002', '2026-10-01T09:00:00Z')] });
  let edge = 0;
  result = await flaky.go({ aliasFetch: async (url, options) => (++edge <= 2 ? new Response('', { status: 503 }) : flaky.aliasFetch(url, options)) });
  assert.deepEqual([result.aliases, result.tombstoned], [{ [L]: 'removed' }, []]);
  assert.ok(flaky.annotations().includes(`::notice title=Preview cleanup::${L} (not in previews/): found 1 deployment, deleted 1 (forced). https://${L}.riftborn-dev.pages.dev/ no longer serves build lbuild (version.json HTTP 404, page HTTP 404; after 0s).`), flaky.annotations().join('\n'));
  const edgeDown = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), built(L, 'aaaa0002', '2026-10-01T09:00:00Z')] });
  result = await edgeDown.go({ aliasFetch: async () => new Response('', { status: 503 }) });
  assert.deepEqual([result.aliases, result.tombstoned, deploys(edgeDown)], [{ [L]: 'error' }, [], []]);
  assert.ok(edgeDown.annotations().includes(`::warning title=Preview cleanup::${L} (not in previews/): found 1 deployment, deleted 1 (forced). Could not check https://${L}.riftborn-dev.pages.dev/ (version.json HTTP 503, page HTTP 503; after 0s); the next run checks it again.`), edgeDown.annotations().join('\n'));

  // 6d. A run that stops early still says why on the run page (an error annotation, scrubbed) and
  //     in the job summary, after whatever it had already found and done.
  const listDown = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), built(L, 'aaaa0002', '2026-10-01T09:00:00Z')] });
  listDown.failListFrom = 2; // the listing after the deploys
  const stoppedFile = path.join(tmp, 'stopped.md');
  await assert.rejects(listDown.go({ env: { ...env, GITHUB_STEP_SUMMARY: stoppedFile } }), /Cloudflare API GET \/accounts\/\*\*\*\/pages\/projects\/riftborn-dev\/deployments: HTTP 502/);
  assert.deepEqual(listDown.annotations(), ['::error title=Preview cleanup::The preview run stopped early: Cloudflare API GET /accounts/***/pages/projects/riftborn-dev/deployments: HTTP 502 (8000000: upstream error for *** ***)']);
  assert.deepEqual(listDown.deleted, []);
  const stopped = fs.readFileSync(stoppedFile, 'utf8');
  assert.ok(stopped.includes(`| ${S} | v2.3.1 sbuild | https://${S}.riftborn-dev.pages.dev/ | unchanged |`) && stopped.includes('- ERROR: The preview run stopped early: Cloudflare API GET /accounts/***/'), stopped);
  noSecrets([...listDown.lines, ...stopped.split('\n')]);
  const refused = world();
  await assert.rejects(refused.go({ env: { ...env, GITHUB_REF: 'refs/heads/v2.4' } }), /Refusing to deploy refs\/heads\/v2\.4/);
  assert.deepEqual(refused.annotations(), ['::error title=Preview cleanup::The preview run stopped early: Refusing to deploy refs/heads/v2.4 to production: only refs/heads/main deploys riftborn.us, dev.riftborn.us and feedback.riftborn.us.']);
  // A tombstone that cannot even be prepared (here a branch name no alias can have) fails that
  // branch only, after the deletions are reported.
  const LONG = 'v2-3-1-this-name-is-far-too-long';
  const long = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), dep('aaaa0005', LONG, '2026-10-01T09:00:00Z', { message: `Preview ${LONG}: v2.3.1 build longbuild ${DIGEST_TAG}0000000000000000` })], sticky: [LONG] });
  await assert.rejects(long.go(), /Could not remove these previews[\s\S]*could not deploy its "preview removed" page \(Refusing a "preview removed" page/);
  assert.deepEqual([deploys(long), long.deleted], [[], [['aaaa0005', true]]]);
  assert.ok(long.annotations().some(line => line.startsWith(`::error title=Preview cleanup::Could not remove 1 preview (their links may still work): ${LONG}: could not deploy its "preview removed" page`)), long.annotations().join('\n'));
  assert.ok(long.annotations().some(line => line.startsWith(`::warning title=Preview cleanup::${LONG} (not in previews/): found 1 deployment, deleted 1 (forced). But https://${LONG}.riftborn-dev.pages.dev/ still serves build longbuild`)), long.annotations().join('\n'));

  for (const state of [one, two, four, five, gone, foreign, seven, older, missed, flaky, edgeDown, refused, long]) noSecrets(state.lines);

  // 7. Outside GitHub Actions the same report is plain lines.
  const eight = world({ deployments: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z')] });
  await eight.go({ env: { ...env, GITHUB_ACTIONS: '' } });
  assert.deepEqual(eight.annotations(), []);
  assert.ok(eight.lines.includes(`notice: Preview cleanup: Current previews: ${S} (newest kept, no older builds).`), eight.lines.join('\n'));

  // 8. The dry run calls nothing; with a saved listing it prints the exact deletions, checks and tombstones.
  const never = async () => { throw new Error('the dry run called the network'); };
  const listingFile = path.join(tmp, 'listing.json');
  fs.writeFileSync(listingFile, JSON.stringify({ success: true, result: [built(S, 'aaaa0001', '2026-10-01T10:00:00Z'), built(L, 'aaaa0002', '2026-10-01T09:00:00Z'), tomb('aaaa0003', R, '2026-10-01T08:00:00Z'), built(S, 'aaaa0004', '2026-09-30T10:00:00Z')] }));
  const lines = [];
  const dry = await deployPreviews({ base, env: { COMMIT_SHA: 'abc1234' }, dryRun: true, deployments: readSavedListing(listingFile), run: never, fetchImpl: never, aliasFetch: never, removedNames: () => ({ names: [L, 'v2-2-0'], shallow: false }), log: line => lines.push(line) });
  const text = lines.join('\n');
  assert.ok(text.includes(`delete aaaa0002 of ${L} (forced: preview removed)`) && text.includes(`delete aaaa0004 of ${S} (not forced: older build)`), text);
  assert.ok(text.includes(`check https://${L}.riftborn-dev.pages.dev/ for up to 55s after its deletions; if it still serves a build (last deployed: lbuild): wrangler@${WRANGLER_VERSION} pages deploy _cf/preview-tombstones/${L} --project-name riftborn-dev --branch ${L} --commit-hash abc1234 --commit-message Preview ${L}: removed --commit-dirty=true`), text);
  assert.ok(text.includes(`check https://${R}.riftborn-dev.pages.dev/ once (its newest deployment aaaa0003 is its "preview removed" page: kept, never deployed again)`), text);
  assert.ok(text.includes('check https://v2-2-0.riftborn-dev.pages.dev/ once (removed in git history, nothing listed)'), text);
  assert.equal(dry.cleanup.deletions.length, 2);
  const plain = [];
  await deployPreviews({ base, env: {}, dryRun: true, run: never, fetchImpl: never, aliasFetch: never, removedNames: () => { throw new Error('not a git repository'); }, log: line => plain.push(line) });
  assert.match(plain.join('\n'), /--commit-message Preview <branch>: removed[\s\S]*previews removed in git history: unknown \(not a git repository\)[\s\S]*Cloudflare was not called/);
  assert.throws(() => readSavedListing(summaryFile), /Unexpected|JSON/);
}
console.log('PASS preview cleanup runs: removed links checked after their deletions and reported as annotations (scrubbed), a link still serving its old build gets one "preview removed" page that later runs keep, a branch staged again deploys over it, network errors only warn, git-history names with nothing listed are caught, failures still fail the run, and the dry run calls nothing.');

// A staging failure is on the run page too (scripts/pages-previews.mjs's own error annotation).
{
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/pages-previews.mjs', import.meta.url))], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', RIFTBORN_PAGES_OUT: path.join(tmp, 'never') } });
  assert.equal(cli.status, 1, cli.stderr);
  assert.ok(cli.stdout.includes('::error title=Preview links::RIFTBORN_PAGES_OUT is for local tests only.'), cli.stdout + cli.stderr);
}
console.log('PASS preview cleanup failures: a removed link serving any build (not only the newest listed) gets its tombstone, a 5xx is checked again and never called gone, and a run that stops early (refusal, Cloudflare API error, a tombstone that cannot be prepared) reports why as a scrubbed error annotation after what it found.');

fs.rmSync(tmp, { recursive: true, force: true });
