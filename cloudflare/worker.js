// GitHub Pages uses this API-only Worker; static game files stay on GitHub Pages.
import { handleScores } from '../server/scores-api.js';
import { handleFeedback } from '../server/feedback-api.js';
import { handleAccounts, scoreAccounts } from '../server/accounts-api.js';
import { handleStats } from '../server/stats-api.js';

// Every https answer pins the host to https in the browser (api.riftborn.us and workers.dev).
// (Only the default export: the Workers runtime treats named exports of an entry as entrypoints.)
const HSTS = 'max-age=31536000';

// Production answers only over https. A plaintext request never reaches a handler, so a Bearer
// token or the feedback admin key sent over http is refused, never processed. Sign-in navigations
// (GET/HEAD /auth/...) are sent to the same URL over https; anything else gets 403, so a client
// that speaks http finds out instead of being silently redirected after its token already leaked.
function plaintextRefusal(request, env, url) {
  if (env.ENVIRONMENT !== 'production' || url.protocol !== 'http:') return null;
  if (url.pathname.startsWith('/auth/') && (request.method === 'GET' || request.method === 'HEAD')) {
    return new Response(null, { status: 301, headers: { Location: 'https://' + url.host + url.pathname + url.search, 'Cache-Control': 'no-store' } });
  }
  return new Response(JSON.stringify({ error: 'https_required' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

function withHsts(response) {
  const headers = new Headers(response.headers);
  headers.set('Strict-Transport-Security', HSTS);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const refused = plaintextRefusal(request, env, url);
    if (refused) return refused;
    // Accounts first (v2.2); scores get the account hooks (session, name protection, username join).
    const response = (await handleAccounts(request, env, ctx)) || (await handleScores(request, env, scoreAccounts)) ||
      (await handleFeedback(request, env, ctx)) || (await handleStats(request, env, ctx)) || new Response('Not found', { status: 404 });
    return url.protocol === 'https:' ? withHsts(response) : response;
  }
};
