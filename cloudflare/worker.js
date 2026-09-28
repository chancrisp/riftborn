// GitHub Pages uses this API-only Worker; static game files stay on GitHub Pages.
import { handleScores } from '../server/scores-api.js';

export default {
  async fetch(request, env) {
    const response = await handleScores(request, env);
    return response || new Response('Not found', { status: 404 });
  }
};
