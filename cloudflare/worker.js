// GitHub Pages uses this API-only Worker; static game files stay on GitHub Pages.
import { handleScores } from '../server/scores-api.js';
import { handleFeedback } from '../server/feedback-api.js';
import { handleAccounts, scoreAccounts } from '../server/accounts-api.js';
import { handleStats } from '../server/stats-api.js';
import { handleCoop } from '../server/coop-api.js';

// A Durable Object class must be a named export of the Worker's entry module for Cloudflare to find it (the binding COOP_ROOM names it).
// The default export stays the only handler.
export { CoopRoom } from '../server/coop-room.js';

// Every https answer pins the host to https in the browser (api.riftborn.us and workers.dev).
// (The default export is the only handler; the one named export is the CoopRoom Durable Object class, below the imports.)
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
  // A WebSocket upgrade (the co-op rooms) is handed back as it is: a new Response cannot be built from a 101 and would drop the socket,
  // and HSTS means nothing on an upgrade.
  if (response.status === 101 || response.webSocket) return response;
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
      (await handleFeedback(request, env, ctx)) || (await handleStats(request, env, ctx)) ||
      (await handleCoop(request, env, ctx)) || new Response('Not found', { status: 404 });
    return url.protocol === 'https:' ? withHsts(response) : response;
  }
};
