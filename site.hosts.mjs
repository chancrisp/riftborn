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
  // The private feedback inbox (Cloudflare Pages project "riftborn-feedback"), on its own origin so
  // the admin key it holds for a tab never shares an origin with the game or anything else.
  // https://riftborn.us/feedback redirects here.
  feedback: 'https://feedback.riftborn.us',
  // GitHub Pages (repository chancrisp/riftborn): the game until launch, handoff pages after. A copy
  // of the feedback inbox stays here (with a "moved" banner) until GitHub Pages is shut down.
  legacyOrigin: 'https://chancrisp.github.io',
  legacyPath: '/riftborn/'
});

// Browser origins the Worker answers (CORS) for scores, feedback and accounts. The GitHub Pages
// origin stays: the legacy game posts scores and feedback until launch, and the old copy of the
// feedback inbox reads through it until GitHub Pages is shut down (then drop it here and from
// FEEDBACK_ADMIN_ORIGINS). RIFTBORN_SITE_ORIGIN (GitHub variable) can add more.
export const WORKER_ALLOWED_ORIGINS = Object.freeze([HOSTS.live, HOSTS.dev, HOSTS.legacyOrigin]);
// Of those, the origins that may only READ the leaderboard (GET /api/scores): the test build shows
// the live boards but never posts to them. The Worker refuses their score writes with 403 before
// any work, and their preflight offers no write (server/scores-api.js). Accounts and feedback are
// untouched. Delivered as the SCORE_READ_ONLY_ORIGINS var (scripts/cloudflare-worker-upload.mjs,
// cloudflare/wrangler.jsonc).
export const SCORE_READ_ONLY_ORIGINS = Object.freeze([HOSTS.dev]);
// Browser origins that may use the feedback ADMIN routes (list, CSV export, status changes; each one
// still needs the admin key and takes a slot in the admin rate limit, server/feedback-api.js): the
// inbox at feedback.riftborn.us, and its old copy on GitHub Pages until that is shut down. Admin
// only: an origin here that is not in WORKER_ALLOWED_ORIGINS (feedback.riftborn.us) is refused for
// scores, accounts and player feedback, and its preflight offers only the admin methods; the Worker
// deploy refuses a RIFTBORN_SITE_ORIGIN that would add it to ALLOWED_ORIGINS. Delivered as the
// FEEDBACK_ADMIN_ORIGINS var (scripts/cloudflare-worker-upload.mjs, cloudflare/wrangler.jsonc).
export const FEEDBACK_ADMIN_ORIGINS = Object.freeze([HOSTS.feedback, HOSTS.legacyOrigin]);
// Where a sign-in may return to (exact origin + path). Accounts never run on github.io.
export const AUTH_RETURN_ORIGINS = Object.freeze([HOSTS.live, HOSTS.dev]);
export const AUTH_RETURN_PATHS = Object.freeze(['/']);
// Every OAuth redirect_uri and every /auth/:provider/start|callback lives on this origin, so the
// __Host- sign-in cookie always binds to one host. Register these callback URLs with the providers:
//   https://api.riftborn.us/auth/google/callback
//   https://api.riftborn.us/auth/discord/callback
//   https://api.riftborn.us/auth/github/callback
export const AUTH_PUBLIC_BASE = HOSTS.api;
