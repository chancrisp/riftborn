// Riftborn accounts (v2.2) on the leaderboard Worker: OAuth sign-in with Google, Discord or
// GitHub, a Riftborn username chosen by the player, sessions, linked platforms and profile sync.
// Contract: riftborn/docs/design-2.2-accounts.md ("Build spec").
//
// Privacy and security rules this module keeps:
// - Nothing is imported from the platforms: only the opaque user id is read, and it is stored as
//   HMAC(AUTH_SIGNING_KEY, provider + ":" + id). No emails, names, avatars or passwords.
// - Session tokens, login codes, signup tokens, link tickets and OAuth states are random 256-bit
//   values stored only as keyed hashes. Tokens travel in the Authorization header, never in a URL;
//   the game receives only a single-use 60 s login code, in a URL fragment.
// - Return URLs are an exact allow-list (origin + path). Every SQL statement is parameterised.
// - IPs are used only transiently, hashed, as rate-limit keys. No secret or token is ever logged.
// - The "fake" provider exists only in the local harness and is impossible in production.
import { checkUsername, usernameKey } from './username-rules.js';
import { lateColumns } from './scores-api.js';

export const PROVIDERS = Object.freeze(['google', 'discord', 'github']);
const ALL_PROVIDERS = Object.freeze([...PROVIDERS, 'fake']);

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const SESSION_MS = 180 * DAY;
const SESSION_BUMP_MS = DAY;
export const USERNAME_COOLDOWN_MS = 30 * DAY;
export const PENDING_MS = Object.freeze({ state: 10 * MINUTE, login: MINUTE, signup: 15 * MINUTE, link: 5 * MINUTE });
export const PROFILE_MAX = 96 * 1024;
const SMALL_BODY_MAX = 4096;
const SIGNING_KEY_MIN = 32;
const PURGE_EVERY_MS = 10 * MINUTE;

// Fixed-window limits. per: "ip" (hashed) or "account".
export const LIMITS = Object.freeze({
  start: { max: 20, windowMs: 10 * MINUTE, per: 'ip' },
  callback: { max: 30, windowMs: 10 * MINUTE, per: 'ip' },
  session: { max: 30, windowMs: 10 * MINUTE, per: 'ip' },
  create: { max: 10, windowMs: HOUR, per: 'ip' },
  check: { max: 60, windowMs: 10 * MINUTE, per: 'ip' },
  rename: { max: 10, windowMs: HOUR, per: 'account' },
  remove: { max: 10, windowMs: HOUR, per: 'account' },
  ticket: { max: 10, windowMs: HOUR, per: 'account' },
  unlink: { max: 10, windowMs: HOUR, per: 'account' },
  profile: { max: 120, windowMs: HOUR, per: 'account' }
});

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization';
const DEFAULT_RETURN_ORIGINS = 'https://chancrisp.github.io';
const DEFAULT_RETURN_PATHS = '/riftborn/,/riftborn/dev/';
// The client challenge (start ?challenge=, /auth/session {verifier}) is optional until the game
// sends it on every sign-in; then set this to true so a lifted login code can never be redeemed.
const REQUIRE_CLIENT_CHALLENGE = false;
const REDIRECT_ERRORS = Object.freeze(['cancelled', 'invalid_state', 'provider_error', 'already_linked', 'provider_unavailable']);

// ---- configuration ---------------------------------------------------------------------------

const isProduction = env => env.ENVIRONMENT === 'production';
const signingKey = env => (typeof env.AUTH_SIGNING_KEY === 'string' && env.AUTH_SIGNING_KEY.length >= SIGNING_KEY_MIN ? env.AUTH_SIGNING_KEY : null);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// The fake provider: FAKE_OAUTH=1, never in production, and only when the Worker itself is being
// reached on a loopback address (the local harness). Any one of the three missing disables it.
export function fakeEnabled(env, url) {
  if (isProduction(env) || String(env.FAKE_OAUTH ?? '') !== '1') return false;
  try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; }
}

function providerCredentials(env, provider) {
  const upper = provider.toUpperCase();
  const id = typeof env[upper + '_CLIENT_ID'] === 'string' ? env[upper + '_CLIENT_ID'].trim() : '';
  const secret = typeof env[upper + '_CLIENT_SECRET'] === 'string' ? env[upper + '_CLIENT_SECRET'].trim() : '';
  return id && secret ? { id, secret } : null;
}

export function availableProviders(env, url) {
  if (!signingKey(env)) return [];
  const list = PROVIDERS.filter(provider => providerCredentials(env, provider));
  if (fakeEnabled(env, url)) list.push('fake');
  return list;
}

const listVar = (value, fallback) => String(value || fallback).split(',').map(item => item.trim()).filter(Boolean);

function returnAllowList(env) {
  return {
    origins: listVar(env.AUTH_RETURN_ORIGINS, DEFAULT_RETURN_ORIGINS),
    paths: listVar(env.AUTH_RETURN_PATHS, DEFAULT_RETURN_PATHS).filter(path => path.startsWith('/') && path.endsWith('/'))
  };
}

// -> the normalised return URL (origin + path + optional plain query), or null. The origin must
// match exactly and the path must be an allowed folder or its index.html; no credentials, no
// fragment (it is replaced), and a query of plain characters only.
export function checkReturnUrl(raw, env) {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null;
  if (/[^A-Za-z0-9:/?#[\]@!$&'()*+,;=._~%-]/.test(raw)) return null; // URL characters only (RFC 3986)
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const { origins, paths } = returnAllowList(env);
  if (!origins.includes(url.origin)) return null;
  if (!paths.some(path => url.pathname === path || url.pathname === path + 'index.html')) return null;
  if (url.search.length > 256 || !/^(\?[A-Za-z0-9=&_.~%+-]*)?$/.test(url.search)) return null;
  return url.origin + url.pathname + url.search;
}

function defaultReturn(env) {
  const { origins, paths } = returnAllowList(env);
  return (origins[0] || DEFAULT_RETURN_ORIGINS) + (paths[0] || '/riftborn/');
}

// Same rule as server/scores-api.js and server/feedback-api.js.
function originAllowed(origin, env) {
  if (!origin) return true;
  const defaults = 'https://riftborn.chanmanc10.chatgpt.site' +
    (isProduction(env) ? '' : ',http://127.0.0.1:4173,http://localhost:4173');
  return `${defaults},${env.ALLOWED_ORIGINS || ''}`
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .includes(origin);
}

// ---- responses -------------------------------------------------------------------------------

const corsHeaders = origin => (origin ? {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': METHODS,
  'Access-Control-Allow-Headers': ALLOW_HEADERS
} : {});

function json(value, status = 200, origin = null, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin',
      ...corsHeaders(origin),
      ...extra
    }
  });
}

class ApiError extends Error {
  constructor(code, status, extra = {}, headers = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
    this.headers = headers;
  }
}
const fail = (code, status, extra, headers) => { throw new ApiError(code, status, extra, headers); };

function redirect(location, extra = {}) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...extra }
  });
}
const backToGame = (returnUrl, key, value) => redirect(`${returnUrl}#${key}=${encodeURIComponent(value)}`);
const errorToGame = (returnUrl, code) => backToGame(returnUrl, 'rb_error', REDIRECT_ERRORS.includes(code) ? code : 'provider_error');

// ---- crypto ----------------------------------------------------------------------------------

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

const hmacKeys = new Map(); // signing key -> Promise<CryptoKey>, once per isolate
function hmacKey(secret) {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(secret, key);
  }
  return key;
}

export async function hmac(secret, message) {
  return base64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message)));
}

const sha256 = async text => base64url(await crypto.subtle.digest('SHA-256', encoder.encode(text)));

// Constant-time comparison for secret-derived strings (no early exit on the first difference).
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The stored form of a platform identity: never the raw platform id.
export const identityHash = (secret, provider, id) => hmac(secret, provider + ':' + id);
export const sessionHash = (secret, token) => hmac(secret, token);
const pendingHash = (secret, raw) => hmac(secret, 'pending:' + raw);
const browserHash = (secret, nonce) => hmac(secret, 'browser:' + nonce);

// ---- browser binding for the OAuth round trip -------------------------------------------------
// /start sets a random nonce in a first-party cookie on the Worker's own origin (the browser is on
// the Worker for that top-level navigation: this is not a third-party cookie, and fetch never uses
// credentials). The state row keeps its hash, and /callback requires the same browser to bring it
// back (SameSite=Lax is sent on the provider's top-level redirect). A callback URL started by
// someone else, sent to a victim, therefore fails: no login CSRF, no linking a victim's platform
// to an attacker's account. An existing nonce is reused so parallel sign-ins in two tabs work.
const BROWSER_COOKIE_SECURE = '__Host-rb_oauth';
const BROWSER_COOKIE_LOCAL = 'rb_oauth'; // http://127.0.0.1 harness: no Secure/__Host- prefix
const browserCookieName = url => (new URL(url).protocol === 'https:' ? BROWSER_COOKIE_SECURE : BROWSER_COOKIE_LOCAL);

function readBrowserNonce(request) {
  const name = browserCookieName(request.url);
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (key === name && TOKEN.test(value)) return value;
  }
  return null;
}

function browserCookie(request, nonce) {
  const secure = new URL(request.url).protocol === 'https:';
  return `${browserCookieName(request.url)}=${nonce}; Path=/; Max-Age=${PENDING_MS.state / 1000}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// ---- schema ----------------------------------------------------------------------------------

// Lazy, additive bootstrap in the style of lateColumns/ensureFeedbackTable: every statement is
// IF NOT EXISTS and none touches an existing table. Wrangler migrations cannot reach this DB.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER,
    username_changed_at INTEGER,
    profile_json TEXT,
    profile_rev INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS identities (
    provider TEXT,
    provider_user_id TEXT,
    account_id TEXT,
    created_at INTEGER,
    PRIMARY KEY (provider, provider_user_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_identities_account ON identities (account_id)',
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT,
    created_at INTEGER,
    expires_at INTEGER,
    last_seen INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)',
  'CREATE TABLE IF NOT EXISTS auth_pending (key TEXT PRIMARY KEY, kind TEXT, data TEXT, expires_at INTEGER)',
  'CREATE INDEX IF NOT EXISTS idx_auth_pending_expires ON auth_pending (expires_at)',
  'CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER, count INTEGER)',
  'CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start)'
];
const tablesReady = new WeakMap(); // DB binding -> Promise, once per isolate

export function ensureAccountTables(db) {
  let promise = tablesReady.get(db);
  if (!promise) {
    promise = (async () => {
      if (typeof db.batch === 'function') await db.batch(SCHEMA.map(sql => db.prepare(sql)));
      else for (const sql of SCHEMA) await db.prepare(sql).run();
    })();
    tablesReady.set(db, promise);
    promise.catch(() => tablesReady.delete(db)); // a failed bootstrap retries on the next request
  }
  return promise;
}

const lastPurge = new WeakMap(); // DB binding -> ms
// Opportunistic cleanup of expired single-use values, sessions and old limiter windows.
function purgeExpired(db, ctx, now) {
  if (now - (lastPurge.get(db) || 0) < PURGE_EVERY_MS) return;
  lastPurge.set(db, now);
  const work = Promise.resolve().then(() => db.batch([
    db.prepare('DELETE FROM auth_pending WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 2 * HOUR)
  ])).catch(error => console.error('Accounts purge failed', error?.message || 'unknown error'));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  return work;
}

const changes = result => Number(result?.meta?.changes ?? result?.changes ?? 0);

// ---- rate limits -----------------------------------------------------------------------------

const clientIp = request => request.headers.get('CF-Connecting-IP') || 'unknown';

async function rateLimit(db, secret, bucket, subject, now) {
  const rule = LIMITS[bucket];
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
  const key = await hmac(secret, `rl:${bucket}:${subject}`);
  const row = await db.prepare(
    'INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ' +
    'ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END, ' +
    'window_start = excluded.window_start RETURNING count'
  ).bind(key, windowStart).first();
  if (Number(row?.count || 0) > rule.max) {
    const retry = Math.max(1, Math.ceil((windowStart + rule.windowMs - now) / 1000));
    fail('rate_limited', 429, { retryAfter: retry }, { 'Retry-After': String(retry) });
  }
}
const limitIp = (db, secret, bucket, request, now) => rateLimit(db, secret, bucket, 'ip:' + clientIp(request), now);
const limitAccount = (db, secret, bucket, accountId, now) => rateLimit(db, secret, bucket, 'account:' + accountId, now);

// ---- single-use values -----------------------------------------------------------------------

async function putPending(db, secret, kind, data, now) {
  const raw = randomToken();
  const expiresAt = now + PENDING_MS[kind];
  await db.prepare('INSERT INTO auth_pending (key, kind, data, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await pendingHash(secret, raw), kind, JSON.stringify(data), expiresAt).run();
  return { raw, expiresAt };
}

const parseData = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : null; } catch { return null; } };

// Consumes the value (DELETE ... RETURNING): a second use finds nothing. Expired -> null.
async function takePending(db, secret, kind, raw, now) {
  if (typeof raw !== 'string' || !TOKEN.test(raw)) return null;
  const row = await db.prepare('DELETE FROM auth_pending WHERE key = ? AND kind = ? RETURNING data, expires_at')
    .bind(await pendingHash(secret, raw), kind).first();
  if (!row || !(Number(row.expires_at) > now)) return null;
  return parseData(row.data);
}

// Reads without consuming (a signup token survives a "username taken" retry).
async function peekPending(db, secret, kind, raw, now) {
  if (typeof raw !== 'string' || !TOKEN.test(raw)) return null;
  const key = await pendingHash(secret, raw);
  const row = await db.prepare('SELECT data, expires_at FROM auth_pending WHERE key = ? AND kind = ?').bind(key, kind).first();
  if (!row || !(Number(row.expires_at) > now)) return null;
  const data = parseData(row.data);
  return data ? { key, data } : null;
}

// ---- sessions and accounts -------------------------------------------------------------------

function bearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec((request.headers.get('Authorization') || '').trim());
  return match ? match[1] : null;
}

async function newSession(db, secret, accountId, now) {
  const token = randomToken();
  const expiresAt = now + SESSION_MS;
  const statement = db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)')
    .bind(await sessionHash(secret, token), accountId, now, expiresAt, now);
  return { token, expiresAt, statement };
}

// -> { accountId, username, tokenHash } or null. Expired sessions are deleted; live ones slide
// (last_seen and expires_at bumped at most once a day).
async function findSession(db, secret, token, now) {
  if (!token) return null;
  const tokenHash = await sessionHash(secret, token);
  const row = await db.prepare(
    'SELECT s.account_id AS account_id, s.expires_at AS expires_at, s.last_seen AS last_seen, a.username AS username ' +
    'FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?'
  ).bind(tokenHash).first();
  if (!row) return null;
  if (!(Number(row.expires_at) > now)) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (now - Number(row.last_seen || 0) >= SESSION_BUMP_MS) {
    await db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').bind(now, now + SESSION_MS, tokenHash).run();
  }
  return { accountId: row.account_id, username: row.username, tokenHash };
}

async function requireSession(db, secret, request, now) {
  const session = await findSession(db, secret, bearerToken(request), now);
  if (!session) fail('unauthorized', 401, {}, { 'WWW-Authenticate': 'Bearer' });
  return session;
}

const nextChangeAt = (changedAt, now) => {
  if (!changedAt) return null;
  const next = Number(changedAt) + USERNAME_COOLDOWN_MS;
  return next > now ? next : null;
};

async function loadAccount(db, accountId, now) {
  const row = await db.prepare('SELECT id, username, created_at, username_changed_at FROM accounts WHERE id = ?').bind(accountId).first();
  if (!row) return null;
  const identities = await db.prepare('SELECT provider FROM identities WHERE account_id = ? ORDER BY created_at, provider').bind(accountId).all();
  return {
    id: row.id,
    username: row.username,
    providers: (identities?.results || []).map(identity => identity.provider),
    createdAt: row.created_at ?? null,
    usernameChangedAt: row.username_changed_at ?? null,
    nextUsernameChangeAt: nextChangeAt(row.username_changed_at, now)
  };
}

async function usernameOwner(db, name) {
  const row = await db.prepare('SELECT id FROM accounts WHERE username = ? LIMIT 1').bind(String(name).trim()).first();
  return row ? row.id : null;
}

const isUniqueError = (error, what) => new RegExp(`UNIQUE constraint failed: ${what}`, 'i').test(String(error?.message || error));

// ---- request bodies --------------------------------------------------------------------------

async function readJson(request, max) {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) fail('json_required', 415);
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > max) fail('too_large', 413);
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { try { await reader.cancel(); } catch {} fail('too_large', 413); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('invalid_json', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_body', 400);
  return value;
}

function usernameError(check) {
  fail(check.reason === 'reserved' ? 'reserved' : 'invalid', 400, { detail: check.detail });
}

// ---- OAuth providers -------------------------------------------------------------------------

const OAUTH = Object.freeze({
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid'
  },
  discord: {
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    scope: 'identify'
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: ''
  }
});
const USER_AGENT = 'riftborn-accounts';
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

const callbackUrl = (request, provider) => `${new URL(request.url).origin}/auth/${provider}/callback`;
const timeout = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined);

class ProviderError extends Error {}

async function exchangeCode(provider, creds, code, verifier, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: creds.id,
    client_secret: creds.secret,
    code_verifier: verifier
  });
  const response = await fetch(OAUTH[provider].token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body,
    signal: timeout()
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || !data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new ProviderError(`${provider} token exchange failed (${response.status})`);
  }
  return data;
}

function googleSubject(idToken, clientId, now) {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1]))); } catch { return null; }
  // Received straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7): check the
  // issuer, audience and expiry; the signature check is not needed on this back channel.
  const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims?.iss)) return null;
  if (!audience.includes(clientId)) return null;
  if (!(Number(claims.exp) * 1000 > now)) return null;
  return typeof claims.sub === 'string' ? claims.sub : null;
}

async function fetchUserJson(url, accessToken, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': USER_AGENT, ...extraHeaders },
    signal: timeout()
  });
  if (!response.ok) throw new ProviderError(`user lookup failed (${response.status})`);
  return response.json();
}

// -> the provider's opaque user id (string). Nothing else from the response is kept.
async function providerUserId(provider, creds, code, verifier, redirectUri, now) {
  const tokens = await exchangeCode(provider, creds, code, verifier, redirectUri);
  let id = null;
  if (provider === 'google') {
    id = googleSubject(tokens.id_token, creds.id, now);
    if (!id) id = (await fetchUserJson('https://openidconnect.googleapis.com/v1/userinfo', tokens.access_token))?.sub;
  } else if (provider === 'discord') {
    id = (await fetchUserJson('https://discord.com/api/users/@me', tokens.access_token))?.id;
  } else if (provider === 'github') {
    id = (await fetchUserJson('https://api.github.com/user', tokens.access_token, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }))?.id;
  }
  if ((typeof id !== 'string' && !Number.isSafeInteger(id)) || !PROVIDER_ID.test(String(id))) throw new ProviderError(`${provider} user id missing`);
  return String(id);
}

// ---- /auth/:provider/start and /callback (top-level navigations) -----------------------------

function fakeProviderPage(state, extraHeaders = {}) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fake sign-in (local harness)</title>
<style>body{font:16px system-ui,sans-serif;background:#12101a;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#1f1b2d;padding:24px;border-radius:10px;max-width:360px;width:calc(100% - 32px)}h1{font-size:20px;margin:0 0 8px}
p{color:#aaa;font-size:14px}label{display:block;margin:16px 0 8px}input{width:100%;box-sizing:border-box;padding:8px;font:inherit}
.row{display:flex;gap:8px;margin-top:16px}button{flex:1;padding:10px;font:inherit;cursor:pointer}</style></head>
<body><main><h1>Fake provider</h1><p>Local harness only. Any id signs in as that fake platform user; the same id returns to the same account.</p>
<form method="get" action="/auth/fake/callback" id="ok"><input type="hidden" name="state" value="${state}">
<label for="code">Fake user id</label><input id="code" name="code" value="player-1" required maxlength="64" pattern="[A-Za-z0-9_\\-]{1,64}" autofocus></form>
<form method="get" action="/auth/fake/callback" id="cancel"><input type="hidden" name="state" value="${state}"><input type="hidden" name="error" value="access_denied"></form>
<div class="row"><button type="submit" form="ok">Continue</button><button type="submit" form="cancel">Cancel</button></div>
</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      ...extraHeaders
    }
  });
}

async function oauthStart(request, env, db, secret, provider, now) {
  const url = new URL(request.url);
  const returnUrl = checkReturnUrl(url.searchParams.get('return'), env);
  if (!returnUrl) fail('invalid_return', 400);
  const creds = provider === 'fake' ? null : providerCredentials(env, provider);
  if (provider !== 'fake' && !creds) fail('provider_unavailable', 503);
  const mode = url.searchParams.get('mode') || 'login';
  if (mode !== 'login' && mode !== 'link') fail('invalid_mode', 400);
  await limitIp(db, secret, 'start', request, now);

  let accountId = null;
  if (mode === 'link') {
    const ticket = await takePending(db, secret, 'link', url.searchParams.get('ticket'), now);
    if (!ticket || typeof ticket.accountId !== 'string') return errorToGame(returnUrl, 'invalid_state');
    accountId = ticket.accountId;
  }
  // Optional client binding: the game sends SHA-256(verifier) here and the verifier to /auth/session,
  // so a login code lifted from someone else's flow is useless (see exchangeLoginCode).
  const challenge = url.searchParams.get('challenge');
  if (challenge !== null && !TOKEN.test(challenge)) fail('invalid_challenge', 400);
  if (REQUIRE_CLIENT_CHALLENGE && challenge === null) fail('challenge_required', 400);
  const nonce = readBrowserNonce(request) || randomToken();
  const verifier = provider === 'fake' ? null : randomToken();
  const { raw: state } = await putPending(db, secret, 'state', {
    provider, verifier, returnUrl, mode, accountId, challenge, browser: await browserHash(secret, nonce)
  }, now);
  const cookie = { 'Set-Cookie': browserCookie(request, nonce) };
  if (provider === 'fake') return fakeProviderPage(state, cookie);

  const target = new URL(OAUTH[provider].authorize);
  const params = {
    client_id: creds.id,
    redirect_uri: callbackUrl(request, provider),
    response_type: 'code',
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256'
  };
  if (OAUTH[provider].scope) params.scope = OAUTH[provider].scope;
  if (provider === 'github') params.allow_signup = 'true';
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return redirect(target.href, cookie);
}

async function oauthCallback(request, env, db, secret, provider, now) {
  const url = new URL(request.url);
  await limitIp(db, secret, 'callback', request, now);
  const state = await takePending(db, secret, 'state', url.searchParams.get('state'), now);
  if (!state || state.provider !== provider || !checkReturnUrl(state.returnUrl, env)) return errorToGame(defaultReturn(env), 'invalid_state');
  const returnUrl = state.returnUrl;
  const nonce = readBrowserNonce(request);
  if (!nonce || !sameSecret(await browserHash(secret, nonce), state.browser)) return errorToGame(returnUrl, 'invalid_state');
  const providerError = url.searchParams.get('error');
  if (providerError) return errorToGame(returnUrl, providerError === 'access_denied' ? 'cancelled' : 'provider_error');
  const code = url.searchParams.get('code');
  if (typeof code !== 'string' || !code || code.length > 2048 || /[\u0000-\u001f\u007f]/.test(code)) return errorToGame(returnUrl, 'provider_error');

  let platformId;
  if (provider === 'fake') {
    if (!PROVIDER_ID.test(code) || code.length > 64) return errorToGame(returnUrl, 'provider_error');
    platformId = code;
  } else {
    const creds = providerCredentials(env, provider);
    if (!creds) return errorToGame(returnUrl, 'provider_unavailable');
    try {
      platformId = await providerUserId(provider, creds, code, state.verifier, callbackUrl(request, provider), now);
    } catch (error) {
      console.error('Accounts: sign-in with ' + provider + ' failed', error instanceof ProviderError ? error.message : (error?.name || 'error'));
      return errorToGame(returnUrl, 'provider_error');
    }
  }
  const identity = await identityHash(secret, provider, platformId);
  const owner = await db.prepare('SELECT account_id FROM identities WHERE provider = ? AND provider_user_id = ?').bind(provider, identity).first();

  if (state.mode === 'link') {
    const accountId = state.accountId;
    if (typeof accountId !== 'string') return errorToGame(returnUrl, 'invalid_state');
    if (owner && owner.account_id !== accountId) return errorToGame(returnUrl, 'already_linked');
    if (!owner) {
      const account = await db.prepare('SELECT id FROM accounts WHERE id = ?').bind(accountId).first();
      if (!account) return errorToGame(returnUrl, 'invalid_state');
      // One identity per platform per account: unlink the old one first to switch.
      const sameProvider = await db.prepare('SELECT 1 AS found FROM identities WHERE account_id = ? AND provider = ?').bind(accountId, provider).first();
      if (sameProvider) return errorToGame(returnUrl, 'already_linked');
      try {
        await db.prepare('INSERT INTO identities (provider, provider_user_id, account_id, created_at) VALUES (?, ?, ?, ?)')
          .bind(provider, identity, accountId, now).run();
      } catch (error) {
        if (!isUniqueError(error, 'identities')) throw error;
        return errorToGame(returnUrl, 'already_linked'); // linked elsewhere a moment ago
      }
    }
    const { raw } = await putPending(db, secret, 'login', { type: 'linked', provider, accountId, challenge: state.challenge ?? null }, now);
    return backToGame(returnUrl, 'rb_login', raw);
  }

  const login = owner
    ? { type: 'account', accountId: owner.account_id, challenge: state.challenge ?? null }
    : { type: 'signup', provider, identity, challenge: state.challenge ?? null };
  const { raw } = await putPending(db, secret, 'login', login, now);
  return backToGame(returnUrl, 'rb_login', raw);
}

// ---- API routes ------------------------------------------------------------------------------

async function exchangeLoginCode(request, db, secret, now) {
  await limitIp(db, secret, 'session', request, now);
  const body = await readJson(request, SMALL_BODY_MAX);
  const login = await takePending(db, secret, 'login', body.code, now);
  if (!login) fail('expired', 400);
  // A flow started with a client challenge only completes for the page holding its verifier.
  if (login.challenge) {
    const verifier = typeof body.verifier === 'string' && TOKEN.test(body.verifier) ? body.verifier : null;
    if (!verifier || !sameSecret(await sha256(verifier), login.challenge)) fail('expired', 400);
  }
  if (login.type === 'account') {
    const account = await loadAccount(db, login.accountId, now);
    if (!account) fail('expired', 400);
    const session = await newSession(db, secret, account.id, now);
    await session.statement.run();
    return { token: session.token, expiresAt: session.expiresAt, account };
  }
  if (login.type === 'signup') {
    // The signup token is minted here, so no raw secret ever sits in the database.
    const { raw, expiresAt } = await putPending(db, secret, 'signup', { provider: login.provider, identity: login.identity }, now);
    return { needsUsername: true, signupToken: raw, expiresAt };
  }
  if (login.type === 'linked') {
    const account = await loadAccount(db, login.accountId, now);
    if (!account) fail('expired', 400);
    return { linked: login.provider, account };
  }
  fail('expired', 400);
}

async function signInExisting(db, secret, accountId, signupKey, now) {
  const session = await newSession(db, secret, accountId, now);
  await db.batch([session.statement, db.prepare('DELETE FROM auth_pending WHERE key = ?').bind(signupKey)]);
  return { token: session.token, expiresAt: session.expiresAt, account: await loadAccount(db, accountId, now) };
}

async function createAccount(request, db, secret, now) {
  await limitIp(db, secret, 'create', request, now);
  const body = await readJson(request, SMALL_BODY_MAX);
  const check = checkUsername(typeof body.username === 'string' ? body.username : '');
  const pending = await peekPending(db, secret, 'signup', body.signupToken, now);
  if (!pending || !ALL_PROVIDERS.includes(pending.data.provider) || typeof pending.data.identity !== 'string') fail('expired', 400);
  const { provider, identity } = pending.data;
  // Already registered (a second tab finished first): that proves the same identity, so sign in.
  const findOwner = () => db.prepare('SELECT account_id FROM identities WHERE provider = ? AND provider_user_id = ?').bind(provider, identity).first();
  const existing = await findOwner();
  if (existing) return signInExisting(db, secret, existing.account_id, pending.key, now);
  if (!check.ok) usernameError(check);
  if (await usernameOwner(db, check.name)) fail('taken', 409);

  const id = crypto.randomUUID();
  const session = await newSession(db, secret, id, now);
  try {
    await db.batch([
      db.prepare('INSERT INTO accounts (id, username, created_at, username_changed_at, profile_json, profile_rev, updated_at) VALUES (?, ?, ?, NULL, NULL, 0, ?)')
        .bind(id, check.name, now, now),
      db.prepare('INSERT INTO identities (provider, provider_user_id, account_id, created_at) VALUES (?, ?, ?, ?)').bind(provider, identity, id, now),
      session.statement,
      db.prepare('DELETE FROM auth_pending WHERE key = ?').bind(pending.key)
    ]);
  } catch (error) {
    const raced = await findOwner();
    if (raced) return signInExisting(db, secret, raced.account_id, pending.key, now);
    if (isUniqueError(error, 'accounts.username') || await usernameOwner(db, check.name)) fail('taken', 409);
    throw error;
  }
  return { token: session.token, expiresAt: session.expiresAt, account: await loadAccount(db, id, now) };
}

async function renameAccount(request, db, secret, session, now) {
  await limitAccount(db, secret, 'rename', session.accountId, now);
  const body = await readJson(request, SMALL_BODY_MAX);
  const check = checkUsername(typeof body.username === 'string' ? body.username : '');
  if (!check.ok) usernameError(check);
  const row = await db.prepare('SELECT username, username_changed_at FROM accounts WHERE id = ?').bind(session.accountId).first();
  if (!row) fail('unauthorized', 401, {}, { 'WWW-Authenticate': 'Bearer' });
  if (check.name === row.username) return { account: await loadAccount(db, session.accountId, now) };
  const caseOnly = usernameKey(check.name) === usernameKey(row.username);
  if (!caseOnly) {
    const next = nextChangeAt(row.username_changed_at, now);
    if (next) fail('too_soon', 429, { nextUsernameChangeAt: next });
    const owner = await usernameOwner(db, check.name);
    if (owner && owner !== session.accountId) fail('taken', 409);
  }
  try {
    await db.prepare(caseOnly
      ? 'UPDATE accounts SET username = ?, updated_at = ? WHERE id = ?'
      : 'UPDATE accounts SET username = ?, updated_at = ?, username_changed_at = ? WHERE id = ?')
      .bind(...(caseOnly ? [check.name, now, session.accountId] : [check.name, now, now, session.accountId])).run();
  } catch (error) {
    if (isUniqueError(error, 'accounts.username')) fail('taken', 409);
    throw error;
  }
  return { account: await loadAccount(db, session.accountId, now) };
}

async function deleteAccount(db, secret, session, now) {
  await limitAccount(db, secret, 'remove', session.accountId, now);
  const id = session.accountId;
  const statements = [
    db.prepare('DELETE FROM identities WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM sessions WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM accounts WHERE id = ?').bind(id)
  ];
  // Leaderboard rows stay, anonymised: no account link, and a fresh EXILE-xxxx name per row.
  const anonymise = db.prepare("UPDATE scores SET account_id = NULL, name = 'EXILE-' || hex(randomblob(2)) WHERE account_id = ?").bind(id);
  const late = await lateColumns(db);
  try {
    await db.batch(late.includes('account_id') ? [anonymise, ...statements] : statements);
  } catch (error) {
    if (!/account_id|no such table: scores/i.test(String(error?.message || error))) throw error;
    await db.batch(statements); // the scores column vanished: nothing can reference the account
  }
  return { ok: true };
}

async function unlinkProvider(db, secret, session, provider, now) {
  if (!ALL_PROVIDERS.includes(provider)) fail('not_found', 404);
  await limitAccount(db, secret, 'unlink', session.accountId, now);
  // One statement, so two parallel unlinks can never remove the last identity.
  const result = await db.prepare(
    'DELETE FROM identities WHERE account_id = ? AND provider = ? AND (SELECT COUNT(*) FROM identities WHERE account_id = ?) > 1'
  ).bind(session.accountId, provider, session.accountId).run();
  if (!changes(result)) {
    const linked = await db.prepare('SELECT 1 AS found FROM identities WHERE account_id = ? AND provider = ?').bind(session.accountId, provider).first();
    if (!linked) fail('not_linked', 404);
    fail('last_identity', 409);
  }
  return { account: await loadAccount(db, session.accountId, now) };
}

async function readProfile(db, session) {
  const row = await db.prepare('SELECT profile_json, profile_rev, updated_at FROM accounts WHERE id = ?').bind(session.accountId).first();
  if (!row) fail('unauthorized', 401, {}, { 'WWW-Authenticate': 'Bearer' });
  let profile = null;
  try { profile = row.profile_json ? JSON.parse(row.profile_json) : null; } catch { profile = null; }
  return { profile, rev: Number(row.profile_rev) || 0, updatedAt: row.updated_at ?? null };
}

async function writeProfile(request, db, secret, session, now) {
  await limitAccount(db, secret, 'profile', session.accountId, now);
  const body = await readJson(request, PROFILE_MAX + 1024);
  const { profile, baseRev } = body;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail('invalid_profile', 400);
  if (!Number.isSafeInteger(baseRev) || baseRev < 0) fail('invalid_rev', 400);
  const text = JSON.stringify(profile);
  if (encoder.encode(text).byteLength > PROFILE_MAX) fail('too_large', 413, { max: PROFILE_MAX });
  const result = await db.prepare('UPDATE accounts SET profile_json = ?, profile_rev = profile_rev + 1, updated_at = ? WHERE id = ? AND profile_rev = ?')
    .bind(text, now, session.accountId, baseRev).run();
  if (changes(result)) return { rev: baseRev + 1, updatedAt: now };
  const current = await readProfile(db, session);
  fail('conflict', 409, { profile: current.profile, rev: current.rev, updatedAt: current.updatedAt });
}

// ---- entry -----------------------------------------------------------------------------------

function matchRoute(path) {
  let match;
  if ((match = /^\/auth\/([a-z]{1,16})\/(start|callback)$/.exec(path))) return { name: match[2], provider: match[1], navigation: true };
  if (path === '/auth/session') return { name: 'session', methods: ['POST'] };
  if (path === '/auth/logout') return { name: 'logout', methods: ['POST'] };
  if (path === '/api/auth/providers') return { name: 'providers', methods: ['GET'] };
  if (path === '/api/username-available') return { name: 'check', methods: ['GET'] };
  if (path === '/api/account') return { name: 'account', methods: ['GET', 'POST', 'PATCH', 'DELETE'] };
  if (path === '/api/account/link-ticket') return { name: 'ticket', methods: ['POST'] };
  if ((match = /^\/api\/account\/identities\/([a-z]{1,16})$/.exec(path))) return { name: 'unlink', methods: ['DELETE'], provider: match[1] };
  if (path === '/api/profile') return { name: 'profile', methods: ['GET', 'PUT'] };
  if (path.startsWith('/auth/') || path === '/auth' || path.startsWith('/api/account') || path.startsWith('/api/auth')) return { name: 'unknown', methods: [] };
  return null;
}

async function navigation(request, env, ctx, route, url, now) {
  const secret = signingKey(env);
  const known = PROVIDERS.includes(route.provider) || (route.provider === 'fake' && fakeEnabled(env, url));
  if (!known) return json({ error: 'not_found' }, 404);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, null, { Allow: 'GET' });
  if (!secret || !env.DB) {
    if (route.name === 'start') return json({ error: 'provider_unavailable' }, 503);
    return errorToGame(defaultReturn(env), 'provider_unavailable');
  }
  try {
    await ensureAccountTables(env.DB);
    purgeExpired(env.DB, ctx, now);
    return route.name === 'start'
      ? await oauthStart(request, env, env.DB, secret, route.provider, now)
      : await oauthCallback(request, env, env.DB, secret, route.provider, now);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.code, ...error.extra }, error.status, null, error.headers);
    console.error('Accounts sign-in failed', error?.message || 'unknown error');
    if (route.name === 'callback') return errorToGame(defaultReturn(env), 'provider_error');
    return json({ error: 'unavailable' }, 503);
  }
}

async function api(request, env, ctx, route, url, origin, now) {
  if (route.name === 'providers') return json({ providers: availableProviders(env, url) }, 200, origin);
  const secret = signingKey(env);
  if (!secret || !env.DB) return json({ error: 'accounts_unavailable' }, 503, origin);
  const db = env.DB;
  await ensureAccountTables(db);
  purgeExpired(db, ctx, now);
  const method = request.method;

  switch (route.name) {
    case 'session': return json(await exchangeLoginCode(request, db, secret, now), 200, origin);
    case 'logout': {
      const token = bearerToken(request);
      if (!token) fail('unauthorized', 401, {}, { 'WWW-Authenticate': 'Bearer' });
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sessionHash(secret, token)).run();
      return json({ ok: true }, 200, origin);
    }
    case 'check': {
      await limitIp(db, secret, 'check', request, now);
      const name = url.searchParams.get('name') || '';
      const check = checkUsername(name.length > 64 ? '' : name);
      if (!check.ok) return json({ available: false, reason: check.reason === 'reserved' ? 'reserved' : 'invalid' }, 200, origin);
      const owner = await usernameOwner(db, check.name);
      if (owner) {
        // Your own name (for a letter-case change) is available to you.
        const session = await findSession(db, secret, bearerToken(request), now);
        if (!session || session.accountId !== owner) return json({ available: false, reason: 'taken' }, 200, origin);
      }
      return json({ available: true }, 200, origin);
    }
    case 'account': {
      if (method === 'POST') return json(await createAccount(request, db, secret, now), 200, origin);
      const session = await requireSession(db, secret, request, now);
      if (method === 'GET') {
        const account = await loadAccount(db, session.accountId, now);
        if (!account) fail('unauthorized', 401, {}, { 'WWW-Authenticate': 'Bearer' });
        return json({ account }, 200, origin);
      }
      if (method === 'PATCH') return json(await renameAccount(request, db, secret, session, now), 200, origin);
      return json(await deleteAccount(db, secret, session, now), 200, origin);
    }
    case 'ticket': {
      const session = await requireSession(db, secret, request, now);
      await limitAccount(db, secret, 'ticket', session.accountId, now);
      const { raw, expiresAt } = await putPending(db, secret, 'link', { accountId: session.accountId }, now);
      return json({ ticket: raw, expiresAt }, 200, origin);
    }
    case 'unlink': {
      const session = await requireSession(db, secret, request, now);
      return json(await unlinkProvider(db, secret, session, route.provider, now), 200, origin);
    }
    case 'profile': {
      const session = await requireSession(db, secret, request, now);
      if (method === 'GET') return json(await readProfile(db, session), 200, origin);
      return json(await writeProfile(request, db, secret, session, now), 200, origin);
    }
  }
  return json({ error: 'not_found' }, 404, origin);
}

/** Accounts routes. Returns a Response, or null when the path is not an accounts route. */
export async function handleAccounts(request, env, ctx) {
  const url = new URL(request.url);
  const route = matchRoute(url.pathname);
  if (!route) return null;
  const now = Date.now();
  if (route.navigation) return navigation(request, env, ctx, route, url, now);

  const origin = request.headers.get('Origin');
  if (!originAllowed(origin, env)) return json({ error: 'forbidden_origin' }, 403);
  if (request.method === 'OPTIONS') {
    if (!origin) return json({ error: 'origin_required' }, 400);
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders(origin), 'Access-Control-Max-Age': '86400', 'Cache-Control': 'no-store', Vary: 'Origin' }
    });
  }
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' && !origin) return json({ error: 'forbidden' }, 403);
  if (route.name === 'unknown') return json({ error: 'not_found' }, 404, origin);
  if (!route.methods.includes(request.method)) {
    return json({ error: 'method_not_allowed' }, 405, origin, { Allow: [...route.methods, 'OPTIONS'].join(', ') });
  }
  try {
    return await api(request, env, ctx, route, url, origin, now);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.code, ...error.extra }, error.status, origin, error.headers);
    console.error('Accounts request failed', error?.message || 'unknown error');
    return json({ error: 'unavailable' }, 503, origin);
  }
}

// ---- hooks for server/scores-api.js ------------------------------------------------------------
// scores-api.js is also concatenated into the old Sites build, so it cannot import this module;
// cloudflare/worker.js hands these in instead. None of them ever throws.
export const scoreAccounts = Object.freeze({
  // Account tables exist (created lazily), so reads can join usernames.
  async ready(env) {
    if (!env.DB) return false;
    try { await ensureAccountTables(env.DB); return true; } catch (error) {
      console.error('Accounts tables unavailable', error?.message || 'unknown error');
      return false;
    }
  },
  // The signed-in account behind this request's Bearer token: { id, username } or null.
  async session(request, env) {
    const secret = signingKey(env);
    const token = bearerToken(request);
    if (!secret || !env.DB || !token) return null;
    try {
      await ensureAccountTables(env.DB);
      const session = await findSession(env.DB, secret, token, Date.now());
      return session ? { id: session.accountId, username: session.username } : null;
    } catch (error) {
      console.error('Accounts session lookup failed', error?.message || 'unknown error');
      return null;
    }
  },
  // Whether a Riftborn account owns this name, case-insensitively (guest name protection).
  async owns(env, name) {
    if (!env.DB || typeof name !== 'string' || !name.trim()) return false;
    try {
      await ensureAccountTables(env.DB);
      return Boolean(await usernameOwner(env.DB, name));
    } catch (error) {
      console.error('Accounts name check failed', error?.message || 'unknown error');
      return false;
    }
  }
});
