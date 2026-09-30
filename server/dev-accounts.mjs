// Local accounts harness: serves the real Worker (cloudflare/worker.js: accounts, scores and
// feedback) on http://127.0.0.1:8787 over node:sqlite. Local testing only; never deployed.
//
//   Run (from the site repo root):   node server/dev-accounts.mjs          (or: npm run dev:accounts)
//   Options (environment variables):
//     PORT=8787                 port on 127.0.0.1 (0 picks a free one; the URL is printed)
//     DEV_ACCOUNTS_DB=<file>    SQLite file (default .sites-runtime/dev-accounts.sqlite);
//                               ":memory:" keeps nothing between runs
//     DEV_ACCOUNTS_FRESH=1      delete the saved database and signing key first
//     GOOGLE_CLIENT_ID/_SECRET, DISCORD_..., GITHUB_...   optional: real providers, whose OAuth
//                               apps must then allow http://127.0.0.1:8787/auth/<p>/callback
//     AUTH_SIGNING_KEY_PREVIOUS=<key>   optional: try a key rotation (the saved key becomes the
//                               previous one only if you also pass it here)
//
//   Then serve the game on port 8700 (launch config "riftborn") and open
//   http://localhost:8700/?accounts=local   (the game points its account API at this harness).
//
// What it sets up:
// - ENVIRONMENT=development and FAKE_OAUTH=1: providers "fake" and "fake2" work (two, so linking a
//   second platform can be tried). /auth/fake/start (or /auth/fake2/start) shows a tiny page with a
//   "fake user id" field; Continue finishes the OAuth flow with a valid state, so the whole sign-in
//   runs with no real provider. (The Worker refuses both whenever ENVIRONMENT=production, or when
//   it is not reached on 127.0.0.1/localhost.) Like the real ones, a start needs ?challenge=.
// - ALLOWED_ORIGINS and AUTH_RETURN_ORIGINS: http://localhost:8700 and http://127.0.0.1:8700;
//   AUTH_RETURN_PATHS: "/" plus the real "/riftborn/" and "/riftborn/dev/".
// - A throwaway AUTH_SIGNING_KEY, generated once and kept next to the database (a new key would
//   orphan the saved identities and sessions). Delete both, or use DEV_ACCOUNTS_FRESH=1, to reset.
// - CF-Connecting-IP is the socket address (like Cloudflare, a client cannot choose it).
// The log shows method, path and status only: never query strings, codes or tokens.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker from '../cloudflare/worker.js';
import { createD1, openDatabase } from './d1-sqlite.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, '.sites-runtime');
const dbFile = process.env.DEV_ACCOUNTS_DB || path.join(runtime, 'dev-accounts.sqlite');
const keyFile = dbFile === ':memory:' ? null : dbFile + '.key';
const BODY_MAX = 128 * 1024;

fs.mkdirSync(runtime, { recursive: true });
if (process.env.DEV_ACCOUNTS_FRESH === '1' && dbFile !== ':memory:') {
  for (const file of [dbFile, keyFile]) fs.rmSync(file, { force: true });
}

function throwawayKey() {
  if (keyFile && fs.existsSync(keyFile)) {
    const saved = fs.readFileSync(keyFile, 'utf8').trim();
    if (saved.length >= 32) return saved;
  }
  const key = crypto.randomBytes(32).toString('base64url');
  if (keyFile) fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 });
  return key;
}

const sqlite = openDatabase(dbFile, path.join(root, 'drizzle'), fs);
const origins = 'http://localhost:8700,http://127.0.0.1:8700';
const env = {
  DB: createD1(sqlite),
  ENVIRONMENT: 'development',
  ALLOWED_ORIGINS: origins,
  AUTH_RETURN_ORIGINS: origins,
  AUTH_RETURN_PATHS: '/,/riftborn/,/riftborn/dev/',
  FAKE_OAUTH: '1',
  AUTH_SIGNING_KEY: throwawayKey()
};
if ((process.env.AUTH_SIGNING_KEY_PREVIOUS || '').length >= 32) env.AUTH_SIGNING_KEY_PREVIOUS = process.env.AUTH_SIGNING_KEY_PREVIOUS;
for (const name of ['GOOGLE', 'DISCORD', 'GITHUB']) {
  for (const part of ['CLIENT_ID', 'CLIENT_SECRET']) {
    const value = process.env[`${name}_${part}`];
    if (value) env[`${name}_${part}`] = value;
  }
}
const ctx = { waitUntil(promise) { Promise.resolve(promise).catch(() => {}); }, passThroughOnException() {} };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let status = 500;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_MAX) { status = 413; res.writeHead(413, { 'Content-Type': 'application/json' }); res.end('{"error":"too_large"}'); return; }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === 'cf-connecting-ip' || name === 'host') continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('CF-Connecting-IP', req.socket.remoteAddress || '127.0.0.1');
    const hostHeader = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '') ? req.headers.host : `127.0.0.1:${server.address().port}`;
    const request = new Request(`http://${hostHeader}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
    });
    const response = await worker.fetch(request, env, ctx);
    status = response.status;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Harness error:', error?.message || error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"harness_error"}');
  } finally {
    if (process.env.DEV_ACCOUNTS_QUIET !== '1') console.log(`${req.method} ${url.pathname} ${status}`);
  }
});

server.listen(process.env.PORT === undefined ? 8787 : Number(process.env.PORT), '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`Riftborn accounts harness: http://127.0.0.1:${port}  (fake OAuth on; database ${dbFile === ':memory:' ? 'in memory' : path.relative(root, dbFile)})`);
});
function stop() { server.close(() => { sqlite.close(); process.exit(0); }); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
