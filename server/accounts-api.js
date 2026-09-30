// Riftborn accounts (v2.2) on the leaderboard Worker: OAuth sign-in with Google, Discord or
// GitHub, a Riftborn username chosen by the player, sessions, linked platforms and profile sync.
// Contract: riftborn/docs/design-2.2-accounts.md ("Build spec").
//
// Privacy and security rules this module keeps:
// - Nothing is imported from the platforms: only the opaque user id is read, and it is stored as
//   HMAC(AUTH_SIGNING_KEY, provider + ":" + id). No emails, names, avatars or passwords.
// - Key rotation never locks players out: AUTH_SIGNING_KEY_PREVIOUS (optional) is tried for every
//   lookup after the current key, and a record found with it is re-hashed under the current key.
//   Each identity row carries the id of the key that hashed it; while any row belongs to a key
//   that is neither of the two, accounts answer 503 instead of sending players to signup.
// - Session tokens, login codes, signup tokens, link tickets and OAuth states are random 256-bit
//   values stored only as keyed hashes. Tokens travel in the Authorization header, never in a URL;
//   the game receives only a single-use 60 s login code, in a URL fragment, which redeems only
//   with the client verifier of the page that started the sign-in (and, to link a platform, only
//   together with that account's own session).
// - Return URLs are an exact allow-list (origin + path). Every SQL statement is parameterised.
// - IPs are used only transiently, hashed, as rate-limit keys. No secret or token is ever logged.
// - The "fake" and "fake2" providers exist only in the local harness and are impossible in production.
import { checkUsername, usernameKey } from './username-rules.js';
import { GUEST_NAME_INVISIBLE, lateColumns } from './scores-api.js';
import { AUTH_PUBLIC_BASE, AUTH_RETURN_ORIGINS, AUTH_RETURN_PATHS } from '../site.hosts.mjs';

export const PROVIDERS = Object.freeze(['google', 'discord', 'github']);
// Local-harness providers (see fakeEnabled): two, so linking a second platform can be tested.
export const FAKE_PROVIDERS = Object.freeze(['fake', 'fake2']);
const ALL_PROVIDERS = Object.freeze([...PROVIDERS, ...FAKE_PROVIDERS]);

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const SESSION_MS = 180 * DAY; // sliding: 180 days after the last use...
export const SESSION_MAX_MS = 365 * DAY; // ...but never more than a year after the sign-in
const SESSION_BUMP_MS = DAY;
export const USERNAME_COOLDOWN_MS = 30 * DAY;
export const PENDING_MS = Object.freeze({ state: 10 * MINUTE, login: MINUTE, signup: 15 * MINUTE, link: 5 * MINUTE });
export const PROFILE_MAX = 96 * 1024;
const SMALL_BODY_MAX = 4096;
const SIGNING_KEY_MIN = 32;
const PURGE_EVERY_MS = 10 * MINUTE;
const KEY_RECHECK_MS = MINUTE;

// Fixed-window limits. per: "ip" (hashed; IPv6 by its /64) or "account". With an
// ACCOUNTS_RATE_LIMITER binding (the deployed Worker), the per-IP buckets use it instead of D1:
// IP_BINDING_LIMIT per minute per bucket and IP, and no database write per request.
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
  revoke: { max: 10, windowMs: HOUR, per: 'account' },
  profile: { max: 120, windowMs: HOUR, per: 'account' }
});

export const IP_BINDING_LIMIT = Object.freeze({ limit: 30, period: 60 }); // the binding's own config (upload script)

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization';
// Hosts from site.hosts.mjs: sign-ins return only to https://riftborn.us/ and https://dev.riftborn.us/
// (accounts never run on github.io). AUTH_RETURN_ORIGINS / AUTH_RETURN_PATHS override them (local harness).
const DEFAULT_RETURN_ORIGINS = AUTH_RETURN_ORIGINS.join(',');
const DEFAULT_RETURN_PATHS = AUTH_RETURN_PATHS.join(',');
const DEFAULT_PUBLIC_BASE = AUTH_PUBLIC_BASE; // https://api.riftborn.us
// The client challenge (start ?challenge=, /auth/session {verifier}) is required: /start refuses
// a flow without one, so a login code is useless without the verifier held by the page (tab)
// that started the sign-in. A code lifted from someone else's flow can never be redeemed, and an
// attacker's own code sent to a victim cannot sign the victim in to the attacker's identity.
const REQUIRE_CLIENT_CHALLENGE = true;
const REDIRECT_ERRORS = Object.freeze(['cancelled', 'invalid_state', 'provider_error', 'already_linked', 'provider_unavailable']);

// ---- configuration ---------------------------------------------------------------------------

const isProduction = env => env.ENVIRONMENT === 'production';
const validKey = value => (typeof value === 'string' && value.length >= SIGNING_KEY_MIN ? value : null);
// -> { current, previous } or null. AUTH_SIGNING_KEY hashes everything new. The optional
// AUTH_SIGNING_KEY_PREVIOUS (set after a rotation) is only ever tried for lookups.
export function signingKeys(env) {
  const current = validKey(env.AUTH_SIGNING_KEY);
  if (!current) return null;
  const previous = validKey(env.AUTH_SIGNING_KEY_PREVIOUS);
  return { current, previous: previous && previous !== current ? previous : null };
}
const keyList = keys => (keys.previous ? [keys.current, keys.previous] : [keys.current]);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// The fake providers: FAKE_OAUTH=1, never in production, and only when the Worker itself is being
// reached on a loopback address (the local harness). Any one of the three missing disables them.
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
  if (!signingKeys(env)) return [];
  const list = PROVIDERS.filter(provider => providerCredentials(env, provider));
  if (fakeEnabled(env, url)) list.push(...FAKE_PROVIDERS);
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
  return (origins[0] || AUTH_RETURN_ORIGINS[0]) + (paths[0] || '/');
}

// Every OAuth round trip runs on one public host: /auth/:provider/start sets the __Host- cookie there
// and every redirect_uri points there, so the cookie always comes back to the host that set it.
// AUTH_PUBLIC_BASE (default https://api.riftborn.us in production); a start or callback reached on
// any other host (the workers.dev address) is sent there, same path and query. Without the variable
// a non-production Worker (the local harness) uses the host it is reached on.
export function publicBase(env) {
  const raw = typeof env.AUTH_PUBLIC_BASE === 'string' ? env.AUTH_PUBLIC_BASE.trim().replace(/\/+$/, '') : '';
  if (raw) {
    try {
      const url = new URL(raw);
      const secure = url.protocol === 'https:' || (url.protocol === 'http:' && !isProduction(env) && LOOPBACK.has(url.hostname));
      if (secure && url.origin === raw) return url.origin;
    } catch { /* invalid: fall through to the default */ }
  }
  return isProduction(env) ? DEFAULT_PUBLIC_BASE : null;
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

// A short public id of a signing key (a keyed hash of a constant: it reveals nothing about the key).
// Identity rows record the id of the key that hashed them.
const keyIds = new Map(); // signing key -> Promise<string>, once per isolate
export function keyId(secret) {
  let id = keyIds.get(secret);
  if (!id) {
    id = hmac(secret, 'riftborn-key-check').then(value => value.slice(0, 16));
    keyIds.set(secret, id);
  }
  return id;
}

// ---- username skeletons (guest name protection) ---------------------------------------------------
// A guest cannot post under a name that renders like an account's username. Both sides are reduced
// to a skeleton: compatibility forms folded (NFKD: fullwidth, ligatures, styled letters), accents
// and other combining marks dropped, common Cyrillic, Greek and Latin look-alikes mapped to one
// Latin letter (capital I, 1 and | read as l; 0 as o), lower-cased, and separators, symbols and
// invisible characters dropped: "Victim_Name", "VictimName" with a Cyrillic small ie for the e,
// and the same name in fullwidth letters all meet at "victimname". Accounts store theirs
// (username_skeleton) at create and rename.
const CONFUSABLES = Object.freeze({
  // Latin and digits (case matters here: a capital I looks like l, a small i does not)
  I: 'l', '1': 'l', '|': 'l', '0': 'o', '\u0131': 'i', '\u0237': 'j', '\u0269': 'i', '\u01C0': 'l',
  // Cyrillic capitals
  '\u0410': 'a', '\u0412': 'b', '\u0415': 'e', '\u041A': 'k', '\u041C': 'm', '\u041D': 'h', '\u041E': 'o',
  '\u0420': 'p', '\u0421': 'c', '\u0422': 't', '\u0423': 'y', '\u0425': 'x', '\u0405': 's', '\u0406': 'l',
  '\u0408': 'j', '\u04AE': 'y', '\u04C0': 'l', '\u051A': 'q', '\u051C': 'w', '\u0417': '3',
  // Cyrillic small
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x',
  '\u0455': 's', '\u0456': 'i', '\u0458': 'j', '\u0501': 'd', '\u04BB': 'h', '\u051B': 'q', '\u051D': 'w',
  '\u04CF': 'l', '\u04AF': 'y', '\u043A': 'k', '\u0433': 'r', '\u0457': 'i',
  // Greek capitals
  '\u0391': 'a', '\u0392': 'b', '\u0395': 'e', '\u0396': 'z', '\u0397': 'h', '\u0399': 'l', '\u039A': 'k',
  '\u039C': 'm', '\u039D': 'n', '\u039F': 'o', '\u03A1': 'p', '\u03A4': 't', '\u03A5': 'y', '\u03A7': 'x',
  // Greek small
  '\u03B1': 'a', '\u03BF': 'o', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v', '\u03C1': 'p', '\u03C5': 'u',
  '\u03C7': 'x', '\u03F2': 'c', '\u03F3': 'j', '\u03B5': 'e', '\u03C4': 't',
  // Armenian
  '\u0585': 'o', '\u0570': 'h', '\u057D': 'u', '\u0578': 'n'
});
// Dropped: punctuation, symbols, spaces, control and format characters, and letters that render as
// blank space (Hangul fillers, the braille blank).
const SKELETON_DROP = /[\p{P}\p{S}\p{Z}\p{C}\u115F\u1160\u3164\uFFA0\u2800]/gu;

export function nameSkeleton(raw) {
  const text = String(raw ?? '').normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  for (const char of text) out += CONFUSABLES[char] ?? char;
  return out.toLowerCase().replace(SKELETON_DROP, '');
}

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

// Whether this request carries the nonce whose hash the state row kept (under either key).
async function sameBrowser(request, keys, expected) {
  const nonce = readBrowserNonce(request);
  if (!nonce || typeof expected !== 'string') return false;
  for (const secret of keyList(keys)) if (sameSecret(await browserHash(secret, nonce), expected)) return true;
  return false;
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
    username_skeleton TEXT,
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
    key_id TEXT,
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
// Columns added after the first 2.2 build: a database made by it (the local harness) gets them here.
const LATE_ACCOUNT_COLUMNS = Object.freeze([['accounts', 'username_skeleton'], ['identities', 'key_id']]);
const LATE_INDEXES = Object.freeze([
  'CREATE INDEX IF NOT EXISTS idx_accounts_skeleton ON accounts (username_skeleton)',
  'CREATE INDEX IF NOT EXISTS idx_identities_key ON identities (key_id)'
]);
const tablesReady = new WeakMap(); // DB binding -> Promise, once per isolate

async function runAll(db, statements) {
  if (typeof db.batch === 'function') await db.batch(statements.map(sql => db.prepare(sql)));
  else for (const sql of statements) await db.prepare(sql).run();
}

export function ensureAccountTables(db) {
  let promise = tablesReady.get(db);
  if (!promise) {
    promise = (async () => {
      await runAll(db, SCHEMA);
      for (const [table, column] of LATE_ACCOUNT_COLUMNS) {
        const info = await db.prepare(`PRAGMA table_info('${table}')`).all();
        if ((info?.results || []).some(row => row?.name === column)) continue;
        try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).run(); } catch (error) {
          if (!/duplicate column/i.test(String(error?.message || error))) throw error; // else another isolate added it
        }
      }
      await runAll(db, LATE_INDEXES);
      // Accounts from before skeletons existed get theirs (guest name protection compares them).
      const missing = (await db.prepare('SELECT id, username FROM accounts WHERE username_skeleton IS NULL LIMIT 1000').all())?.results || [];
      for (const row of missing) await db.prepare('UPDATE accounts SET username_skeleton = ? WHERE id = ?').bind(nameSkeleton(row.username), row.id).run();
    })();
    tablesReady.set(db, promise);
    promise.catch(() => tablesReady.delete(db)); // a failed bootstrap retries on the next request
  }
  return promise;
}

const lastPurge = new WeakMap(); // DB binding -> ms
// Opportunistic cleanup (at most every 10 minutes per isolate, while accounts are in use): expired
// single-use values, expired or year-old sessions, and limiter windows over two hours old.
function purgeExpired(db, ctx, now) {
  if (now - (lastPurge.get(db) || 0) < PURGE_EVERY_MS) return;
  lastPurge.set(db, now);
  const work = Promise.resolve().then(() => db.batch([
    db.prepare('DELETE FROM auth_pending WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR created_at IS NULL OR created_at <= ?').bind(now, now - SESSION_MAX_MS),
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 2 * HOUR)
  ])).catch(error => console.error('Accounts purge failed', error?.message || 'unknown error'));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  return work;
}

const changes = result => Number(result?.meta?.changes ?? result?.changes ?? 0);

// ---- rate limits -----------------------------------------------------------------------------

// The rate-limit subject for an address: IPv4 as it is, IPv6 by its /64 prefix (one subscriber's
// network), so rotating addresses inside a /64 does not reset a bucket.
export function ipSubject(raw) {
  const ip = String(raw || '').trim().toLowerCase();
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.slice(0, 4).map(group => (group || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
const clientIp = request => ipSubject(request.headers.get('CF-Connecting-IP'));

const tooMany = retry => fail('rate_limited', 429, { retryAfter: retry }, { 'Retry-After': String(retry) });

async function rateLimit(env, db, keys, bucket, subject, now) {
  const rule = LIMITS[bucket];
  const key = await hmac(keys.current, `rl:${bucket}:${subject}`);
  const binding = env?.ACCOUNTS_RATE_LIMITER;
  if (rule.per === 'ip' && binding && typeof binding.limit === 'function') {
    const { success } = await binding.limit({ key });
    if (!success) tooMany(IP_BINDING_LIMIT.period);
    return;
  }
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
  // Once a window's count is past the limit the row is left alone (the WHERE fails and nothing is
  // returned), so a flood costs no further writes.
  const row = await db.prepare(
    'INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ' +
    'ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END, ' +
    'window_start = excluded.window_start WHERE rate_limits.window_start <> excluded.window_start OR rate_limits.count <= ? RETURNING count'
  ).bind(key, windowStart, rule.max).first();
  if (!row || Number(row.count) > rule.max) tooMany(Math.max(1, Math.ceil((windowStart + rule.windowMs - now) / 1000)));
}
const limitIp = (env, db, keys, bucket, request, now) => rateLimit(env, db, keys, bucket, 'ip:' + clientIp(request), now);
const limitAccount = (db, keys, bucket, accountId, now) => rateLimit(null, db, keys, bucket, 'account:' + accountId, now);

// ---- single-use values -----------------------------------------------------------------------

async function putPending(db, keys, kind, data, now) {
  const raw = randomToken();
  const expiresAt = now + PENDING_MS[kind];
  await db.prepare('INSERT INTO auth_pending (key, kind, data, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await pendingHash(keys.current, raw), kind, JSON.stringify(data), expiresAt).run();
  return { raw, expiresAt };
}

const parseData = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : null; } catch { return null; } };

// Consumes the value (DELETE ... RETURNING): a second use finds nothing. Expired -> null.
// Either key is tried: a value made just before a key rotation still works.
async function takePending(db, keys, kind, raw, now) {
  if (typeof raw !== 'string' || !TOKEN.test(raw)) return null;
  for (const secret of keyList(keys)) {
    const row = await db.prepare('DELETE FROM auth_pending WHERE key = ? AND kind = ? RETURNING data, expires_at')
      .bind(await pendingHash(secret, raw), kind).first();
    if (row) return Number(row.expires_at) > now ? parseData(row.data) : null;
  }
  return null;
}

// Reads without consuming (a signup token survives a "username taken" retry).
async function peekPending(db, keys, kind, raw, now) {
  if (typeof raw !== 'string' || !TOKEN.test(raw)) return null;
  for (const secret of keyList(keys)) {
    const key = await pendingHash(secret, raw);
    const row = await db.prepare('SELECT data, expires_at FROM auth_pending WHERE key = ? AND kind = ?').bind(key, kind).first();
    if (!row) continue;
    if (!(Number(row.expires_at) > now)) return null;
    const data = parseData(row.data);
    return data ? { key, data } : null;
  }
  return null;
}

// ---- sessions and accounts -------------------------------------------------------------------

function bearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec((request.headers.get('Authorization') || '').trim());
  return match ? match[1] : null;
}

async function newSession(db, keys, accountId, now) {
  const token = randomToken();
  const expiresAt = now + SESSION_MS;
  const statement = db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)')
    .bind(await sessionHash(keys.current, token), accountId, now, expiresAt, now);
  return { token, expiresAt, statement };
}

const SESSION_SELECT = 'SELECT s.account_id AS account_id, s.created_at AS created_at, s.expires_at AS expires_at, s.last_seen AS last_seen, ' +
  'a.username AS username FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?';

// -> { accountId, username, tokenHash } or null. Live sessions slide (last_seen and expires_at
// bumped at most once a day) but never past a year after the sign-in; expired ones are deleted.
// A session made before a key rotation (found with the previous key) is re-hashed in place.
async function findSession(db, keys, token, now) {
  if (!token) return null;
  const tokenHash = await sessionHash(keys.current, token);
  let row = await db.prepare(SESSION_SELECT).bind(tokenHash).first();
  if (!row && keys.previous) {
    const oldHash = await sessionHash(keys.previous, token);
    row = await db.prepare(SESSION_SELECT).bind(oldHash).first();
    if (row) await db.prepare('UPDATE sessions SET token_hash = ? WHERE token_hash = ?').bind(tokenHash, oldHash).run();
  }
  if (!row) return null;
  const cap = Number(row.created_at || 0) + SESSION_MAX_MS;
  if (!(Number(row.expires_at) > now) || !(cap > now)) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (now - Number(row.last_seen || 0) >= SESSION_BUMP_MS) {
    await db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').bind(now, Math.min(now + SESSION_MS, cap), tokenHash).run();
  }
  return { accountId: row.account_id, username: row.username, tokenHash };
}

async function requireSession(db, keys, request, now) {
  const session = await findSession(db, keys, bearerToken(request), now);
  if (!session) fail('unauthorized', 401, {}, { 'WWW-Authenticate': 'Bearer' });
  return session;
}

// Keeps only the session making the request (after a link, an unlink, or "sign out other
// devices"): a session stolen earlier stops working. -> the number of sessions ended.
async function revokeOtherSessions(db, session) {
  return changes(await db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?').bind(session.accountId, session.tokenHash).run());
}

// ---- key rotation guard ------------------------------------------------------------------------
// Every identity row records the id of the key that hashed it. If a row belongs to a key that is
// neither AUTH_SIGNING_KEY nor AUTH_SIGNING_KEY_PREVIOUS, the key was changed without the old one
// being kept: lookups would miss and send returning players to signup (where their own username
// is "taken"). Accounts answer 503 accounts_unavailable instead, and the log says why, until the
// old key is restored (as AUTH_SIGNING_KEY or AUTH_SIGNING_KEY_PREVIOUS). Checked once per isolate
// (a failed check again after a minute).
const keyChecks = new WeakMap(); // DB binding -> Map(key pair -> { ok, at, promise })

function keysUsable(db, keys, now) {
  let checks = keyChecks.get(db);
  if (!checks) keyChecks.set(db, (checks = new Map()));
  const pair = keys.current + '\n' + (keys.previous || '');
  const cached = checks.get(pair);
  if (cached && (cached.ok !== false || now - cached.at < KEY_RECHECK_MS)) return cached.promise;
  const entry = { ok: null, at: now, promise: null };
  entry.promise = (async () => {
    const [current, previous = current] = await Promise.all(keyList(keys).map(keyId));
    const foreign = await db.prepare('SELECT 1 AS found FROM identities WHERE key_id IS NOT NULL AND key_id <> ? AND key_id <> ? LIMIT 1')
      .bind(current, previous).first();
    if (foreign) {
      console.error('Accounts OFF: some platform identities were hashed with a signing key that is neither AUTH_SIGNING_KEY nor ' +
        'AUTH_SIGNING_KEY_PREVIOUS. Restore the old key (as AUTH_SIGNING_KEY, or as AUTH_SIGNING_KEY_PREVIOUS next to the new ' +
        'one) and redeploy; until then sign-ins answer 503 so no player is sent to signup.');
    }
    entry.ok = !foreign;
    return entry.ok;
  })();
  entry.promise.catch(() => checks.delete(pair)); // a failed query is retried on the next request
  checks.set(pair, entry);
  return entry.promise;
}

async function requireUsableKeys(db, keys, now) {
  if (!(await keysUsable(db, keys, now))) fail('accounts_unavailable', 503);
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

// Guest name protection: an account whose username equals the name (any letter case) or renders
// like it. The skeleton keeps "capital I reads as l", so the name is compared as typed, all lower
// case and all upper case ("VICTIM-NAME" meets "VictimName", "lllidan" meets "Illidan", while
// "Kal" does not meet "Kai").
async function nameProtected(db, name) {
  const trimmed = String(name).trim();
  const skeletons = [...new Set([trimmed, trimmed.toLowerCase(), trimmed.toUpperCase()].map(nameSkeleton))].filter(Boolean);
  const row = await db.prepare(`SELECT id FROM accounts WHERE username = ?${skeletons.length ? ` OR username_skeleton IN (${skeletons.map(() => '?').join(', ')})` : ''} LIMIT 1`)
    .bind(trimmed, ...skeletons).first();
  return Boolean(row);
}

// Identities: lookups by hash; a row found only with the previous key is re-hashed under the
// current one (and takes the current key's id).
const IDENTITY_SELECT = 'SELECT account_id FROM identities WHERE provider = ? AND provider_user_id = ?';

async function identityOwner(db, provider, identity) {
  const row = await db.prepare(IDENTITY_SELECT).bind(provider, identity).first();
  return row ? row.account_id : null;
}

// -> { identity (current-key hash), accountId (or null) }
async function findIdentity(db, keys, provider, platformId) {
  const identity = await identityHash(keys.current, provider, platformId);
  const accountId = await identityOwner(db, provider, identity);
  if (accountId || !keys.previous) return { identity, accountId };
  const oldHash = await identityHash(keys.previous, provider, platformId);
  const legacy = await identityOwner(db, provider, oldHash);
  if (!legacy) return { identity, accountId: null };
  try {
    await db.prepare('UPDATE identities SET provider_user_id = ?, key_id = ? WHERE provider = ? AND provider_user_id = ?')
      .bind(identity, await keyId(keys.current), provider, oldHash).run();
  } catch (error) {
    if (!isUniqueError(error, 'identities')) throw error; // a parallel sign-in re-hashed it first
  }
  return { identity, accountId: legacy };
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
    token: 'https://discord.com/api/v10/oauth2/token',
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

const callbackUrl = (request, env, provider) => `${publicBase(env) || new URL(request.url).origin}/auth/${provider}/callback`;
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
    id = (await fetchUserJson('https://discord.com/api/v10/users/@me', tokens.access_token))?.id;
  } else if (provider === 'github') {
    id = (await fetchUserJson('https://api.github.com/user', tokens.access_token, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }))?.id;
  }
  if ((typeof id !== 'string' && !Number.isSafeInteger(id)) || !PROVIDER_ID.test(String(id))) throw new ProviderError(`${provider} user id missing`);
  return String(id);
}

// ---- /auth/:provider/start and /callback (top-level navigations) -----------------------------

function fakeProviderPage(provider, state, extraHeaders = {}) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fake sign-in: ${provider} (local harness)</title>
<style>body{font:16px system-ui,sans-serif;background:#12101a;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#1f1b2d;padding:24px;border-radius:10px;max-width:360px;width:calc(100% - 32px)}h1{font-size:20px;margin:0 0 8px}
p{color:#aaa;font-size:14px}label{display:block;margin:16px 0 8px}input{width:100%;box-sizing:border-box;padding:8px;font:inherit}
.row{display:flex;gap:8px;margin-top:16px}button{flex:1;padding:10px;font:inherit;cursor:pointer}</style></head>
<body><main><h1>Fake provider: ${provider}</h1><p>Local harness only. Any id signs in as that fake platform user; the same id returns to the same account.</p>
<form method="get" action="/auth/${provider}/callback" id="ok"><input type="hidden" name="state" value="${state}">
<label for="code">Fake user id</label><input id="code" name="code" value="player-1" required maxlength="64" pattern="[A-Za-z0-9_\\-]{1,64}" autofocus></form>
<form method="get" action="/auth/${provider}/callback" id="cancel"><input type="hidden" name="state" value="${state}"><input type="hidden" name="error" value="access_denied"></form>
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

async function oauthStart(request, env, db, keys, provider, now) {
  const url = new URL(request.url);
  const returnUrl = checkReturnUrl(url.searchParams.get('return'), env);
  if (!returnUrl) fail('invalid_return', 400);
  const fake = FAKE_PROVIDERS.includes(provider);
  const creds = fake ? null : providerCredentials(env, provider);
  if (!fake && !creds) fail('provider_unavailable', 503);
  const mode = url.searchParams.get('mode') || 'login';
  if (mode !== 'login' && mode !== 'link') fail('invalid_mode', 400);
  // Client binding: the game sends SHA-256(verifier) here and the verifier to /auth/session, so the
  // login code only works for the page that started this flow (see exchangeLoginCode).
  const challenge = url.searchParams.get('challenge');
  if (challenge !== null && !TOKEN.test(challenge)) fail('invalid_challenge', 400);
  if (REQUIRE_CLIENT_CHALLENGE && challenge === null) fail('challenge_required', 400);
  await limitIp(env, db, keys, 'start', request, now);

  let accountId = null;
  if (mode === 'link') {
    const ticket = await takePending(db, keys, 'link', url.searchParams.get('ticket'), now);
    if (!ticket || typeof ticket.accountId !== 'string') return errorToGame(returnUrl, 'invalid_state');
    accountId = ticket.accountId;
  }
  const nonce = readBrowserNonce(request) || randomToken();
  const verifier = fake ? null : randomToken();
  const { raw: state } = await putPending(db, keys, 'state', {
    provider, verifier, returnUrl, mode, accountId, challenge, browser: await browserHash(keys.current, nonce)
  }, now);
  const cookie = { 'Set-Cookie': browserCookie(request, nonce) };
  if (fake) return fakeProviderPage(provider, state, cookie);

  const target = new URL(OAUTH[provider].authorize);
  const params = {
    client_id: creds.id,
    redirect_uri: callbackUrl(request, env, provider),
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

async function oauthCallback(request, env, db, keys, provider, now) {
  const url = new URL(request.url);
  await limitIp(env, db, keys, 'callback', request, now);
  const state = await takePending(db, keys, 'state', url.searchParams.get('state'), now);
  if (!state || state.provider !== provider || !checkReturnUrl(state.returnUrl, env)) return errorToGame(defaultReturn(env), 'invalid_state');
  const returnUrl = state.returnUrl;
  if (!(await sameBrowser(request, keys, state.browser))) return errorToGame(returnUrl, 'invalid_state');
  const providerError = url.searchParams.get('error');
  if (providerError) return errorToGame(returnUrl, providerError === 'access_denied' ? 'cancelled' : 'provider_error');
  const code = url.searchParams.get('code');
  if (typeof code !== 'string' || !code || code.length > 2048 || /[\u0000-\u001f\u007f]/.test(code)) return errorToGame(returnUrl, 'provider_error');

  let platformId;
  if (FAKE_PROVIDERS.includes(provider)) {
    if (!PROVIDER_ID.test(code) || code.length > 64) return errorToGame(returnUrl, 'provider_error');
    platformId = code;
  } else {
    const creds = providerCredentials(env, provider);
    if (!creds) return errorToGame(returnUrl, 'provider_unavailable');
    try {
      platformId = await providerUserId(provider, creds, code, state.verifier, callbackUrl(request, env, provider), now);
    } catch (error) {
      console.error('Accounts: sign-in with ' + provider + ' failed', error instanceof ProviderError ? error.message : (error?.name || 'error'));
      return errorToGame(returnUrl, 'provider_error');
    }
  }
  const { identity, accountId: owner } = await findIdentity(db, keys, provider, platformId);
  const challenge = state.challenge ?? null;

  if (state.mode === 'link') {
    // Nothing is linked here. The link completes at /auth/session, and only for the page holding
    // this flow's verifier AND that account's own session: a link flow started with someone else's
    // ticket and finished in this browser can never attach this platform to their account.
    const accountId = state.accountId;
    if (typeof accountId !== 'string') return errorToGame(returnUrl, 'invalid_state');
    // Read-only checks, so the usual refusals come back at once (repeated at /auth/session).
    if (owner && owner !== accountId) return errorToGame(returnUrl, 'already_linked');
    if (!owner && await hasProvider(db, accountId, provider)) return errorToGame(returnUrl, 'already_linked');
    const { raw } = await putPending(db, keys, 'login', { type: 'link', provider, identity, accountId, challenge }, now);
    return backToGame(returnUrl, 'rb_login', raw);
  }

  const login = owner ? { type: 'account', accountId: owner, challenge } : { type: 'signup', provider, identity, challenge };
  const { raw } = await putPending(db, keys, 'login', login, now);
  return backToGame(returnUrl, 'rb_login', raw);
}

const hasProvider = async (db, accountId, provider) =>
  Boolean(await db.prepare('SELECT 1 AS found FROM identities WHERE account_id = ? AND provider = ?').bind(accountId, provider).first());

// ---- API routes ------------------------------------------------------------------------------

async function exchangeLoginCode(request, env, db, keys, now) {
  await limitIp(env, db, keys, 'session', request, now);
  const body = await readJson(request, SMALL_BODY_MAX);
  const login = await takePending(db, keys, 'login', body.code, now);
  if (!login) fail('expired', 400);
  // A code only completes for the page holding its flow's verifier (every flow has a challenge).
  if (login.challenge || REQUIRE_CLIENT_CHALLENGE || login.type === 'link') {
    const verifier = typeof body.verifier === 'string' && TOKEN.test(body.verifier) ? body.verifier : null;
    if (!login.challenge || !verifier || !sameSecret(await sha256(verifier), login.challenge)) fail('expired', 400);
  }
  if (login.type === 'account') {
    const account = await loadAccount(db, login.accountId, now);
    if (!account) fail('expired', 400);
    const session = await newSession(db, keys, account.id, now);
    await session.statement.run();
    return { token: session.token, expiresAt: session.expiresAt, account };
  }
  if (login.type === 'signup') {
    // The signup token is minted here, so no raw secret ever sits in the database.
    const { raw, expiresAt } = await putPending(db, keys, 'signup', { provider: login.provider, identity: login.identity }, now);
    return { needsUsername: true, signupToken: raw, expiresAt };
  }
  if (login.type === 'link') return completeLink(request, db, keys, login, now);
  fail('expired', 400);
}

// The second half of linking a platform: the code (with its verifier) plus the account's own
// session, sent together by the game page that asked for the link ticket.
async function completeLink(request, db, keys, login, now) {
  const session = await findSession(db, keys, bearerToken(request), now);
  if (!session) fail('unauthorized', 401, {}, { 'WWW-Authenticate': 'Bearer' });
  if (session.accountId !== login.accountId) fail('wrong_account', 403);
  const { provider, identity } = login;
  if (!ALL_PROVIDERS.includes(provider) || typeof identity !== 'string') fail('expired', 400);
  const owner = await identityOwner(db, provider, identity);
  if (owner && owner !== session.accountId) fail('already_linked', 409);
  let revoked = 0;
  if (!owner) {
    // One identity per platform per account (unlink the old one first to switch), checked in the
    // same statement as the insert so two parallel links cannot both pass.
    let result;
    try {
      result = await db.prepare(
        'INSERT INTO identities (provider, provider_user_id, account_id, created_at, key_id) SELECT ?, ?, ?, ?, ? ' +
        'WHERE NOT EXISTS (SELECT 1 FROM identities WHERE account_id = ? AND provider = ?)'
      ).bind(provider, identity, session.accountId, now, await keyId(keys.current), session.accountId, provider).run();
    } catch (error) {
      if (!isUniqueError(error, 'identities')) throw error;
      fail('already_linked', 409); // linked elsewhere a moment ago
    }
    if (!changes(result)) fail('already_linked', 409);
    revoked = await revokeOtherSessions(db, session);
  }
  return { linked: provider, account: await loadAccount(db, session.accountId, now), revoked };
}

async function signInExisting(db, keys, accountId, signupKey, now) {
  const session = await newSession(db, keys, accountId, now);
  await db.batch([session.statement, db.prepare('DELETE FROM auth_pending WHERE key = ?').bind(signupKey)]);
  return { token: session.token, expiresAt: session.expiresAt, account: await loadAccount(db, accountId, now) };
}

async function createAccount(request, env, db, keys, now) {
  await limitIp(env, db, keys, 'create', request, now);
  const body = await readJson(request, SMALL_BODY_MAX);
  const check = checkUsername(typeof body.username === 'string' ? body.username : '');
  const pending = await peekPending(db, keys, 'signup', body.signupToken, now);
  if (!pending || !ALL_PROVIDERS.includes(pending.data.provider) || typeof pending.data.identity !== 'string') fail('expired', 400);
  const { provider, identity } = pending.data;
  // Already registered (a second tab finished first): that proves the same identity, so sign in.
  const findOwner = () => db.prepare('SELECT account_id FROM identities WHERE provider = ? AND provider_user_id = ?').bind(provider, identity).first();
  const existing = await findOwner();
  if (existing) return signInExisting(db, keys, existing.account_id, pending.key, now);
  if (!check.ok) usernameError(check);
  if (await usernameOwner(db, check.name)) fail('taken', 409);

  const id = crypto.randomUUID();
  const session = await newSession(db, keys, id, now);
  try {
    await db.batch([
      db.prepare('INSERT INTO accounts (id, username, username_skeleton, created_at, username_changed_at, profile_json, profile_rev, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 0, ?)')
        .bind(id, check.name, nameSkeleton(check.name), now, now),
      db.prepare('INSERT INTO identities (provider, provider_user_id, account_id, created_at, key_id) VALUES (?, ?, ?, ?, ?)')
        .bind(provider, identity, id, now, await keyId(keys.current)),
      session.statement,
      db.prepare('DELETE FROM auth_pending WHERE key = ?').bind(pending.key)
    ]);
  } catch (error) {
    const raced = await findOwner();
    if (raced) return signInExisting(db, keys, raced.account_id, pending.key, now);
    if (isUniqueError(error, 'accounts.username') || await usernameOwner(db, check.name)) fail('taken', 409);
    throw error;
  }
  return { token: session.token, expiresAt: session.expiresAt, account: await loadAccount(db, id, now) };
}

async function renameAccount(request, db, keys, session, now) {
  await limitAccount(db, keys, 'rename', session.accountId, now);
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
    // The skeleton follows every change, letter case included (a capital I reads as l).
    await db.prepare(caseOnly
      ? 'UPDATE accounts SET username = ?, username_skeleton = ?, updated_at = ? WHERE id = ?'
      : 'UPDATE accounts SET username = ?, username_skeleton = ?, updated_at = ?, username_changed_at = ? WHERE id = ?')
      .bind(...(caseOnly ? [check.name, nameSkeleton(check.name), now, session.accountId] : [check.name, nameSkeleton(check.name), now, now, session.accountId])).run();
  } catch (error) {
    if (isUniqueError(error, 'accounts.username')) fail('taken', 409);
    throw error;
  }
  return { account: await loadAccount(db, session.accountId, now) };
}

async function deleteAccount(db, keys, session, now) {
  await limitAccount(db, keys, 'remove', session.accountId, now);
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

async function unlinkProvider(db, keys, session, provider, now) {
  if (!ALL_PROVIDERS.includes(provider)) fail('not_found', 404);
  await limitAccount(db, keys, 'unlink', session.accountId, now);
  // One statement, so two parallel unlinks can never remove the last identity.
  const result = await db.prepare(
    'DELETE FROM identities WHERE account_id = ? AND provider = ? AND (SELECT COUNT(*) FROM identities WHERE account_id = ?) > 1'
  ).bind(session.accountId, provider, session.accountId).run();
  if (!changes(result)) {
    const linked = await db.prepare('SELECT 1 AS found FROM identities WHERE account_id = ? AND provider = ?').bind(session.accountId, provider).first();
    if (!linked) fail('not_linked', 404);
    fail('last_identity', 409);
  }
  // Only this device stays signed in: whoever signed in through the removed platform is out.
  const revoked = await revokeOtherSessions(db, session);
  return { account: await loadAccount(db, session.accountId, now), revoked };
}

async function readProfile(db, session) {
  const row = await db.prepare('SELECT profile_json, profile_rev, updated_at FROM accounts WHERE id = ?').bind(session.accountId).first();
  if (!row) fail('unauthorized', 401, {}, { 'WWW-Authenticate': 'Bearer' });
  let profile = null;
  try { profile = row.profile_json ? JSON.parse(row.profile_json) : null; } catch { profile = null; }
  return { profile, rev: Number(row.profile_rev) || 0, updatedAt: row.updated_at ?? null };
}

async function writeProfile(request, db, keys, session, now) {
  await limitAccount(db, keys, 'profile', session.accountId, now);
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
  if ((match = /^\/auth\/([a-z0-9]{1,16})\/(start|callback)$/.exec(path))) return { name: match[2], provider: match[1], navigation: true };
  if (path === '/auth/session') return { name: 'session', methods: ['POST'] };
  if (path === '/auth/logout') return { name: 'logout', methods: ['POST'] };
  if (path === '/api/auth/providers') return { name: 'providers', methods: ['GET'] };
  if (path === '/api/username-available') return { name: 'check', methods: ['GET'] };
  if (path === '/api/account') return { name: 'account', methods: ['GET', 'POST', 'PATCH', 'DELETE'] };
  if (path === '/api/account/link-ticket') return { name: 'ticket', methods: ['POST'] };
  if ((match = /^\/api\/account\/identities\/([a-z0-9]{1,16})$/.exec(path))) return { name: 'unlink', methods: ['DELETE'], provider: match[1] };
  if (path === '/api/profile') return { name: 'profile', methods: ['GET', 'PUT'] };
  if (path.startsWith('/auth/') || path === '/auth' || path.startsWith('/api/account') || path.startsWith('/api/auth')) return { name: 'unknown', methods: [] };
  return null;
}

async function navigation(request, env, ctx, route, url, now) {
  const keys = signingKeys(env);
  const known = PROVIDERS.includes(route.provider) || (FAKE_PROVIDERS.includes(route.provider) && fakeEnabled(env, url));
  if (!known) return json({ error: 'not_found' }, 404);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, null, { Allow: 'GET' });
  // One sign-in host (see publicBase): a start or callback that arrives elsewhere goes there first.
  const base = publicBase(env);
  if (base && url.origin !== base) return redirect(base + url.pathname + url.search);
  if (!keys || !env.DB) {
    if (route.name === 'start') return json({ error: 'provider_unavailable' }, 503);
    return errorToGame(defaultReturn(env), 'provider_unavailable');
  }
  try {
    await ensureAccountTables(env.DB);
    await requireUsableKeys(env.DB, keys, now);
    purgeExpired(env.DB, ctx, now);
    return route.name === 'start'
      ? await oauthStart(request, env, env.DB, keys, route.provider, now)
      : await oauthCallback(request, env, env.DB, keys, route.provider, now);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'accounts_unavailable') {
      // Signing keys out of step (see keysUsable): back to the game, never to a signup.
      const back = route.name === 'start' ? checkReturnUrl(url.searchParams.get('return'), env) : null;
      return errorToGame(back || defaultReturn(env), 'provider_unavailable');
    }
    if (error instanceof ApiError) return json({ error: error.code, ...error.extra }, error.status, null, error.headers);
    console.error('Accounts sign-in failed', error?.message || 'unknown error');
    if (route.name === 'callback') return errorToGame(defaultReturn(env), 'provider_error');
    return json({ error: 'unavailable' }, 503);
  }
}

async function api(request, env, ctx, route, url, origin, now) {
  if (route.name === 'providers') return json({ providers: availableProviders(env, url) }, 200, origin);
  const keys = signingKeys(env);
  if (!keys || !env.DB) return json({ error: 'accounts_unavailable' }, 503, origin);
  const db = env.DB;
  await ensureAccountTables(db);
  await requireUsableKeys(db, keys, now);
  purgeExpired(db, ctx, now);
  const method = request.method;

  switch (route.name) {
    case 'session': return json(await exchangeLoginCode(request, env, db, keys, now), 200, origin);
    case 'logout': {
      const token = bearerToken(request);
      if (!token) fail('unauthorized', 401, {}, { 'WWW-Authenticate': 'Bearer' });
      const body = (request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json') ? await readJson(request, SMALL_BODY_MAX) : {};
      if (body.all === true) {
        // "Sign out other devices": every other session of the account ends; this one stays.
        const session = await requireSession(db, keys, request, now);
        await limitAccount(db, keys, 'revoke', session.accountId, now);
        return json({ ok: true, revoked: await revokeOtherSessions(db, session) }, 200, origin);
      }
      const hashes = await Promise.all(keyList(keys).map(secret => sessionHash(secret, token)));
      await db.prepare(`DELETE FROM sessions WHERE token_hash IN (${hashes.map(() => '?').join(', ')})`).bind(...hashes).run();
      return json({ ok: true }, 200, origin);
    }
    case 'check': {
      await limitIp(env, db, keys, 'check', request, now);
      const name = url.searchParams.get('name') || '';
      if (url.searchParams.get('guest') === '1') {
        // A guest's run name, checked exactly as POST /api/scores will: NFKC form, 1-16 characters,
        // no invisible characters ("invalid"), and no account username in any letter case or
        // look-alike form ("taken"). Guest names follow no account rules otherwise (spaces are fine).
        const guest = name.length > 64 ? '' : name.normalize('NFKC').trim();
        if (!guest || guest.length > 16 || GUEST_NAME_INVISIBLE.test(guest)) return json({ available: false, reason: 'invalid' }, 200, origin);
        return json(await nameProtected(db, guest) ? { available: false, reason: 'taken' } : { available: true }, 200, origin);
      }
      const check = checkUsername(name.length > 64 ? '' : name);
      if (!check.ok) return json({ available: false, reason: check.reason === 'reserved' ? 'reserved' : 'invalid' }, 200, origin);
      const owner = await usernameOwner(db, check.name);
      if (owner) {
        // Your own name (for a letter-case change) is available to you.
        const session = await findSession(db, keys, bearerToken(request), now);
        if (!session || session.accountId !== owner) return json({ available: false, reason: 'taken' }, 200, origin);
      }
      return json({ available: true }, 200, origin);
    }
    case 'account': {
      if (method === 'POST') return json(await createAccount(request, env, db, keys, now), 200, origin);
      const session = await requireSession(db, keys, request, now);
      if (method === 'GET') {
        const account = await loadAccount(db, session.accountId, now);
        if (!account) fail('unauthorized', 401, {}, { 'WWW-Authenticate': 'Bearer' });
        return json({ account }, 200, origin);
      }
      if (method === 'PATCH') return json(await renameAccount(request, db, keys, session, now), 200, origin);
      return json(await deleteAccount(db, keys, session, now), 200, origin);
    }
    case 'ticket': {
      const session = await requireSession(db, keys, request, now);
      await limitAccount(db, keys, 'ticket', session.accountId, now);
      const { raw, expiresAt } = await putPending(db, keys, 'link', { accountId: session.accountId }, now);
      return json({ ticket: raw, expiresAt }, 200, origin);
    }
    case 'unlink': {
      const session = await requireSession(db, keys, request, now);
      return json(await unlinkProvider(db, keys, session, route.provider, now), 200, origin);
    }
    case 'profile': {
      const session = await requireSession(db, keys, request, now);
      if (method === 'GET') return json(await readProfile(db, session), 200, origin);
      return json(await writeProfile(request, db, keys, session, now), 200, origin);
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
  // The signed-in account behind this request's Bearer token: { id, username } or null, or
  // { unavailable: true } while the signing keys are out of step (the score should wait, not post
  // as a guest).
  async session(request, env) {
    const keys = signingKeys(env);
    const token = bearerToken(request);
    if (!keys || !env.DB || !token) return null;
    try {
      await ensureAccountTables(env.DB);
      if (!(await keysUsable(env.DB, keys, Date.now()))) return { unavailable: true };
      const session = await findSession(env.DB, keys, token, Date.now());
      return session ? { id: session.accountId, username: session.username } : null;
    } catch (error) {
      console.error('Accounts session lookup failed', error?.message || 'unknown error');
      return null;
    }
  },
  // Whether a Riftborn account's username is this name in any letter case, or renders like it
  // (the same skeleton, see nameSkeleton): guest name protection.
  async owns(env, name) {
    if (!env.DB || typeof name !== 'string' || !name.trim()) return false;
    try {
      await ensureAccountTables(env.DB);
      return await nameProtected(env.DB, name);
    } catch (error) {
      console.error('Accounts name check failed', error?.message || 'unknown error');
      return false;
    }
  }
});
