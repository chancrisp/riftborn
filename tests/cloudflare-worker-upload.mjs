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
assert.ok(metadata.bindings.some(binding => binding.type === 'plain_text' && binding.name === 'ALLOWED_ORIGINS' && binding.text === siteOrigin));
assert.ok(metadata.bindings.some(binding => binding.type === 'ratelimit' && binding.name === 'SCORE_RATE_LIMITER' && binding.namespace_id === '9280928'));
assert.ok(metadata.bindings.some(binding => binding.type === 'ratelimit' && binding.name === 'FEEDBACK_RATE_LIMITER' &&
  binding.namespace_id !== '9280928' && binding.simple.limit === 3 && binding.simple.period === 60), 'Feedback has its own tight rate limit');
assert.ok(!metadata.bindings.some(binding => binding.type === 'secret_text'), 'Unset feedback secrets are not bound (deploys still work without them)');
assert.equal(await payload.get('riftborn-worker.mjs').text(), 'export default {}');

const withSecrets = uploadModule.createWorkerUpload('export default {}', { databaseId, siteOrigin, feedbackAdminKey: ' admin-key ', discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc' });
const secretBindings = JSON.parse(await withSecrets.get('metadata').text()).bindings.filter(binding => binding.type === 'secret_text');
assert.deepEqual(secretBindings.map(binding => [binding.name, binding.text]), [['FEEDBACK_ADMIN_KEY', 'admin-key'], ['DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/1/abc']]);
const onlyKey = JSON.parse(await uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, feedbackAdminKey: 'k', discordWebhookUrl: '' }).get('metadata').text());
assert.deepEqual(onlyKey.bindings.filter(binding => binding.type === 'secret_text').map(binding => binding.name), ['FEEDBACK_ADMIN_KEY']);
assert.throws(() => uploadModule.createWorkerUpload('x', { databaseId, siteOrigin, discordWebhookUrl: 'http://insecure.example/hook' }), /https/);

let uploadRequest;
const deployed = await uploadModule.deployWorker({
  accountId: '11b52fbbac31279b554fa9490c667017',
  apiToken: 'test-token',
  databaseId,
  siteOrigin,
  feedbackAdminKey: 'deploy-key',
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
for (const path of ['server/accounts-api.js', 'server/username-rules.js']) assert.ok(workflow.includes(`- '${path}'`), 'The workflow redeploys on ' + path);
const wrangler = fs.readFileSync('cloudflare/wrangler.jsonc', 'utf8');
assert.match(wrangler, /"ENVIRONMENT":\s*"production"/, 'wrangler.jsonc also deploys as production');
assert.ok(!/FAKE_OAUTH/.test(wrangler + workflow), 'FAKE_OAUTH never reaches a deployed configuration');

console.log('PASS Cloudflare Worker upload: entry module, D1, production origin, and score rate limit, feedback rate limit and optional feedback secrets, optional account secrets.');
