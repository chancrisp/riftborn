import assert from 'node:assert/strict';

const uploadModule = await import('../scripts/cloudflare-worker-upload.mjs').catch(() => null);
assert.ok(uploadModule, 'Worker upload helper must exist');

const databaseId = '94cc84a1-1df9-4199-910e-a6b1f3910dff';
const siteOrigin = 'https://chancrisp.github.io';
const payload = uploadModule.createWorkerUpload('export default {}', { databaseId, siteOrigin });
const metadata = JSON.parse(await payload.get('metadata').text());

assert.equal(metadata.main_module, 'riftborn-worker.mjs');
assert.equal(metadata.workers_dev, true);
assert.ok(metadata.bindings.some(binding => binding.type === 'd1' && binding.name === 'DB' && binding.database_id === databaseId));
assert.ok(metadata.bindings.some(binding => binding.type === 'plain_text' && binding.name === 'ENVIRONMENT' && binding.text === 'production'));
assert.ok(metadata.bindings.some(binding => binding.type === 'plain_text' && binding.name === 'ALLOWED_ORIGINS' && binding.text === siteOrigin));
assert.ok(metadata.bindings.some(binding => binding.type === 'ratelimit' && binding.name === 'SCORE_RATE_LIMITER' && binding.namespace_id === '9280928'));
assert.equal(await payload.get('riftborn-worker.mjs').text(), 'export default {}');

let uploadRequest;
const deployed = await uploadModule.deployWorker({
  accountId: '11b52fbbac31279b554fa9490c667017',
  apiToken: 'test-token',
  databaseId,
  siteOrigin,
  fetchImpl: async (url, init) => {
    uploadRequest = { url, ...init };
    return new Response(JSON.stringify({ success: true, result: { id: 'test-version' } }), { status: 200 });
  },
});
assert.equal(deployed.id, 'test-version');
assert.equal(uploadRequest.url, 'https://api.cloudflare.com/client/v4/accounts/11b52fbbac31279b554fa9490c667017/workers/scripts/riftborn-leaderboard');
assert.equal(uploadRequest.method, 'PUT');
assert.equal(uploadRequest.headers.Authorization, 'Bearer test-token');
assert.match(await uploadRequest.body.get('riftborn-worker.mjs').text(), /\/api\/scores/);

console.log('PASS Cloudflare Worker upload: entry module, D1, production origin, and score rate limit.');
