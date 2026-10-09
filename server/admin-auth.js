// Admin authorization shared by the feedback inbox and the player-metrics stats page (both sit behind the same
// admin key): the response helpers with their CORS headers, the origin rules, the constant-time key check and the
// per-IP admin rate limit. Moved here from server/feedback-api.js without a change in behaviour so server/stats-api.js
// can use it too. No IP address is ever stored: CF-Connecting-IP only becomes a rate-limit key, as a keyed hash
// (ipLimitKey) wherever the Worker has its signing key.
import { ipLimitKey } from './accounts-api.js';

export const CORS_METHODS = 'GET, POST, PATCH, OPTIONS';
export const CORS_ALLOW_HEADERS = 'Content-Type, Authorization';

export function corsHeaders(origin) {
  return origin ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Expose-Headers': 'Content-Disposition'
  } : {};
}

export const json = (value, status = 200, origin = null, extra = {}) => new Response(JSON.stringify(value), {
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

// Same origin rule as server/scores-api.js (kept separate so the score route stays untouched).
// These origins (the games) submit feedback; they have always been able to reach the admin routes
// too, which still need the admin key.
export function originAllowed(origin, env) {
  if (!origin) return true;
  const defaults = 'https://riftborn.chanmanc10.chatgpt.site' +
    (env.ENVIRONMENT === 'production' ? '' : ',http://127.0.0.1:4173,http://localhost:4173');
  return `${defaults},${env.ALLOWED_ORIGINS || ''}`
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .includes(origin);
}

// Admin-only origins (FEEDBACK_ADMIN_ORIGINS, from site.hosts.mjs: the inbox at feedback.riftborn.us
// and its old github.io copy). An origin listed there but not allowed above (feedback.riftborn.us)
// may use the admin routes only (list, CSV, status changes: the same key check and admin rate limit
// as everyone), never submit player feedback: its POST gets 403 before the rate limiter, the body or
// the database, and its preflight offers only that route's admin method. Scores and accounts never
// read this list, so they refuse it like any unknown origin.
export function adminOnlyOrigin(origin, env) {
  return Boolean(origin) && String(env.FEEDBACK_ADMIN_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .includes(origin);
}

// Constant-time: compare SHA-256 digests byte by byte, so neither content nor length leaks.
export async function sameSecret(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected))
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Every admin request (list, CSV, status change), right or wrong key, first takes a slot in the
// per-IP limiter shared with the accounts API (ACCOUNTS_RATE_LIMITER, 30 a minute, under its own
// key), so the admin key cannot be guessed at speed. Checked before the key: counting only failures
// would never slow down a guess that is right.
export const ADMIN_LIMIT = Object.freeze({ scope: 'feedback-admin', retryAfter: 60 });
export async function limitAdmin(request, env, origin) {
  const limiter = env.ACCOUNTS_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = (await ipLimitKey(request, env, ADMIN_LIMIT.scope)) || `${ADMIN_LIMIT.scope}:${ip}`;
  const { success } = await limiter.limit({ key });
  return success ? null : json({ error: 'Too many requests. Wait a minute and try again.' }, 429, origin, { 'Retry-After': String(ADMIN_LIMIT.retryAfter) });
}

export async function authorize(request, env, origin) {
  if (!env.FEEDBACK_ADMIN_KEY) return json({ error: 'Feedback admin key not configured' }, 503, origin);
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  if (!match || !(await sameSecret(match[1].trim(), String(env.FEEDBACK_ADMIN_KEY)))) {
    return json({ error: 'Unauthorized' }, 401, origin, { 'WWW-Authenticate': 'Bearer' });
  }
  return null;
}
