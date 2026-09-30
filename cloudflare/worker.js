// GitHub Pages uses this API-only Worker; static game files stay on GitHub Pages.
import { handleScores } from '../server/scores-api.js';
import { handleFeedback } from '../server/feedback-api.js';

export default {
  async fetch(request, env, ctx) {
    const response = (await handleScores(request, env)) || (await handleFeedback(request, env, ctx));
    return response || new Response('Not found', { status: 404 });
  }
};
