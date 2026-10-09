import assert from 'node:assert/strict';
import fs from 'node:fs';

const uploadModule = await import('../scripts/cloudflare-worker-upload.mjs').catch(() => null);
assert.ok(uploadModule, 'Worker upload helper must exist');

const databaseId = '94cc84a1-1df9-4199-910e-a6b1f3910dff';
const siteOrigin = 'https://chancrisp.github.io';
const payload = uploadModule.createWorkerUpload('export default {}', { databaseId, siteOrigin });
const metadata = JSON.parse(await payload.get('metadata').text());

assert.equal(metadata.main_module, 'riftborn-worker.mjs');
assert.equal(metadata.workers_dev, true);
assert.ok(metadata.bindings.some(binding => binding.type === 'inherit' && binding.name === 'DB'));
assert.ok(!JSON.stringify(metadata.bindings).includes(databaseId), 'The broken D1 ID is not resubmitted during deployment');
assert.ok(metadata.bindings.some(binding => binding.type === 'plain_text' && binding.name === 'ENVIRONMENT' && binding.text === 'production'));
// CORS: riftborn.us, dev.riftborn.us and the GitHub Pages origin always (site.hosts.mjs); the
// RIFTBORN_SITE_ORIGIN variable is optional and may add more (one origin or a comma list).
const SITE_ORIGINS = 'https://riftborn.us,https://dev.riftborn.us,https://chancrisp.github.io';
const originsOf = meta => meta.bindings.find(binding => binding.type === 'plain_text' && binding.name === 'ALLOWED_ORIGINS')?.text;
assert.equal(originsOf(metadata), SITE_ORIGINS, 'The legacy origin given as the variable is not repeated');
assert.ok(metadata.bindings.some(binding => binding.type === 'plain_text' && binding.name === 'AUTH_PUBLIC_BASE' && binding.text === 'https://api.riftborn.us'), 'Sign-in runs on api.riftborn.us');
assert.equal(uploadModule.allowedOrigins('').join(','), SITE_ORIGINS, 'The variable is optional');
assert.equal(uploadModule.allowedOrigins(undefined).join(','), SITE_ORIGINS);
assert.equal(uploadModule.allowedOrigins(' https://preview.example , https://riftborn.us ').join(','), SITE_ORIGINS + ',https://preview.example', 'A comma list adds origins');
for (const bad of ['https://riftborn.us/', 'https://riftborn.us/game', 'riftborn.us', 'ftp://riftborn.us', 'https://riftborn.us,nope']) {
  assert.throws(() => uploadModule.allowedOrigins(bad), /RIFTBORN_SITE_ORIGIN/, 'Refused: ' + bad);
}
// Read-only score origins (v2.3.1): dev.riftborn.us reads the leaderboard but never writes it. One
// list (site.hosts.mjs), bound as SCORE_READ_ONLY_ORIGINS whatever RIFTBORN_SITE_ORIGIN says, each
// one also a CORS origin (the list only narrows ALLOWED_ORIGINS).
const READ_ONLY = 'https://dev.riftborn.us';
const readOnlyOf = meta => meta.bindings.find(binding => binding.type === 'plain_text' && binding.name === 'SCORE_READ_ONLY_ORIGINS')?.text;
{
  const { SCORE_READ_ONLY_ORIGINS, WORKER_ALLOWED_ORIGINS } = await import('../site.hosts.mjs');
  assert.equal(SCORE_READ_ONLY_ORIGINS.join(','), READ_ONLY, 'site.hosts.mjs: the test build is read only');
  assert.ok(SCORE_READ_ONLY_ORIGINS.every(origin => WORKER_ALLOWED_ORIGINS.includes(origin)), 'Each read-only origin is a CORS origin');
  assert.equal((await import('../site.config.mjs')).SCORE_READ_ONLY_ORIGINS, SCORE_READ_ONLY_ORIGINS, 'site.config.mjs re-exports it');
  assert.equal(readOnlyOf(metadata), READ_ONLY, 'The upload binds the read-only list');
  const extra = JSON.parse(await uploadModule.createWorkerUpload('x', { databaseId, siteOrigin: 'https://dev.riftborn.us,https://preview.example' }).get('metadata').text());
  assert.equal(readOnlyOf(extra), READ_ONLY, 'RIFTBORN_SITE_ORIGIN never changes the read-only list');
}
{
  // The deployed Worker answers CORS for each site origin on scores, feedback and accounts, and for nobody else.
  const worker = (await import('../cloudflare/worker.js')).default;
  const env = { ENVIRONMENT: 'production', ALLOWED_ORIGINS: originsOf(metadata), SCORE_READ_ONLY_ORIGINS: readOnlyOf(metadata) };
  for (const path of ['/api/scores', '/api/feedback', '/api/account']) {
    for (const origin of SITE_ORIGINS.split(',')) {
      const response = await worker.fetch(new Request('https://api.riftborn.us' + path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } }), env, { waitUntil() {} });
      assert.equal(response.status, 204, `${path} preflight from ${origin}`);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      // Score writes: offered to every site origin but the read-only one (accounts and feedback: to all).
      const writes = path !== '/api/scores' || origin !== READ_ONLY;
      assert.equal(/POST/.test(response.headers.get('Access-Control-Allow-Methods')), writes, `${path} preflight from ${origin} ${writes ? 'offers' : 'withholds'} POST`);
    }
    const evil = await worker.fetch(new Request('https://api.riftborn.us' + path, { method: 'OPTIONS', headers: { Origin: 'https://riftborn.us.evil.example', 'Access-Control-Request-Method': 'POST' } }), env, { waitUntil() {} });
    assert.equal(evil.status, 403, `${path} refuses other origins`);
  }
}
// Feedback admin origins (the inbox moved to feedback.riftborn.us): one list (site.hosts.mjs), bound as
// FEEDBACK_ADMIN_ORIGINS whatever RIFTBORN_SITE_ORIGIN says, the same in wrangler.jsonc. The new
// inbox origin is admin only: never a CORS origin for scores, accounts or player feedback.
const INBOX = 'https://feedback.riftborn.us';
const ADMIN = `${INBOX},https://chancrisp.github.io`;
const adminOf = meta => meta.bindings.find(binding => binding.type === 'plain_text' && binding.name === 'FEEDBACK_ADMIN_ORIGINS')?.text;
{
  const { FEEDBACK_ADMIN_ORIGINS, WORKER_ALLOWED_ORIGINS, SCORE_READ_ONLY_ORIGINS, HOSTS } = await import('../site.hosts.mjs');
  assert.equal(FEEDBACK_ADMIN_ORIGINS.join(','), ADMIN, 'site.hosts.mjs: the inbox and its old github.io copy');
  assert.equal(HOSTS.feedback, INBOX);
  assert.ok(!WORKER_ALLOWED_ORIGINS.includes(INBOX) && !SCORE_READ_ONLY_ORIGINS.includes(INBOX), 'feedback.riftborn.us is in no other list');
  assert.ok(WORKER_ALLOWED_ORIGINS.includes(HOSTS.legacyOrigin), 'The github.io copy keeps everything it had until GitHub Pages is shut down');
  assert.equal((await import('../site.config.mjs')).FEEDBACK_ADMIN_ORIGINS, FEEDBACK_ADMIN_ORIGINS, 'site.config.mjs re-exports it');
  assert.equal(adminOf(metadata), ADMIN, 'The upload binds the admin list');
  const extra = JSON.parse(await uploadModule.createWorkerUpload('x', { databaseId, siteOrigin: 'https://preview.example' }).get('metadata').text());
  assert.equal(adminOf(extra), ADMIN, 'RIFTBORN_SITE_ORIGIN never changes the admin list');
  assert.equal(originsOf(extra), SITE_ORIGINS + ',https://preview.example', 'and the admin list never reaches ALLOWED_ORIGINS');
  // ...nor can the variable put it there: feedback.riftborn.us in ALLOWED_ORIGINS would stop being
  // admin only (scores, accounts and player feedback would answer it), so the deploy refuses.
  for (const value of [INBOX, `https://preview.example,${INBOX}`, ` ${INBOX} `]) {
    assert.throws(() => uploadModule.allowedOrigins(value), /RIFTBORN_SITE_ORIGIN cannot add https:\/\/feedback\.riftborn\.us: it is admin only/, 'Refused: ' + value);
    assert.throws(() => uploadModule.createWorkerUpload('x', { databaseId, siteOrigin: value }), /admin only/, 'No upload with it: ' + value);
  }
  assert.equal(uploadModule.allowedOrigins(HOSTS.legacyOrigin).join(','), SITE_ORIGINS, 'An origin in both lists (github.io) is still fine');
  assert.equal(JSON.parse(fs.readFileSync('cloudflare/wrangler.jsonc', 'utf8')).vars.FEEDBACK_ADMIN_ORIGINS, ADMIN, 'wrangler.jsonc lists the same admin origins');
}
{
  // The deployed Worker with these bindings: the inbox's own requests pass their preflight (with
  // Authorization), and nothing else from feedback.riftborn.us does.
  const worker = (await import('../cloudflare/worker.js')).default;
  const env = { ENVIRONMENT: 'production', ALLOWED_ORIGINS: originsOf(metadata), SCORE_READ_ONLY_ORIGINS: readOnlyOf(metadata), FEEDBACK_ADMIN_ORIGINS: adminOf(metadata) };
  const send = (path, init) => worker.fetch(new Request('https://api.riftborn.us' + path, init), env, { waitUntil() {} });
  const preflight = (path, method, requestHeaders, origin = INBOX) => send(path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, ...(requestHeaders ? { 'Access-Control-Request-Headers': requestHeaders } : {}) } });
  // What feedback/inbox.js sends: GET list and CSV with Authorization, PATCH with Authorization + JSON.
  for (const [path, method, requestHeaders, methods, allowHeaders] of [
    ['/api/feedback?status=active&limit=50', 'GET', 'authorization', 'GET, OPTIONS', 'Authorization'],
    ['/api/feedback.csv?status=active', 'GET', 'authorization', 'GET, OPTIONS', 'Authorization'],
    ['/api/feedback/11111111-1111-4111-8111-111111111111', 'PATCH', 'authorization,content-type', 'PATCH, OPTIONS', 'Content-Type, Authorization']
  ]) {
    const response = await preflight(path, method, requestHeaders);
    assert.equal(response.status, 204, `the inbox's ${method} ${path} passes its preflight`);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), INBOX);
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), methods, 'only the admin method: ' + path);
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), allowHeaders);
  }
  // Player feedback: refused before any work (this env has no database or limiter: reaching them would be a 503).
  const submit = await send('/api/feedback', { method: 'POST', headers: { Origin: INBOX, 'Content-Type': 'application/json' }, body: '{"category":"bug","message":"posted from the inbox origin"}' });
  assert.equal(submit.status, 403, 'feedback.riftborn.us never submits player feedback');
  assert.equal(submit.headers.get('Access-Control-Allow-Origin'), INBOX, 'and can read why');
  // Scores and accounts: refused like any unknown origin.
  for (const path of ['/api/scores', '/api/account', '/api/profile', '/auth/session', '/api/auth/providers']) {
    for (const method of ['GET', 'POST']) assert.equal((await preflight(path, method, 'content-type')).status, 403, `${path} ${method} preflight from feedback.riftborn.us`);
    const direct = await send(path, { method: 'GET', headers: { Origin: INBOX } });
    assert.equal(direct.status, 403, `${path} from feedback.riftborn.us`);
    assert.equal(direct.headers.get('Access-Control-Allow-Origin'), null);
  }
  // The github.io copy keeps the full feedback preflight; the old Worker (no admin list) refuses the new origin.
  assert.match((await preflight('/api/feedback', 'POST', 'content-type', 'https://chancrisp.github.io')).headers.get('Access-Control-Allow-Methods'), /POST/);
  const old = await worker.fetch(new Request('https://api.riftborn.us/api/feedback', { method: 'OPTIONS', headers: { Origin: INBOX, 'Access-Control-Request-Method': 'GET' } }), { ...env, FEEDBACK_ADMIN_ORIGINS: undefined }, { waitUntil() {} });
  assert.equal(old.status, 403, 'Before this Worker deploys, feedback.riftborn.us gets 403 (the inbox there needs it)');
}
assert.ok(metadata.bindings.some(binding => binding.type === 'ratelimit' && binding.name === 'SCORE_RATE_LIMITER' && binding.namespace_id === '9280928'));
assert.ok(metadata.bindings.some(binding => binding.type === 'ratelimit' && binding.name === 'FEEDBACK_RATE_LIMITER' &&
  binding.namespace_id !== '9280928' && binding.simple.limit === 3 && binding.simple.period === 60), 'Feedback has its own tight rate limit');
assert.ok(!metadata.bindings.some(binding => binding.type === 'secret_text'), 'Unset feedback secrets are not bound (deploys still work without them)');
assert.equal(await payload.get('riftborn-worker.mjs').text(), 'export default {}');

const quiet = () => {}; // short fixture keys below only warn (FEEDBACK_KEY_STRICT unset)
const withSecrets = uploadModule.createWorkerUpload('export default {}', { databaseId, siteOrigin, feedbackAdminKey: ' admin-key ', discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc', warn: quiet });
const secretBindings = JSON.parse(await withSecrets.get('metadata').text()).bindings.filter(binding => binding.type === 'secret_text');
assert.deepEqual(secretBindings.map(binding => [binding.name, binding.text]), [['FEEDBACK_ADMIN_KEY', 'admin-key'], ['DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/1/abc']]);
const onlyKey = JSON.parse(await uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, feedbackAdminKey: 'k', discordWebhookUrl: '', warn: quiet }).get('metadata').text());
assert.deepEqual(onlyKey.bindings.filter(binding => binding.type === 'secret_text').map(binding => binding.name), ['FEEDBACK_ADMIN_KEY']);
assert.throws(() => uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, discordWebhookUrl: 'http://insecure.example/hook' }), /https/);

let uploadRequest;
const deployed = await uploadModule.deployWorker({
  accountId: '11b52fbbac31279b554fa9490c667017',
  apiToken: 'test-token',
  databaseId,
  siteOrigin,
  feedbackAdminKey: 'deploy-key',
  warn: quiet,
  fetchImpl: async (url, init) => {
    uploadRequest = { url, ...init };
    return new Response(JSON.stringify({ success: true, result: { id: 'test-version' } }), { status: 200 });
  },
});
assert.equal(deployed.id, 'test-version');
assert.equal(uploadRequest.url, 'https://api.cloudflare.com/client/v4/accounts/11b52fbbac31279b554fa9490c667017/workers/scripts/riftborn-leaderboard?bindings_inherit=strict');
assert.equal(uploadRequest.method, 'PUT');
assert.equal(uploadRequest.headers.Authorization, 'Bearer test-token');
assert.match(await uploadRequest.body.get('riftborn-worker.mjs').text(), /\/api\/scores/);
assert.match(await uploadRequest.body.get('riftborn-worker.mjs').text(), /\/api\/feedback/, 'The bundled Worker serves the feedback route');
assert.ok(JSON.parse(await uploadRequest.body.get('metadata').text()).bindings.some(binding => binding.name === 'FEEDBACK_ADMIN_KEY' && binding.text === 'deploy-key'));

assert.match(await uploadRequest.body.get('riftborn-worker.mjs').text(), /\/api\/account/, 'The bundled Worker serves the accounts routes');

// Riftborn accounts (v2.2): OAuth credentials and the signing key are secrets, bound only when set.
assert.ok(!metadata.bindings.some(binding => binding.name === 'FAKE_OAUTH'), 'The fake provider is never enabled on the deployed Worker');
const accountSecrets = {
  googleClientId: 'g-id', googleClientSecret: 'g-secret', discordClientId: 'd-id', discordClientSecret: 'd-secret',
  githubClientId: 'h-id', githubClientSecret: ' h-secret ', authSigningKey: 'k'.repeat(43)
};
const withAccounts = JSON.parse(await uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, ...accountSecrets }).get('metadata').text());
assert.deepEqual(withAccounts.bindings.filter(binding => binding.type === 'secret_text').map(binding => [binding.name, binding.text]), [
  ['GOOGLE_CLIENT_ID', 'g-id'], ['GOOGLE_CLIENT_SECRET', 'g-secret'], ['DISCORD_CLIENT_ID', 'd-id'], ['DISCORD_CLIENT_SECRET', 'd-secret'],
  ['GITHUB_CLIENT_ID', 'h-id'], ['GITHUB_CLIENT_SECRET', 'h-secret'], ['AUTH_SIGNING_KEY', 'k'.repeat(43)]
]);
assert.ok(withAccounts.bindings.some(binding => binding.type === 'plain_text' && binding.name === 'ENVIRONMENT' && binding.text === 'production'), 'Accounts deploy as production');
assert.ok(!withAccounts.bindings.some(binding => binding.name === 'FAKE_OAUTH'));
const partial = JSON.parse(await uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, googleClientId: 'g-id', discordClientSecret: '  ' }).get('metadata').text());
assert.deepEqual(partial.bindings.filter(binding => binding.type === 'secret_text').map(binding => binding.name), ['GOOGLE_CLIENT_ID'], 'Unset or blank secrets are not bound');
assert.throws(() => uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, authSigningKey: 'too-short' }), /AUTH_SIGNING_KEY/);
// GitHub Actions forbids secret names starting with GITHUB_: the GitHub app arrives as GH_CLIENT_*.
assert.deepEqual(uploadModule.ACCOUNT_SECRETS.map(([, binding, envName]) => [binding, envName]).filter(([binding]) => binding.startsWith('GITHUB_')),
  [['GITHUB_CLIENT_ID', 'GH_CLIENT_ID'], ['GITHUB_CLIENT_SECRET', 'GH_CLIENT_SECRET']]);
assert.ok(uploadModule.ACCOUNT_SECRETS.every(([, , envName]) => !envName.startsWith('GITHUB_')));
const workflow = fs.readFileSync('.github/workflows/cloudflare-worker.yml', 'utf8');
for (const [, , envName] of uploadModule.ACCOUNT_SECRETS) assert.ok(workflow.includes(`${envName}: \${{ secrets.${envName} }}`), 'The workflow passes ' + envName);
for (const path of ['server/accounts-api.js', 'server/username-rules.js', 'server/admin-auth.js']) assert.ok(workflow.includes(`- '${path}'`), 'The workflow redeploys on ' + path);
// Key rotation: the previous key is an optional secret with the same length rule; ACCOUNTS_LIVE=1
// refuses a deploy that would drop AUTH_SIGNING_KEY.
const rotated = JSON.parse(await uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, authSigningKey: 'n'.repeat(43), authSigningKeyPrevious: ' ' + 'o'.repeat(43) + ' ' }).get('metadata').text());
assert.deepEqual(rotated.bindings.filter(binding => binding.type === 'secret_text').map(binding => [binding.name, binding.text]),
  [['AUTH_SIGNING_KEY', 'n'.repeat(43)], ['AUTH_SIGNING_KEY_PREVIOUS', 'o'.repeat(43)]]);
assert.throws(() => uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, authSigningKey: 'n'.repeat(43), authSigningKeyPrevious: 'short' }), /AUTH_SIGNING_KEY_PREVIOUS/);
assert.throws(() => uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, accountsLive: '1' }), /ACCOUNTS_LIVE=1/, 'Live accounts need the signing key');
assert.throws(() => uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, accountsLive: '1', authSigningKey: '   ' }), /ACCOUNTS_LIVE=1/);
assert.ok(uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, accountsLive: '1', authSigningKey: 'k'.repeat(43) }), 'Live with the key deploys');
assert.ok(uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, accountsLive: '' }), 'Not live yet: the key stays optional');
assert.ok(workflow.includes('ACCOUNTS_LIVE: ${{ vars.ACCOUNTS_LIVE }}'), 'The workflow passes the ACCOUNTS_LIVE repository variable');

// The accounts per-IP limiter binding matches what the Worker assumes, with its own namespace.
const { IP_BINDING_LIMIT } = await import('../server/accounts-api.js');
const limiter = metadata.bindings.find(binding => binding.name === 'ACCOUNTS_RATE_LIMITER');
assert.ok(limiter && limiter.type === 'ratelimit', 'The accounts rate limiter is bound');
assert.deepEqual(limiter.simple, IP_BINDING_LIMIT);
assert.equal(new Set(metadata.bindings.filter(binding => binding.type === 'ratelimit').map(binding => binding.namespace_id)).size, 3, 'Each limiter has its own namespace');

const wrangler = fs.readFileSync('cloudflare/wrangler.jsonc', 'utf8');
assert.deepEqual(JSON.parse(wrangler).ratelimits.find(item => item.name === 'ACCOUNTS_RATE_LIMITER'),
  { name: 'ACCOUNTS_RATE_LIMITER', namespace_id: limiter.namespace_id, simple: IP_BINDING_LIMIT }, 'wrangler.jsonc binds the same limiter');
assert.match(wrangler, /"ENVIRONMENT":\s*"production"/, 'wrangler.jsonc also deploys as production');
assert.equal(JSON.parse(wrangler).vars.ALLOWED_ORIGINS, SITE_ORIGINS, 'wrangler.jsonc lists the same CORS origins');
assert.equal(JSON.parse(wrangler).vars.SCORE_READ_ONLY_ORIGINS, readOnlyOf(metadata), 'wrangler.jsonc lists the same read-only score origins');
assert.equal(JSON.parse(wrangler).vars.AUTH_PUBLIC_BASE, 'https://api.riftborn.us');
assert.deepEqual(JSON.parse(wrangler).routes, [{ pattern: 'api.riftborn.us', custom_domain: true }], 'wrangler.jsonc documents the api.riftborn.us custom domain');
assert.ok(workflow.includes("- 'site.hosts.mjs'"), 'The Worker redeploys when the hosts change');
{
  // The Worker redeploys when (and only when) one of its inputs changes: every repository file the
  // bundle reads is in the workflow's path filter, and the launch switch (site.config.mjs, LAUNCHED)
  // is neither an input nor in the filter, so flipping it never re-uploads the Worker.
  const { build } = await import('esbuild');
  const bundled = await build({ entryPoints: ['cloudflare/worker.js'], bundle: true, write: false, format: 'esm', target: 'es2022', metafile: true, logLevel: 'silent' });
  const inputs = Object.keys(bundled.metafile.inputs).filter(file => !file.startsWith('node_modules/'));
  const filters = [...workflow.replace(/\r\n/g, '\n').matchAll(/^ {6}- '([^']+)'$/gm)].map(match => match[1]);
  const covered = file => filters.some(filter => filter === file || (filter.endsWith('/**') && file.startsWith(filter.slice(0, -2))));
  for (const file of inputs) assert.ok(covered(file), 'The Worker path filter covers its input ' + file);
  assert.ok(inputs.includes('site.hosts.mjs'), 'The Worker reads its hosts from site.hosts.mjs');
  assert.ok(!inputs.includes('site.config.mjs') && !filters.includes('site.config.mjs'), 'LAUNCHED (site.config.mjs) never redeploys the Worker');
}
assert.ok(!/FAKE_OAUTH/.test(wrangler + workflow), 'FAKE_OAUTH never reaches a deployed configuration');

// Security fixes (2.2 review): only main deploys the production Worker, and the feedback admin key
// has a minimum length (refused with FEEDBACK_KEY_STRICT=1, a loud warning otherwise).
{
  const { workerDeployRefusals, FEEDBACK_ADMIN_KEY_MIN } = uploadModule;
  assert.deepEqual(workerDeployRefusals({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' }), []);
  assert.match(workerDeployRefusals({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/v2.2' }).join(), /Refusing to deploy refs\/heads\/v2\.2 to the production Worker/);
  assert.match(workerDeployRefusals({ CI: 'true' }).join(), /Refusing to deploy an unknown ref/);
  assert.deepEqual(workerDeployRefusals({}), [], 'Local runs are not CI');
  const flow = workflow.replace(/\r\n/g, '\n');
  assert.match(flow, /\n  deploy:\n(    #.*\n)*    if: github\.ref == 'refs\/heads\/main'\n/, 'The Worker job runs only on main');
  assert.ok(flow.includes('FEEDBACK_KEY_STRICT: ${{ vars.FEEDBACK_KEY_STRICT }}'), 'The workflow passes FEEDBACK_KEY_STRICT');
  const source = fs.readFileSync('scripts/cloudflare-worker-upload.mjs', 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/async function main\(\) \{\n  const refusals = workerDeployRefusals\(process\.env\);\n  if \(refusals\.length\) throw/.test(source), 'main() checks the ref before deploying');
  assert.equal(FEEDBACK_ADMIN_KEY_MIN, 24);
  const warnings = [];
  const warn = message => warnings.push(message);
  const short = 'x'.repeat(FEEDBACK_ADMIN_KEY_MIN - 1), long = 'y'.repeat(FEEDBACK_ADMIN_KEY_MIN);
  assert.ok(uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, feedbackAdminKey: short, warn }), 'Not strict: a short key still deploys');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WARNING: FEEDBACK_ADMIN_KEY is 23 characters; use at least 24/);
  assert.ok(!warnings[0].includes(short), 'The warning never prints the key');
  uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, feedbackAdminKey: long, warn });
  uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, warn });
  assert.equal(warnings.length, 1, 'No warning for a long key or no key');
  assert.throws(() => uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, feedbackAdminKey: short, feedbackKeyStrict: '1', warn }), /FEEDBACK_KEY_STRICT=1/);
  assert.ok(uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, feedbackAdminKey: long, feedbackKeyStrict: '1', warn }), 'Strict with a long key deploys');
}

console.log('PASS Cloudflare Worker upload: entry module, D1, production origin, and score rate limit, feedback rate limit and optional feedback secrets, optional account secrets, previous signing key, ACCOUNTS_LIVE guard, accounts rate limiter, main-only deploys, admin key length, read-only score origins (site.hosts.mjs = upload = wrangler.jsonc, dev preflight offers no score write), feedback admin origins (feedback.riftborn.us: only the inbox admin preflights; scores, accounts and player feedback refused; RIFTBORN_SITE_ORIGIN cannot add it to ALLOWED_ORIGINS).');
