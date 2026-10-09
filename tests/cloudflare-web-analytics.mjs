// The read-only Cloudflare Web Analytics state check (scripts/cloudflare-web-analytics.mjs, the one-off
// workflow .github/workflows/cloudflare-web-analytics.yml) against a fake Cloudflare API. Proves:
//   - it only reads: GET calls plus one POST that asks for the NAMES of logged fields; the token goes to
//     api.cloudflare.com only, never to riftborn.us and friends;
//   - nothing secret reaches its output (it is the public annotations of a public repository): no token,
//     account id, zone id, site tag, site token, Pages tag, snippet or token id;
//   - what it finds: zone plan, Workers plan, which mechanism injects the beacon, the token's reach, whether
//     Workers Logs can hold client IPs; and that a missing token permission is named exactly (required ones
//     fail the run, optional ones warn).
// Local only; nothing is fetched. Run with the other Cloudflare tests: tests/cloudflare-pages-domains.mjs imports this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PAGES_PROJECTS } from '../site.config.mjs';
import {
  INSPECT_PROJECTS, IP_KEY, PERMISSIONS, SERVED_URLS, WORKER_SCRIPT, injectionVerdict, inspect, inspectPlan, inspectRefusals, renderAnnotations
} from '../scripts/cloudflare-web-analytics.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef', TOKEN = 'cf-test-token-never-printed', API = 'https://api.cloudflare.com';
const MARKS = ['SITETAG-1', 'SITETOKEN-2', 'PAGESTAG-3', 'ZONEID-4', 'TOKENID-5', 'SNIPPET-6']; // unique values the fake returns in every id, tag, token and snippet field
const env = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
const ACCT = `/client/v4/accounts/${ACCOUNT}`;
const quiet = () => {};

const DEFAULT_KEYS = ['$workers.event.request.url', '$workers.event.request.headers.cf-connecting-ip'];
const DEFAULT_GROUPS = ['Account Settings Write', 'Account Settings Read', 'Zone Read'];

/**
 * A fake Cloudflare API (and the public hosts). Records every call as { origin, url, path, method, authorization, body }.
 * deny: call kinds answered 403 / 10000 (a token without that permission): zone, rum, pages, worker, verify, policies, subs, keys.
 * marks: unique values put into every id, tag, token and snippet the fake returns.
 */
function fakeCloudflare({ plan = { legacy_id: 'free', name: 'Free Website', is_subscribed: false }, zones, rum, pages = {}, worker, keys = DEFAULT_KEYS, subs = ['Workers Paid'], groups = DEFAULT_GROUPS, served = {}, deny = [], marks = [] } = {}) {
  const [siteTag = 'st', siteToken = 'stk', pagesTag = 'pt', zoneId = 'zone-1', tokenId = 'tok-1', snippet = 'sn'] = marks;
  const calls = [];
  const reply = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
  const ok = result => reply(200, { success: true, errors: [], messages: [], result });
  const fail = (code, error, message) => reply(code, { success: false, errors: [{ code: error, message }], messages: [], result: null });
  const site = (zone, auto) => ({
    site_tag: siteTag, site_token: siteToken, auto_install: auto, snippet: `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${snippet}"}'></script>`,
    rules: [{ host: zone, paths: ['*'], inclusive: true, is_paused: false }], ruleset: { enabled: true, zone_name: zone, zone_tag: zoneId }
  });
  const zoneList = zones ?? [{ id: zoneId, name: 'riftborn.us', plan }];
  const rumList = rum ?? [site('riftborn.us', true), site('example.com', true)];
  const pageState = { riftborn: pagesTag, 'riftborn-dev': null, 'riftborn-feedback': '', ...pages };
  const workerSettings = worker ?? { observability: { enabled: true, head_sampling_rate: 1, logs: { enabled: true, invocation_logs: true, persist: true } }, logpush: false, tail_consumers: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ origin: u.origin, url, path: u.pathname, method: init.method || 'GET', authorization: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
    if (u.origin !== API) {
      const answer = served[url];
      if (answer === 'error') throw new TypeError('fetch failed');
      return new Response(answer?.html ?? '<!doctype html><html><body>riftborn</body></html>', { status: answer?.status ?? 200 });
    }
    const p = u.pathname;
    const kind = p === '/client/v4/zones' ? 'zone'
      : p === `${ACCT}/rum/site_info/list` ? 'rum'
        : p.startsWith(`${ACCT}/pages/projects/`) ? 'pages'
          : p === `${ACCT}/workers/scripts/${WORKER_SCRIPT}/settings` ? 'worker'
            : p === `${ACCT}/tokens/verify` ? 'verify'
              : p.startsWith(`${ACCT}/tokens/`) ? 'policies'
                : p === `${ACCT}/subscriptions` ? 'subs'
                  : p === `${ACCT}/workers/observability/telemetry/keys` ? 'keys' : 'unknown';
    if (deny.includes(kind)) return fail(403, 10000, 'Authentication error');
    switch (kind) {
      case 'zone': return ok(zoneList.filter(z => u.searchParams.get('name') === z.name));
      case 'rum': return ok(rumList);
      case 'pages': {
        const project = p.split('/').at(-1);
        if (pageState[project] === 'missing') return fail(404, 8000007, 'Project not found');
        const tag = pageState[project];
        return ok({ name: project, build_config: { build_command: '', web_analytics_tag: tag, web_analytics_token: tag ? siteToken : null }, latest_deployment: { build_config: { web_analytics_tag: tag } } });
      }
      case 'worker': return ok(workerSettings);
      case 'verify': return ok({ id: tokenId, status: 'active' });
      case 'policies': return ok({ id: tokenId, status: 'active', policies: [{ effect: 'allow', permission_groups: groups.map((name, i) => ({ id: 'g' + i, name })) }] });
      case 'subs': return ok(subs.map(name => ({ id: 'sub-1', rate_plan: { public_name: name } })));
      case 'keys':
        if (keys === 'bad') return fail(400, 1001, 'bad request');
        return ok(keys.map(key => ({ key, type: 'string' })));
      default: return fail(404, 7003, 'No route for that URI');
    }
  };
  return { fetchImpl, calls, site };
}
const run = async (options = {}, extra = {}) => {
  const logs = [];
  const result = await inspect({ env, fetchImpl: fakeCloudflare(options).fetchImpl, log: line => logs.push(line), ...extra });
  return { ...result, logs };
};

// ---- PRIVACY PROMISE 1: read-only, and the token goes to the Cloudflare API only ----------------------------
{
  const fake = fakeCloudflare({});
  await inspect({ env, fetchImpl: fake.fetchImpl, log: quiet });
  assert.ok(fake.calls.length >= 12, 'every probe ran');
  for (const call of fake.calls) {
    const api = call.origin === API;
    assert.equal(Boolean(call.authorization), api, 'token only on the Cloudflare API: ' + call.url);
    assert.ok(call.method === 'GET' || (api && call.method === 'POST' && call.path.endsWith('/workers/observability/telemetry/keys')), 'read-only: ' + call.method + ' ' + call.url);
  }
  assert.deepEqual(fake.calls.filter(c => c.origin !== API).map(c => c.url), SERVED_URLS);
}
// ---- PRIVACY PROMISE 2: the output is public (annotations of a public repository): no secret, id, tag or token in it ----
{
  const logs = [];
  const { report, problems } = await inspect({ env, fetchImpl: fakeCloudflare({ marks: MARKS }).fetchImpl, log: line => logs.push(line) });
  const lines = renderAnnotations(report, problems);
  const printed = [JSON.stringify(report), ...logs, ...lines].join('\n');
  for (const secret of [TOKEN, ACCOUNT, ...MARKS]) assert.ok(!printed.includes(secret), 'not printed: ' + secret);
  assert.ok(lines.length <= 6 && lines.every(l => l.length <= 3000 && !l.includes('\n') && /^::(notice|warning|error) title=Web Analytics inspect/.test(l)));
}
console.log('PASS web analytics inspect privacy: read-only calls, the token only to api.cloudflare.com, and no id, tag, token or secret in the report, the logs or the annotations.');

// ---- the constants, the plan and the refusals ---------------------------------------------------------------
{
  assert.equal(WORKER_SCRIPT, 'riftborn-leaderboard');
  assert.deepEqual(INSPECT_PROJECTS, Object.values(PAGES_PROJECTS));
  assert.deepEqual(SERVED_URLS, ['https://riftborn.us/', 'https://riftborn.us/privacy/', 'https://dev.riftborn.us/', 'https://feedback.riftborn.us/']);
  assert.equal(Object.isFrozen(PERMISSIONS), true);
  assert.deepEqual(Object.keys(PERMISSIONS), ['zone', 'webAnalyticsRead', 'webAnalyticsWrite', 'pages', 'workers', 'billing', 'tokens', 'observability']);
  assert.equal(PERMISSIONS.zone, 'Zone > Zone > Read (zone riftborn.us)');
  assert.equal(PERMISSIONS.webAnalyticsWrite, 'Account > Account Settings > Edit');
  const plan = inspectPlan().join('\n');
  for (const part of [
    'GET  /zones?name=riftborn.us', 'GET  /accounts/<account>/rum/site_info/list', `GET  /accounts/<account>/workers/scripts/${WORKER_SCRIPT}/settings`,
    'GET  /accounts/<account>/tokens/verify', 'GET  /accounts/<account>/subscriptions', 'POST /accounts/<account>/workers/observability/telemetry/keys',
    ...INSPECT_PROJECTS.map(project => `GET  /accounts/<account>/pages/projects/${project}`), ...SERVED_URLS, ...Object.values(PERMISSIONS)
  ]) assert.ok(plan.includes(part), 'The plan names: ' + part);
  // The dry run needs no token or account and fetches nothing; other subcommands do not exist yet.
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CI, GITHUB_ACTIONS, ...clean } = process.env;
  const cli = (...args) => spawnSync(process.execPath, ['scripts/cloudflare-web-analytics.mjs', ...args], { encoding: 'utf8', env: clean });
  const dry = cli('inspect', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run \(nothing is fetched\)[\s\S]*\/zones\?name=riftborn\.us/);
  const bare = cli('inspect');
  assert.equal(bare.status, 1, 'Without a token it refuses');
  assert.match(bare.stderr, /Set the CLOUDFLARE_API_TOKEN secret/);
  for (const args of [['apply'], []]) {
    const other = cli(...args);
    assert.equal(other.status, 1, 'only inspect exists yet: ' + args.join(' '));
    assert.match(other.stderr, /only `inspect` exists yet/);
  }
  // Refusals: CI off main, a bad account id; a local run with credentials is fine.
  assert.ok(inspectRefusals({ ...env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/other' }).some(r => /only refs\/heads\/main/.test(r)));
  assert.ok(inspectRefusals({ ...env, CLOUDFLARE_ACCOUNT_ID: 'nope' }).some(r => /CLOUDFLARE_ACCOUNT_ID/.test(r)));
  assert.deepEqual(inspectRefusals(env), []);
  assert.deepEqual(inspectRefusals({ ...env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' }), []);
}
console.log('PASS web analytics inspect plan: every call and permission is named, --dry-run needs no token, CI off main and a bad account id are refused, and only `inspect` exists yet.');

// ---- zone and Workers plan -------------------------------------------------------------------------------------
{
  const free = await run({});
  assert.deepEqual([free.report.zone.name, free.report.zone.found, free.report.zone.plan, free.report.zone.free], ['riftborn.us', true, 'free', true]);
  const pro = await run({ plan: { legacy_id: 'pro', name: 'Pro Website', is_subscribed: true } });
  assert.deepEqual([pro.report.zone.plan, pro.report.zone.free], ['pro', false]);
  const missing = await run({ zones: [] });
  assert.equal(missing.report.zone.found, false);
  assert.deepEqual(missing.problems.filter(p => p.required).map(p => p.permission), [PERMISSIONS.zone]);
  assert.equal(free.report.workersPlan, 'paid');
  assert.deepEqual(free.report.subscriptions, ['Workers Paid']);
  const none = await run({ subs: ['Free Website'] });
  assert.equal(none.report.workersPlan, 'unknown', 'never "free" from absence');
  const denied = await run({ deny: ['subs'] });
  assert.equal(denied.report.workersPlan, 'unknown');
  assert.equal(denied.report.subscriptions, null);
  assert.deepEqual(denied.problems.map(p => [p.permission, p.required]), [[PERMISSIONS.billing, false]]);
}
// ---- Web Analytics sites (rum) -----------------------------------------------------------------------------------
{
  const fake = fakeCloudflare({});
  const on = await run({});
  assert.equal(on.report.injection.zoneAutoInstall, true);
  assert.equal(on.report.rum.readable, true);
  assert.deepEqual(on.report.rum.sites.map(s => [s.zone, s.autoInstall, s.rulesetEnabled, s.hasSnippet]), [['riftborn.us', true, true, true], ['example.com', true, true, true]]);
  assert.deepEqual(on.report.rum.sites[0].rules, [{ host: 'riftborn.us', paths: ['*'], inclusive: true, paused: false }]);
  const other = await run({ rum: [fake.site('example.com', true)] });
  assert.equal(other.report.injection.zoneAutoInstall, false, "another zone's site is listed, not counted");
  const off = await run({ rum: [fake.site('riftborn.us', false)] });
  assert.equal(off.report.injection.zoneAutoInstall, false);
  const denied = await run({ deny: ['rum'] });
  assert.equal(denied.report.rum.readable, false);
  assert.equal(denied.report.injection.zoneAutoInstall, null);
  assert.deepEqual(denied.problems.map(p => [p.permission, p.required]), [[PERMISSIONS.webAnalyticsRead, true]]);
}
// ---- Pages "Metrics" toggle --------------------------------------------------------------------------------------
{
  const on = await run({ pages: { riftborn: 'a-tag', 'riftborn-dev': 'b-tag', 'riftborn-feedback': null } });
  assert.deepEqual([on.report.pages.riftborn.metricsOn, on.report.pages['riftborn-dev'].metricsOn, on.report.pages['riftborn-feedback'].metricsOn], [true, true, false]);
  assert.deepEqual(on.report.injection.pagesMetricsOn, ['riftborn', 'riftborn-dev']);
  const empty = await run({ pages: { riftborn: '', 'riftborn-dev': null } });
  assert.deepEqual([empty.report.pages.riftborn.metricsOn, empty.report.pages['riftborn-dev'].metricsOn], [false, false]);
  const gone = await run({ pages: { 'riftborn-feedback': 'missing' } });
  assert.deepEqual(gone.report.pages['riftborn-feedback'], { readable: true, exists: false, metricsOn: null });
  assert.deepEqual(gone.problems, [], 'a project that does not exist is not a problem');
  const denied = await run({ deny: ['pages'] });
  assert.equal(denied.report.pages.riftborn.readable, false);
  assert.equal(denied.report.injection.pagesMetricsOn.length, 0);
  assert.deepEqual(denied.problems.map(p => [p.permission, p.required]), [[PERMISSIONS.pages, true]], 'one problem for the permission, not one per project');
}
// ---- the verdict table -------------------------------------------------------------------------------------------
{
  assert.equal(injectionVerdict({ zoneAutoInstall: true, pagesMetricsOn: [], servedWithBeacon: [] }), 'zone');
  assert.equal(injectionVerdict({ zoneAutoInstall: false, pagesMetricsOn: ['riftborn'], servedWithBeacon: [] }), 'pages');
  assert.equal(injectionVerdict({ zoneAutoInstall: true, pagesMetricsOn: ['riftborn-dev'], servedWithBeacon: [] }), 'both');
  assert.equal(injectionVerdict({ zoneAutoInstall: false, pagesMetricsOn: [], servedWithBeacon: [] }), 'none');
  assert.equal(injectionVerdict({ zoneAutoInstall: false, pagesMetricsOn: [], servedWithBeacon: ['https://riftborn.us/'] }), 'unexplained');
  assert.equal(injectionVerdict({ zoneAutoInstall: null, pagesMetricsOn: null, servedWithBeacon: [] }), 'unknown');
}
// ---- what the public pages really serve --------------------------------------------------------------------------
{
  const beaconHtml = '<html><script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon=\'{"token": "x"}\'></script></html>';
  const r = await run({ served: { 'https://riftborn.us/': { html: beaconHtml }, 'https://dev.riftborn.us/': 'error' } });
  const by = Object.fromEntries(r.report.served.map(s => [s.url, s]));
  assert.deepEqual([by['https://riftborn.us/'].status, by['https://riftborn.us/'].beacon], [200, true]);
  assert.deepEqual([by['https://riftborn.us/privacy/'].status, by['https://riftborn.us/privacy/'].beacon], [200, false]);
  assert.deepEqual([by['https://dev.riftborn.us/'].status, by['https://dev.riftborn.us/'].beacon], [0, null], 'a network error is unknown, not a problem');
  assert.deepEqual(r.report.injection.servedWithBeacon, ['https://riftborn.us/']);
  assert.equal(r.problems.length, 0);
}
// ---- Workers Logs: can they hold client IPs? ------------------------------------------------------------------------
{
  const yes = await run({});
  assert.deepEqual(yes.report.workerLogs, {
    observability: true, invocationLogs: true, persist: true, headSamplingRate: 1, logpush: false, tailConsumers: [], ipFieldNames: ['$workers.event.request.headers.cf-connecting-ip'], ipQuestion: 'yes'
  });
  const no = await run({ keys: ['$workers.event.request.url', 'description', 'recipient'] });
  assert.deepEqual([no.report.workerLogs.ipQuestion, no.report.workerLogs.ipFieldNames], ['no', []]);
  for (const [options, label] of [[{ deny: ['keys'] }, 'denied'], [{ keys: 'bad' }, 'HTTP 400'], [{ keys: [] }, 'empty']]) {
    const unknown = await run(options);
    assert.equal(unknown.report.workerLogs.ipQuestion, 'unknown', label);
    assert.equal(unknown.report.workerLogs.ipFieldNames, null, label);
    assert.deepEqual(unknown.problems.map(p => [p.permission, p.required]), [[PERMISSIONS.observability, false]], label);
  }
  for (const text of ['description', 'recipient', '$workers.event.request.url', 'ipsum']) assert.equal(IP_KEY.test(text), false, text);
  for (const text of ['cf-connecting-ip', 'client_ip', '$workers.event.request.headers.x-forwarded-for', 'remote_addr', 'ip']) assert.equal(IP_KEY.test(text), true, text);
}
// ---- the token: can it change Web Analytics? -------------------------------------------------------------------------
{
  const yes = await run({ marks: MARKS });
  assert.equal(yes.report.token.canChangeWebAnalytics, 'yes');
  assert.equal(yes.report.token.status, 'active');
  assert.deepEqual(yes.report.token.policyGroups, [...DEFAULT_GROUPS].sort());
  assert.deepEqual(yes.report.token.reads, { zone: true, webAnalytics: true, pages: true, workers: true });
  assert.ok(!yes.logs.join('\n').includes(MARKS[4]), 'the token id never appears in the logs');
  const no = await run({ groups: ['Zone Read', 'Account Settings Read'] });
  assert.equal(no.report.token.canChangeWebAnalytics, 'no');
  const denied = await run({ deny: ['policies'] });
  assert.equal(denied.report.token.canChangeWebAnalytics, 'unknown');
  assert.equal(denied.report.token.policyGroups, null);
  assert.deepEqual(denied.problems.map(p => [p.permission, p.required]), [[PERMISSIONS.tokens, false]]);
  const readsDenied = await run({ deny: ['rum', 'worker'] });
  assert.deepEqual(readsDenied.report.token.reads, { zone: true, webAnalytics: false, pages: true, workers: false });
}
// ---- required versus optional; the annotations; the shapes ------------------------------------------------------------
{
  for (const [kind, permission] of [['zone', PERMISSIONS.zone], ['rum', PERMISSIONS.webAnalyticsRead], ['pages', PERMISSIONS.pages], ['worker', PERMISSIONS.workers]]) {
    const r = await run({ deny: [kind] });
    assert.deepEqual(r.problems.map(p => [p.required, p.permission]), [[true, permission]], kind);
    assert.ok(r.problems[0].what.length > 10, 'says what could not be read: ' + kind);
    const lines = renderAnnotations(r.report, r.problems);
    const errors = lines.filter(l => l.startsWith('::error'));
    assert.equal(errors.length, 1, kind);
    assert.ok(errors[0].includes(`add "${permission}" to the token`) && errors[0].startsWith('::error title=Cloudflare token permission missing::'), errors[0]);
    assert.equal(lines.filter(l => l.startsWith('::warning')).length, 0, kind);
    assert.equal(lines.filter(l => l.startsWith('::notice')).length, 6, 'five sections and a result line: ' + kind);
  }
  for (const [kind, permission] of [['subs', PERMISSIONS.billing], ['policies', PERMISSIONS.tokens], ['keys', PERMISSIONS.observability]]) {
    const r = await run({ deny: [kind] });
    assert.deepEqual(r.problems.map(p => [p.required, p.permission]), [[false, permission]], kind);
    const lines = renderAnnotations(r.report, r.problems);
    assert.equal(lines.filter(l => l.startsWith('::error')).length, 0, kind);
    assert.equal(lines.filter(l => l.startsWith('::warning')).length, 1, kind);
  }
  const all = await run({});
  assert.deepEqual(all.report.shapes.zonePlan, ['is_subscribed', 'legacy_id', 'name']);
  assert.deepEqual(all.report.shapes.rumSite, ['auto_install', 'rules', 'ruleset', 'site_tag', 'site_token', 'snippet'], 'key NAMES only');
  assert.deepEqual(all.report.shapes.pagesBuildConfig, ['build_command', 'web_analytics_tag', 'web_analytics_token']);
  assert.deepEqual(all.report.shapes.workerSettings, ['logpush', 'observability', 'tail_consumers']);
  assert.match(all.report.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal((await run({}, { now: () => new Date('2026-10-09T12:00:00Z') })).report.at, '2026-10-09T12:00:00.000Z');
}
console.log('PASS web analytics inspect: zone and Workers plan, the Web Analytics sites, the Pages toggle, what is really served, the injection verdict, whether Workers Logs can hold IPs, what the token can change, and exact token permissions (required fail, optional warn).');

// STAGE0-WORKFLOW-PINS begin
// The one-off workflow (.github/workflows/cloudflare-web-analytics.yml): main only, read-only, the token in one step.
{
  const wf = fs.readFileSync(new URL('../.github/workflows/cloudflare-web-analytics.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = wf.split('\n').filter(line => !/^\s*#/.test(line)).join('\n') + '\n';
  assert.match(code, /\non:\n  push:\n    branches: \[main\]\n    paths:\n      - '\.github\/workflows\/cloudflare-web-analytics\.yml'\n(?!\s+- )/, 'push on main, this file only');
  assert.doesNotMatch(code, /workflow_dispatch|workflow_run|schedule|pull_request/, 'no other trigger');
  for (const part of ['environment: cloudflare-production', "if: github.ref == 'refs/heads/main'", 'contents: read', 'actions/checkout@v7', 'actions/setup-node@v7', 'persist-credentials: false']) assert.ok(code.includes(part), 'the workflow has: ' + part);
  assert.ok(code.includes('run: node scripts/cloudflare-web-analytics.mjs inspect\n'), 'it runs inspect');
  assert.doesNotMatch(code, /apply|--confirm/, 'read-only: no apply or confirm');
  for (const step of code.split('\n      - ').slice(1)) assert.equal(step.includes('secrets.CLOUDFLARE_API_TOKEN'), step.includes('cloudflare-web-analytics.mjs inspect'), 'the token reaches only the inspect step');
}
console.log('PASS web analytics workflow: push on main for this file only, production environment, read-only permissions, no apply, and the token reaches only the inspect step.');
// STAGE0-WORKFLOW-PINS end
