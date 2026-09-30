// GitHub Pages uses this API-only Worker; static game files stay on GitHub Pages.
import { handleScores } from '../server/scores-api.js';
import { handleFeedback } from '../server/feedback-api.js';
import { handleAccounts, scoreAccounts } from '../server/accounts-api.js';

export default {
  async fetch(request, env, ctx) {
    // Accounts first (v2.2); scores get the account hooks (session, name protection, username join).
    const response = (await handleAccounts(request, env, ctx)) || (await handleScores(request, env, scoreAccounts)) ||
      (await handleFeedback(request, env, ctx));
    return response || new Response('Not found', { status: 404 });
  }
};
