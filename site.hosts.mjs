// Riftborn hosts: where each part of Riftborn lives, and the Worker-facing lists built from them.
// This is the only repository file the Worker (server/accounts-api.js, bundled by
// scripts/cloudflare-worker-upload.mjs) reads, so only a change here (never the LAUNCHED switch in
// site.config.mjs) redeploys the Worker (.github/workflows/cloudflare-worker.yml path filter).
// site.config.mjs re-exports everything here for the Pages build.

export const HOSTS = Object.freeze({
  // The live game (Cloudflare Pages project "riftborn"): / (game), /classic/, /privacy/.
  live: 'https://riftborn.us',
  // The password-gated test build (Cloudflare Pages project "riftborn-dev"), its own origin.
  dev: 'https://dev.riftborn.us',
  // Scores, feedback and accounts: custom domain on the Worker "riftborn-leaderboard".
  api: 'https://api.riftborn.us',
  // The Worker's own address; kept working for old clients during the transition.
  workersDev: 'https://riftborn-leaderboard.chanmanc10.workers.dev',
  // GitHub Pages (repository chancrisp/riftborn): the game until launch, handoff pages after.
  // The feedback inbox stays here for good (away from the game origin).
  legacyOrigin: 'https://chancrisp.github.io',
  legacyPath: '/riftborn/'
});

// Browser origins the Worker answers (CORS) for scores, feedback and accounts. The GitHub Pages
// origin stays: the legacy game posts scores and feedback until launch, and the feedback inbox
// reads through it afterwards. RIFTBORN_SITE_ORIGIN (GitHub variable) can add more.
export const WORKER_ALLOWED_ORIGINS = Object.freeze([HOSTS.live, HOSTS.dev, HOSTS.legacyOrigin]);
// Where a sign-in may return to (exact origin + path). Accounts never run on github.io.
export const AUTH_RETURN_ORIGINS = Object.freeze([HOSTS.live, HOSTS.dev]);
export const AUTH_RETURN_PATHS = Object.freeze(['/']);
// Every OAuth redirect_uri and every /auth/:provider/start|callback lives on this origin, so the
// __Host- sign-in cookie always binds to one host. Register these callback URLs with the providers:
//   https://api.riftborn.us/auth/google/callback
//   https://api.riftborn.us/auth/discord/callback
//   https://api.riftborn.us/auth/github/callback
export const AUTH_PUBLIC_BASE = HOSTS.api;
