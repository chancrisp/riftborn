import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCOUNT_API = 'https://api.cloudflare.com/client/v4/accounts';
const WORKER_NAME = 'riftborn-leaderboard';
// Riftborn accounts (v2.2): optional OAuth app credentials and the HMAC signing key. Each is bound
// as a secret only when set; a provider without both its ID and secret is simply unavailable.
// Never bind FAKE_OAUTH here: the fake provider is for the local harness only.
// [option, Worker binding, environment variable]. GitHub Actions forbids secret names starting
// with GITHUB_, so the GitHub OAuth app's credentials arrive as GH_CLIENT_ID/_SECRET.
export const ACCOUNT_SECRETS = Object.freeze([
  ['googleClientId', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID'], ['googleClientSecret', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'],
  ['discordClientId', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_ID'], ['discordClientSecret', 'DISCORD_CLIENT_SECRET', 'DISCORD_CLIENT_SECRET'],
  ['githubClientId', 'GITHUB_CLIENT_ID', 'GH_CLIENT_ID'], ['githubClientSecret', 'GITHUB_CLIENT_SECRET', 'GH_CLIENT_SECRET'],
  ['authSigningKey', 'AUTH_SIGNING_KEY', 'AUTH_SIGNING_KEY'],
]);

/** Build multipart metadata for the documented Workers Script Upload API. */
export function createWorkerUpload(bundle, { databaseId, siteOrigin, feedbackAdminKey, discordWebhookUrl, ...accountSecrets }) {
  if (!/^[0-9a-f-]{36}$/i.test(databaseId || '')) throw new Error('Set CLOUDFLARE_D1_DATABASE_ID to the D1 database UUID.');
  const origin = new URL(siteOrigin || '');
  if (!/^https?:$/.test(origin.protocol) || origin.origin !== siteOrigin) {
    throw new Error('RIFTBORN_SITE_ORIGIN must be an exact http(s) origin without a path.');
  }

  const metadata = {
    main_module: 'riftborn-worker.mjs',
    compatibility_date: '2026-09-28',
    workers_dev: true,
    observability: { enabled: true },
    bindings: [
      // The dashboard bootstraps DB once; inheriting its binding avoids Cloudflare's
      // current API bug that rejects this visible D1 ID on script uploads.
      { type: 'inherit', name: 'DB' },
      { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
      { type: 'plain_text', name: 'ALLOWED_ORIGINS', text: origin.origin },
      {
        type: 'ratelimit',
        name: 'SCORE_RATE_LIMITER',
        namespace_id: '9280928',
        simple: { limit: 30, period: 60 },
      },
      {
        type: 'ratelimit',
        name: 'FEEDBACK_RATE_LIMITER',
        namespace_id: '7451062',
        simple: { limit: 3, period: 60 },
      },
    ],
  };
  // Optional secrets: bound only when set, so a deploy without them still succeeds (the
  // feedback inbox then answers 503 and the Discord ping is skipped).
  const adminKey = (feedbackAdminKey || '').trim();
  if (adminKey) metadata.bindings.push({ type: 'secret_text', name: 'FEEDBACK_ADMIN_KEY', text: adminKey });
  const webhook = (discordWebhookUrl || '').trim();
  if (webhook) {
    if (!/^https:\/\//i.test(webhook)) throw new Error('DISCORD_WEBHOOK_URL must be an https:// URL.');
    metadata.bindings.push({ type: 'secret_text', name: 'DISCORD_WEBHOOK_URL', text: webhook });
  }
  for (const [option, name] of ACCOUNT_SECRETS) {
    const value = String(accountSecrets[option] ?? '').trim();
    if (!value) continue;
    if (name === 'AUTH_SIGNING_KEY' && value.length < 32) throw new Error('AUTH_SIGNING_KEY must be at least 32 characters (use 32+ random bytes).');
    metadata.bindings.push({ type: 'secret_text', name, text: value });
  }

  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.set('riftborn-worker.mjs', new Blob([bundle], { type: 'application/javascript+module' }), 'riftborn-worker.mjs');
  return form;
}

export async function deployWorker({ accountId, apiToken, databaseId, siteOrigin, feedbackAdminKey, discordWebhookUrl, fetchImpl = fetch, ...accountSecrets }) {
  if (!/^[0-9a-f]{32}$/i.test(accountId || '')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID to the Cloudflare account ID.');
  if (!apiToken) throw new Error('Set the CLOUDFLARE_API_TOKEN GitHub secret.');

  const result = await build({
    entryPoints: ['cloudflare/worker.js'],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    minify: true,
  });
  const form = createWorkerUpload(result.outputFiles[0].text, { databaseId, siteOrigin, feedbackAdminKey, discordWebhookUrl, ...accountSecrets });
  const response = await fetchImpl(`${ACCOUNT_API}/${accountId}/workers/scripts/${WORKER_NAME}?bindings_inherit=strict`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}` },
    body: form,
  });
  const body = await response.json();
  if (!response.ok || body.success !== true) {
    const details = (body.errors || []).map(error => `${error.code}: ${error.message}`).join('\n');
    throw new Error(`Cloudflare Worker upload failed (${response.status})${details ? `:\n${details}` : '.'}`);
  }
  return body.result;
}

async function main() {
  const result = await deployWorker({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    siteOrigin: process.env.RIFTBORN_SITE_ORIGIN,
    feedbackAdminKey: process.env.FEEDBACK_ADMIN_KEY,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    ...Object.fromEntries(ACCOUNT_SECRETS.map(([option, , envName]) => [option, process.env[envName]])),
  });
  console.log(`Deployed ${WORKER_NAME}; version ${result?.id || 'created'}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
