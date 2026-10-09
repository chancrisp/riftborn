// Connecting feedback.riftborn.us to its Cloudflare Pages project (scripts/cloudflare-pages-domains.mjs,
// the feedback job of .github/workflows/pages.yml) against a fake Cloudflare API. Proves:
//   - the plan (--dry-run) names every call and the token permissions, and needs no token;
//   - only main may run it in CI, and a missing token or account id is refused up front;
//   - a first run adds the Pages custom domain, then a proxied CNAME to the project's own pages.dev
//     subdomain (read, never guessed: unreadable means no write); a second run only reads
//     (idempotent), and "already exists" is fine;
//   - a record already at that name that is not ours is never touched: the run stops and says what is there;
//   - each missing token permission fails with the exact permission to add, and the token is never printed;
//   - a pending domain passes (reported), a broken one fails.
// Local only; nothing is fetched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  CUSTOM_DOMAINS, PERMISSIONS, RECORD_COMMENT, ZONE, connectDomain, connectDomains, cloudflareApi, deniedAnswer, domainPlan, domainRefusals
} from '../scripts/cloudflare-pages-domains.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-test-token-never-printed';
const env = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
const HOST = 'feedback.riftborn.us';
const PROJECT = 'riftborn-feedback';

/**
 * A fake Cloudflare API with state: the project, its custom domains, the zone's DNS records.
 * deny: call kinds answered 403 / 10000 (a token without that permission).
 */
function fakeCloudflare({ subdomain = 'riftborn-feedback.pages.dev', domains = [], records = [], zones = [{ id: 'zone-1', name: 'riftborn.us' }], deny = [], status = 'pending', project = true, addDomain = null, addRecord = null, domainDetail = {} } = {}) {
  const state = { domains: [...domains], records: records.map(record => ({ ...record })) };
  const calls = [];
  const reply = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
  const ok = result => reply(200, { success: true, errors: [], messages: [], result });
  const fail = (code, error, message) => reply(code, { success: false, errors: [{ code: error, message }], messages: [], result: null });
  const base = `/client/v4/accounts/${ACCOUNT}/pages/projects/${PROJECT}`;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.cloudflare.com', 'only the Cloudflare API');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const kind = u.pathname === base ? 'project'
      : u.pathname === `${base}/domains` ? (init.method === 'POST' ? 'addDomain' : 'domains')
        : u.pathname === `${base}/domains/${HOST}` ? 'domain'
          : u.pathname === '/client/v4/zones' ? 'zones'
            : u.pathname === '/client/v4/zones/zone-1/dns_records' ? (init.method === 'POST' ? 'addRecord' : 'records') : 'unknown';
    calls.push({ kind, method: init.method, url: u.pathname + u.search, authorization: init.headers.Authorization, body });
    if (deny.includes(kind)) return fail(403, 10000, 'Authentication error');
    if (!project && kind !== 'zones') return fail(404, 8000007, 'Project not found. The specified project name does not match any of your existing projects.');
    switch (kind) {
      case 'project': return ok({ name: PROJECT, subdomain, domains: state.domains });
      case 'domains': return ok(state.domains.map(name => ({ name, status })));
      case 'addDomain':
        if (addDomain) return addDomain();
        if (state.domains.includes(body.name)) return fail(409, 8000018, 'You have already added this custom domain.');
        state.domains.push(body.name);
        return ok({ name: body.name, status: 'initializing' });
      case 'domain': return state.domains.includes(HOST) ? ok({ name: HOST, status, ...domainDetail }) : fail(404, 8000013, 'Domain not found');
      case 'zones': return ok(zones.filter(zone => u.searchParams.get('name') === zone.name));
      case 'records': return ok(state.records.filter(record => record.name === u.searchParams.get('name')));
      case 'addRecord':
        if (addRecord) return addRecord();
        state.records.push({ ...body, id: 'rec-' + state.records.length });
        return ok(state.records.at(-1));
      default: return fail(404, 7003, 'No route for that URI');
    }
  };
  return { fetchImpl, calls, state };
}
const run = async (fake, extra = {}) => {
  const logs = [];
  const result = await connectDomains({ env: { ...env, ...extra }, fetchImpl: fake.fetchImpl, log: line => logs.push(line) });
  return { ...result, logs };
};

// ---- what it manages, the plan and the refusals ----------------------------------------------------
{
  assert.deepEqual(CUSTOM_DOMAINS, [{ project: PROJECT, host: HOST }], 'Only feedback.riftborn.us; the game domains are left alone');
  assert.equal(ZONE, 'riftborn.us');
  assert.deepEqual(Object.values(PERMISSIONS), ['Account > Cloudflare Pages > Edit', 'Zone > Zone > Read (zone riftborn.us)', 'Zone > DNS > Edit (zone riftborn.us)']);
  const plan = domainPlan().join('\n');
  for (const part of [
    `POST /accounts/<account>/pages/projects/${PROJECT}/domains {"name":"${HOST}"}`,
    'GET  /zones?name=riftborn.us',
    `POST /zones/<zone>/dns_records {"type":"CNAME","name":"${HOST}","content":"<subdomain>","proxied":true}`,
    'never changed', 'Zone > DNS > Edit'
  ]) assert.ok(plan.includes(part), 'The plan names: ' + part);
  // The dry run runs without a token or account and fetches nothing.
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CI, GITHUB_ACTIONS, ...clean } = process.env;
  const dry = spawnSync(process.execPath, ['scripts/cloudflare-pages-domains.mjs', '--dry-run'], { encoding: 'utf8', env: clean });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run \(nothing is fetched\)[\s\S]*feedback\.riftborn\.us -> Cloudflare Pages project riftborn-feedback/);
  const bare = spawnSync(process.execPath, ['scripts/cloudflare-pages-domains.mjs'], { encoding: 'utf8', env: clean });
  assert.equal(bare.status, 1, 'Without a token it refuses');
  assert.match(bare.stderr, /Set the CLOUDFLARE_API_TOKEN secret \(it needs Account > Cloudflare Pages > Edit, Zone > Zone > Read \(zone riftborn\.us\), Zone > DNS > Edit \(zone riftborn\.us\)\)/);

  assert.deepEqual(domainRefusals({ ...env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' }), []);
  assert.match(domainRefusals({ ...env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/v2.4' }).join(), /Refusing to change custom domains from refs\/heads\/v2\.4/);
  assert.match(domainRefusals({ ...env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/pull/7/merge' }).join(), /refs\/pull\/7\/merge/, 'Never from a pull request');
  assert.match(domainRefusals({ ...env, CLOUDFLARE_ACCOUNT_ID: 'nope' }).join(), /CLOUDFLARE_ACCOUNT_ID/);
  assert.deepEqual(domainRefusals(env), [], 'Local runs with credentials may');
  const fake = fakeCloudflare();
  await assert.rejects(connectDomains({ env: { ...env, CI: 'true', GITHUB_REF: 'refs/heads/v2.4' }, fetchImpl: fake.fetchImpl, log: () => {} }), /Refusing/);
  assert.equal(fake.calls.length, 0, 'A refused run makes no call');
}
console.log('PASS plan: feedback.riftborn.us only, every call and permission named in the dry run (no token needed); only main in CI, credentials required.');

// ---- first run, second run ---------------------------------------------------------------------------
{
  const fake = fakeCloudflare();
  const first = await run(fake);
  assert.deepEqual(first.problems, []);
  assert.deepEqual(first.results, [{ host: HOST, project: PROJECT, target: 'riftborn-feedback.pages.dev', domain: 'added', record: 'added', status: 'pending' }]);
  assert.deepEqual(fake.calls.map(call => `${call.method} ${call.kind}`), ['GET project', 'GET domains', 'POST addDomain', 'GET zones', 'GET records', 'POST addRecord', 'GET domain'], 'The Pages domain first, then the DNS record');
  assert.deepEqual(fake.calls.find(call => call.kind === 'addDomain').body, { name: HOST });
  assert.deepEqual(fake.calls.find(call => call.kind === 'addRecord').body, { type: 'CNAME', name: HOST, content: 'riftborn-feedback.pages.dev', proxied: true, ttl: 1, comment: RECORD_COMMENT });
  assert.ok(RECORD_COMMENT.length <= 100, 'DNS comments are capped at 100 characters on the free plan');
  assert.ok(fake.calls.every(call => call.authorization === `Bearer ${TOKEN}`), 'The token only ever travels as the Authorization header');
  assert.equal(fake.calls.find(call => call.kind === 'zones').url, '/client/v4/zones?name=riftborn.us');
  assert.equal(fake.calls.find(call => call.kind === 'records').url, '/client/v4/zones/zone-1/dns_records?name=feedback.riftborn.us');
  const printed = first.logs.join('\n');
  assert.ok(!printed.includes(TOKEN) && !printed.includes(ACCOUNT), 'Neither the token nor the account id is printed');
  assert.match(printed, /POST \/accounts\/<account>\/pages\/projects\/riftborn-feedback\/domains -> ok/);
  assert.match(printed, /feedback\.riftborn\.us: pending \(Cloudflare is checking the record/);

  // Second run (the next push): everything is there, so it only reads.
  fake.calls.length = 0;
  const second = await run(fake);
  assert.deepEqual(second.problems, []);
  assert.deepEqual([second.results[0].domain, second.results[0].record], ['present', 'present']);
  assert.ok(fake.calls.every(call => call.method === 'GET'), 'Idempotent: no write once it is in place');
  assert.equal(fake.state.records.length, 1, 'No second record');

  // The project's subdomain is read, not guessed (pages.dev names are global; a taken one gets a suffix).
  const suffixed = fakeCloudflare({ subdomain: 'riftborn-feedback-7xq.pages.dev' });
  assert.equal((await run(suffixed)).results[0].target, 'riftborn-feedback-7xq.pages.dev');
  assert.equal(suffixed.state.records[0].content, 'riftborn-feedback-7xq.pages.dev');
  // ...so a project read without a usable pages.dev name stops the run before any write: never a
  // CNAME to the bare riftborn-feedback.pages.dev, which could be another account's project.
  for (const subdomain of [null, '', 'riftborn-feedback', 'riftborn-feedback.example.com', 'evil.pages.dev.example.com']) {
    const unread = fakeCloudflare({ subdomain });
    const stopped = await run(unread);
    assert.equal(stopped.results.length, 0, String(subdomain));
    assert.match(stopped.problems[0].message, /Could not read the pages\.dev name of the Pages project riftborn-feedback .*Nothing was changed/, String(subdomain));
    assert.deepEqual(unread.calls.map(call => call.kind), ['project'], 'No domain, zone or DNS call: ' + subdomain);
    assert.equal(unread.state.records.length, 0);
  }
  // A record we made earlier, or one made by hand as DNS only: left as it is.
  const handmade = fakeCloudflare({ records: [{ type: 'CNAME', name: HOST, content: 'Riftborn-Feedback.pages.dev', proxied: false }], domains: [HOST], status: 'active' });
  const kept = await run(handmade);
  assert.deepEqual([kept.problems, kept.results[0].record, kept.results[0].status], [[], 'present', 'active']);
  assert.match(kept.logs.join('\n'), /\(DNS only; it still works\)/);
  // "Already exists" answers (a race with the dashboard, or with Cloudflare adding the record itself) are fine.
  const race = fakeCloudflare({
    addDomain: () => new Response(JSON.stringify({ success: false, errors: [{ code: 8000018, message: 'You have already added this custom domain.' }] }), { status: 409 }),
    addRecord: () => new Response(JSON.stringify({ success: false, errors: [{ code: 81058, message: 'An identical record already exists.' }] }), { status: 400 })
  });
  race.state.domains.push(HOST); // what the 409 means
  const raced = await run({ fetchImpl: async (url, init) => (init.method === 'GET' && url.endsWith('/domains') ? new Response(JSON.stringify({ success: true, result: [] })) : race.fetchImpl(url, init)) });
  assert.deepEqual(raced.problems, []);
  assert.deepEqual([raced.results[0].domain, raced.results[0].record], ['present', 'present']);
}
console.log('PASS connect: a first run adds the Pages custom domain, then a proxied CNAME to the project\'s own pages.dev name (read, never guessed: an unreadable one stops the run before any write); a second run only reads; "already exists" is fine; the token and account id are never printed.');

// ---- what it never does, and what it says when it cannot ------------------------------------------
{
  // Someone else's record at that name: never touched.
  const taken = fakeCloudflare({ records: [{ type: 'A', name: HOST, content: '192.0.2.10', proxied: true }] });
  const stopped = await run(taken);
  assert.equal(stopped.results.length, 0);
  assert.match(stopped.problems[0].message, /DNS: feedback\.riftborn\.us already has A 192\.0\.2\.10, not a CNAME to riftborn-feedback\.pages\.dev\. Nothing was changed/);
  assert.ok(!taken.calls.some(call => call.kind === 'addRecord'), 'No write over an existing record');
  assert.equal(taken.state.records.length, 1);

  // Each missing permission is named exactly (for the owner), and the token never shows.
  const cases = [
    ['project', PERMISSIONS.pages, /may not read the Pages project riftborn-feedback \(HTTP 403: 10000 Authentication error\)\. Add the permission "Account > Cloudflare Pages > Edit"/],
    ['addDomain', PERMISSIONS.pages, /may not add feedback\.riftborn\.us to riftborn-feedback/],
    ['zones', PERMISSIONS.zone, /may not read the riftborn\.us zone .*"Zone > Zone > Read \(zone riftborn\.us\)"/],
    ['records', PERMISSIONS.dns, /may not read the DNS records of feedback\.riftborn\.us .*"Zone > DNS > Edit \(zone riftborn\.us\)"/],
    ['addRecord', PERMISSIONS.dns, /may not add the DNS record feedback\.riftborn\.us CNAME riftborn-feedback\.pages\.dev .*"Zone > DNS > Edit \(zone riftborn\.us\)"/]
  ];
  for (const [kind, permission, message] of cases) {
    const denied = await run(fakeCloudflare({ deny: [kind] }));
    assert.equal(denied.problems.length, 1, kind);
    assert.equal(denied.problems[0].permission, permission, kind);
    assert.match(denied.problems[0].message, message, kind);
    assert.ok(!JSON.stringify(denied).includes(TOKEN), 'The token never appears: ' + kind);
  }
  // A token scoped to other zones sees no riftborn.us at all.
  const blind = await run(fakeCloudflare({ zones: [] }));
  assert.equal(blind.problems[0].permission, PERMISSIONS.zone);
  assert.match(blind.problems[0].message, /cannot see the riftborn\.us zone .*Add "Zone > Zone > Read \(zone riftborn\.us\)" and "Zone > DNS > Edit \(zone riftborn\.us\)"/);
  assert.equal(deniedAnswer({ status: 400, errors: [[9109, 'Unauthorized to access requested resource']] }), true);
  assert.equal(deniedAnswer({ status: 400, errors: [[81053, 'record exists']] }), false);

  // The project not deployed yet: says so (the deploy job creates it).
  const early = await run(fakeCloudflare({ project: false }));
  assert.match(early.problems[0].message, /riftborn-feedback does not exist yet: the deploy step before this one creates it \(scripts\/cloudflare-pages-deploy\.mjs --feedback\)/);
  assert.equal(early.problems[0].permission, '');
  // A broken domain fails with Cloudflare's reason; pending and active pass.
  const broken = await run(fakeCloudflare({ domains: [HOST], records: [{ type: 'CNAME', name: HOST, content: 'riftborn-feedback.pages.dev', proxied: true }], status: 'error', domainDetail: { verification_data: { status: 'error', error_message: 'CNAME record not found' } } }));
  assert.match(broken.problems[0].message, /feedback\.riftborn\.us is "error" on riftborn-feedback \(CNAME record not found\)/);
  for (const status of ['pending', 'initializing', 'active']) assert.deepEqual((await run(fakeCloudflare({ status }))).problems, [], status);
  // No answer at all is a plain failure, not a permission.
  const offline = await run({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  assert.match(offline.problems[0].message, /Could not read the Pages project riftborn-feedback \(no answer: ENOTFOUND\)/);
  // The API helper masks the account id in every logged path.
  const lines = [];
  await cloudflareApi({ token: TOKEN, accountId: ACCOUNT, fetchImpl: fakeCloudflare().fetchImpl, log: line => lines.push(line) })('GET', `/accounts/${ACCOUNT}/pages/projects/${PROJECT}`);
  assert.deepEqual(lines, [`GET /accounts/<account>/pages/projects/${PROJECT} -> ok`]);
  // One domain's problem never stops another's (each is reported on its own).
  const two = await connectDomains({ env, domains: [{ project: PROJECT, host: HOST }, { project: PROJECT, host: HOST }], fetchImpl: fakeCloudflare({ deny: ['addRecord'] }).fetchImpl, log: () => {} });
  assert.equal(two.problems.length, 2);
  const one = await connectDomain({ project: PROJECT, host: HOST }, { call: cloudflareApi({ token: TOKEN, accountId: ACCOUNT, fetchImpl: fakeCloudflare().fetchImpl }), accountId: ACCOUNT });
  assert.equal(one.domain, 'added');
}
console.log('PASS refusals: a record that is not ours is never changed; each missing token permission is named exactly (Pages Edit, Zone Read, DNS Edit); a project not deployed yet, a broken domain and no answer are clear failures; pending passes.');

// The read-only Web Analytics state check has its own file, run with these tests (npm test runs this
// file; package.json is left alone because cloudflare-worker.yml redeploys the Worker on any change to it).
await import('./cloudflare-web-analytics.mjs');
