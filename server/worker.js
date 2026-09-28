// Current ChatGPT Sites worker: serves the game and its same-origin score API.
import { handleScores } from './scores-api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const scoreResponse = await handleScores(request, env);
    if (scoreResponse) return scoreResponse;
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const asset = ASSETS[path];
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : asset.binary
      ? Uint8Array.from(atob(asset.body), c => c.charCodeAt(0))
      : asset.body, {
      headers: {
        'Content-Type': asset.type,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }
};
