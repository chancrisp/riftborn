import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCOUNT_API = 'https://api.cloudflare.com/client/v4/accounts';
const WORKER_NAME = 'riftborn-leaderboard';

/** Build multipart metadata for the documented Workers Script Upload API. */
export function createWorkerUpload(bundle, { databaseId, siteOrigin }) {
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
    ],
  };

  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.set('riftborn-worker.mjs', new Blob([bundle], { type: 'application/javascript+module' }), 'riftborn-worker.mjs');
  return form;
}

export async function deployWorker({ accountId, apiToken, databaseId, siteOrigin, fetchImpl = fetch }) {
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
  const form = createWorkerUpload(result.outputFiles[0].text, { databaseId, siteOrigin });
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
  });
  console.log(`Deployed ${WORKER_NAME}; version ${result?.id || 'created'}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
