import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUTH_PUBLIC_BASE, SCORE_READ_ONLY_ORIGINS, WORKER_ALLOWED_ORIGINS } from '../site.hosts.mjs';

const ACCOUNT_API = 'https://api.cloudflare.com/client/v4/accounts';
const WORKER_NAME = 'riftborn-leaderboard';
// Riftborn accounts (v2.2): optional OAuth app credentials, the HMAC signing key and, after a key
// rotation, the previous key (only tried for lookups, so players signed up under it keep their
// accounts). Each is bound as a secret only when set; a provider without both its ID and secret is
// simply unavailable. Once accounts are live (repository variable ACCOUNTS_LIVE=1) a deploy without
// AUTH_SIGNING_KEY fails instead of switching accounts off.
// Never bind FAKE_OAUTH here: the fake providers are for the local harness only.
// [option, Worker binding, environment variable]. GitHub Actions forbids secret names starting
// with GITHUB_, so the GitHub OAuth app's credentials arrive as GH_CLIENT_ID/_SECRET.
export const ACCOUNT_SECRETS = Object.freeze([
  ['googleClientId', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID'], ['googleClientSecret', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'],
  ['discordClientId', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_ID'], ['discordClientSecret', 'DISCORD_CLIENT_SECRET', 'DISCORD_CLIENT_SECRET'],
  ['githubClientId', 'GITHUB_CLIENT_ID', 'GH_CLIENT_ID'], ['githubClientSecret', 'GITHUB_CLIENT_SECRET', 'GH_CLIENT_SECRET'],
  ['authSigningKey', 'AUTH_SIGNING_KEY', 'AUTH_SIGNING_KEY'],
  ['authSigningKeyPrevious', 'AUTH_SIGNING_KEY_PREVIOUS', 'AUTH_SIGNING_KEY_PREVIOUS'],
]);
const SIGNING_KEYS = Object.freeze(['AUTH_SIGNING_KEY', 'AUTH_SIGNING_KEY_PREVIOUS']);
// The accounts per-IP limiter (server/accounts-api.js IP_BINDING_LIMIT): no D1 write per request.
// The feedback admin routes use it too, under their own key (server/feedback-api.js limitAdmin).
export const ACCOUNTS_RATE_LIMITER = Object.freeze({ type: 'ratelimit', name: 'ACCOUNTS_RATE_LIMITER', namespace_id: '6184035', simple: { limit: 30, period: 60 } });

// The feedback inbox key guards every player message and contact line: a long random value, not a
// word. Shorter keys are refused when the repository variable FEEDBACK_KEY_STRICT is 1, and warned
// about otherwise (so a deploy with today's key still goes through until it is rotated).
export const FEEDBACK_ADMIN_KEY_MIN = 24;
export const PRODUCTION_REF = 'refs/heads/main';

/** Why this environment must not deploy the production Worker ([] when it may): in CI only main deploys. */
export function workerDeployRefusals(env = process.env) {
  return (env.CI || env.GITHUB_ACTIONS) && env.GITHUB_REF !== PRODUCTION_REF
    ? [`Refusing to deploy ${env.GITHUB_REF || 'an unknown ref'} to the production Worker: only ${PRODUCTION_REF} deploys api.riftborn.us.`]
    : [];
}

/**
 * The browser origins the Worker answers (CORS): riftborn.us, dev.riftborn.us and the GitHub Pages
 * origin from site.hosts.mjs, plus any in RIFTBORN_SITE_ORIGIN (optional; one origin or a comma
 * list, each an exact http(s) origin without a path).
 */
export function allowedOrigins(siteOrigin) {
  const extra = String(siteOrigin ?? '').split(',').map(value => value.trim()).filter(Boolean);
  for (const value of extra) {
    let url = null;
    try { url = new URL(value); } catch { url = null; }
    if (!url || !/^https?:$/.test(url.protocol) || url.origin !== value) {
      throw new Error('RIFTBORN_SITE_ORIGIN must be exact http(s) origins without a path (comma-separated).');
    }
  }
  return [...new Set([...WORKER_ALLOWED_ORIGINS, ...extra])];
}

/** Build multipart metadata for the documented Workers Script Upload API. */
export function createWorkerUpload(bundle, { databaseId, siteOrigin, feedbackAdminKey, discordWebhookUrl, accountsLive, feedbackKeyStrict, warn = console.warn, ...accountSecrets }) {
  if (!/^[0-9a-f-]{36}$/i.test(databaseId || '')) throw new Error('Set CLOUDFLARE_D1_DATABASE_ID to the D1 database UUID.');
  const origins = allowedOrigins(siteOrigin);

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
      { type: 'plain_text', name: 'ALLOWED_ORIGINS', text: origins.join(',') },
      // dev.riftborn.us reads the leaderboard but never writes it (server/scores-api.js). Always
      // from site.hosts.mjs: RIFTBORN_SITE_ORIGIN can add origins but never lift this.
      { type: 'plain_text', name: 'SCORE_READ_ONLY_ORIGINS', text: SCORE_READ_ONLY_ORIGINS.join(',') },
      // Sign-in runs on this host only (server/accounts-api.js publicBase); callback URLs live there.
      { type: 'plain_text', name: 'AUTH_PUBLIC_BASE', text: AUTH_PUBLIC_BASE },
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
      { ...ACCOUNTS_RATE_LIMITER, simple: { ...ACCOUNTS_RATE_LIMITER.simple } },
    ],
  };
  // Optional secrets: bound only when set, so a deploy without them still succeeds (the
  // feedback inbox then answers 503 and the Discord ping is skipped).
  const adminKey = (feedbackAdminKey || '').trim();
  if (adminKey && adminKey.length < FEEDBACK_ADMIN_KEY_MIN) {
    const message = `FEEDBACK_ADMIN_KEY is ${adminKey.length} characters; use at least ${FEEDBACK_ADMIN_KEY_MIN} random characters ` +
      '(generate it like AUTH_SIGNING_KEY) and update the GitHub secret.';
    if (String(feedbackKeyStrict ?? '').trim() === '1') throw new Error(message + ' Refusing to deploy (FEEDBACK_KEY_STRICT=1).');
    warn('WARNING: ' + message + ' Set the repository variable FEEDBACK_KEY_STRICT=1 to refuse short keys.');
  }
  if (adminKey) metadata.bindings.push({ type: 'secret_text', name: 'FEEDBACK_ADMIN_KEY', text: adminKey });
  const webhook = (discordWebhookUrl || '').trim();
  if (webhook) {
    if (!/^https:\/\//i.test(webhook)) throw new Error('DISCORD_WEBHOOK_URL must be an https:// URL.');
    metadata.bindings.push({ type: 'secret_text', name: 'DISCORD_WEBHOOK_URL', text: webhook });
  }
  const live = String(accountsLive ?? '').trim() === '1';
  if (live && !String(accountSecrets.authSigningKey ?? '').trim()) {
    throw new Error('ACCOUNTS_LIVE=1 but the AUTH_SIGNING_KEY secret is empty: refusing to deploy (players would lose their accounts). Restore the secret.');
  }
  for (const [option, name] of ACCOUNT_SECRETS) {
    const value = String(accountSecrets[option] ?? '').trim();
    if (!value) continue;
    if (SIGNING_KEYS.includes(name) && value.length < 32) throw new Error(`${name} must be at least 32 characters (use 32+ random bytes).`);
    metadata.bindings.push({ type: 'secret_text', name, text: value });
  }

  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.set('riftborn-worker.mjs', new Blob([bundle], { type: 'application/javascript+module' }), 'riftborn-worker.mjs');
  return form;
}

export async function deployWorker({ accountId, apiToken, databaseId, siteOrigin, feedbackAdminKey, discordWebhookUrl, accountsLive, feedbackKeyStrict, warn, fetchImpl = fetch, ...accountSecrets }) {
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
  const form = createWorkerUpload(result.outputFiles[0].text, { databaseId, siteOrigin, feedbackAdminKey, discordWebhookUrl, accountsLive, feedbackKeyStrict, warn, ...accountSecrets });
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
  const refusals = workerDeployRefusals(process.env);
  if (refusals.length) throw new Error(refusals.join(' '));
  const result = await deployWorker({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    siteOrigin: process.env.RIFTBORN_SITE_ORIGIN,
    feedbackAdminKey: process.env.FEEDBACK_ADMIN_KEY,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    accountsLive: process.env.ACCOUNTS_LIVE,
    feedbackKeyStrict: process.env.FEEDBACK_KEY_STRICT,
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
