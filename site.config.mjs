// Riftborn hosting: the single source of truth for where each part of Riftborn lives and for the
// two launch switches. Read by scripts/build-pages.mjs (GitHub Pages + Cloudflare Pages outputs),
// scripts/cloudflare-pages-deploy.mjs and .github/workflows/pages.yml (through
// scripts/site-config.mjs). The hosts themselves live in site.hosts.mjs (re-exported here), the
// only file the Worker reads (scripts/cloudflare-worker-upload.mjs CORS origins,
// server/accounts-api.js sign-in return URLs and the public auth host): flipping LAUNCHED here never
// redeploys the Worker.
//
// Switch 1, CF_PAGES_ENABLED (GitHub repository variable, "1"): turns the Cloudflare Pages deploy
// job on at all. Before launch it deploys dev.riftborn.us (the password-gated test build) and a
// pre-launch riftborn.us (only /privacy/, plus a root page that sends visitors to the GitHub
// Pages game, so nobody starts fresh on the new domain early).
//
// Switch 2, LAUNCHED (this constant, committed): flips riftborn.us to the full game (and /classic/)
// and turns https://chancrisp.github.io/riftborn/ into handoff pages that move each player's saved
// data to riftborn.us. Launch = set LAUNCHED to true and push to main with CF_PAGES_ENABLED=1. The
// workflow deploys Cloudflare first and publishes the GitHub Pages handoff only if that succeeded.
//
// Never use GitHub's custom-domain setting for chancrisp/riftborn: its 301 would move players to
// riftborn.us without their saved data (localStorage belongs to the old origin).

import { HOSTS } from './site.hosts.mjs';
export { HOSTS, WORKER_ALLOWED_ORIGINS, AUTH_RETURN_ORIGINS, AUTH_RETURN_PATHS, AUTH_PUBLIC_BASE } from './site.hosts.mjs';

export const LAUNCHED = false;

export const PAGES_PROJECTS = Object.freeze({ live: 'riftborn', dev: 'riftborn-dev' });
export const PRODUCTION_BRANCH = 'main';

// The migration contract (sending side: scripts/pages-templates.mjs handoff page; receiving side:
// the game's early import script). Both sides must agree on every value here.
export const MIGRATION = Object.freeze({
  param: 'rb_migrate', // https://riftborn.us/#rb_migrate=<payload>
  version: 1,
  from: 'chancrisp.github.io',
  prefix: 'riftborn-reborn-',
  // Never moved: sign-in state and device-only flags (accounts start fresh on the new origin).
  exclude: Object.freeze([
    'riftborn-reborn-session-v1',
    'riftborn-reborn-login-verifier-v1',
    'riftborn-reborn-account-sync-v1',
    'riftborn-reborn-account-reminded',
    'riftborn-reborn-dev-accounts',
    // Developer mode (the game's src/meta/dev-mode.js): its switch, loadout and one-shot carry stay
    // on the device.
    'riftborn-reborn-dev-mode-v1',
    'riftborn-reborn-dev-loadout-v1',
    'riftborn-reborn-dev-carry-v1',
    // Device flags that are not progress: the welcome popup's answer, the patch notes seen, and the
    // Journal's pre-upgrade backup. (The same list as the game's src/meta/migration.js
    // MIGRATION_EXCLUDED; tests/migration-handoff.mjs compares the two.)
    'riftborn-reborn-welcome-v1',
    'riftborn-reborn-whats-new-seen-v1',
    'riftborn-reborn-whats-new-visit-v1',
    'riftborn-reborn-profile-v1-bak'
  ]),
  // The classic edition's saves, moved as well.
  extra: Object.freeze(['riftborn-profile-v1', 'neon-crypt-preferences-v1']),
  // Never moved, whatever the rules above say.
  never: Object.freeze(['riftborn-dev-gate']),
  maxValueBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxKeys: 64,
  // Sent first, so the caps drop the least important keys.
  priority: Object.freeze([
    'riftborn-reborn-profile-v1',
    'riftborn-reborn-preferences-v1',
    'riftborn-profile-v1',
    'neon-crypt-preferences-v1',
    'riftborn-reborn-scores-v1',
    'riftborn-reborn-boards-v1',
    'riftborn-reborn-score-outbox-v1',
    'riftborn-reborn-feedback-outbox-v1',
    'riftborn-reborn-last-name-v1'
  ]),
  // Sender only: a hand-off URL longer than this is not sent as is (older Firefox caps URLs at
  // 1 MiB); the least important keys are left behind instead (they stay safe on github.io).
  maxFragmentChars: 1000000,
  // Set on github.io by the handoff page (never starts with the prefix above, so it is never sent).
  marker: 'riftborn-moved-v1',
  toast: 'Your progress moved with you to riftborn.us',
  // The receiving side: the rebuilt game's src/meta/migration.js (MIGRATION_LIMITS, KEY_RE,
  // MIGRATION_PENDING_KEY) and core/storage.js (KEYS), and the classic page's importer
  // (scripts/pages-templates.mjs classicImportScript), which uses these same values.
  receive: Object.freeze({
    localHosts: Object.freeze(['localhost', '127.0.0.1', '[::1]']), // local test servers
    keyPattern: '^[A-Za-z0-9._-]{1,96}$',
    maxValueChars: 256 * 1024, // localStorage counts UTF-16 code units
    maxTotalChars: 1024 * 1024,
    maxPayloadChars: 3000000, // the fragment itself
    maxJsonBytes: 4 * 1024 * 1024, // the JSON after inflating (a deflate bomb stops here)
    pendingKey: 'riftborn-migration-pending', // sessionStorage: a reload before the import lands can't lose it
    doneKey: 'riftborn-migration-done-v1', // this device took a hand-over (the "moved" toast showed)
    profileKey: 'riftborn-reborn-profile-v1', // the rebuilt game's Journal (moved first)
    toastMs: 6000,
    waitMs: 10000 // the classic game starts once the import is done, or after this at the latest
  })
});

const TEST_OVERRIDES = ['RIFTBORN_FORCE_LAUNCHED', 'RIFTBORN_TEST_LIVE_ORIGIN', 'RIFTBORN_TEST_DEV_ORIGIN', 'RIFTBORN_TEST_LEGACY_URL'];
const origin = (value, name) => {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.origin !== value) throw new Error(`${name} must be an exact http(s) origin without a path.`);
  return value;
};

/**
 * The resolved configuration for a build. Local test overrides (never allowed in CI):
 *   RIFTBORN_FORCE_LAUNCHED=1|0    build as if LAUNCHED were true/false
 *   RIFTBORN_TEST_LIVE_ORIGIN      e.g. http://localhost:8791 in place of https://riftborn.us
 *   RIFTBORN_TEST_DEV_ORIGIN       e.g. http://localhost:8792 in place of https://dev.riftborn.us
 *   RIFTBORN_TEST_LEGACY_URL       e.g. http://127.0.0.1:8790/riftborn/ in place of the github.io game
 */
export function resolveSiteConfig(env = {}) {
  const set = TEST_OVERRIDES.filter(name => env[name] !== undefined && env[name] !== '');
  if (set.length && (env.CI || env.GITHUB_ACTIONS)) throw new Error(`Test-only overrides are not allowed in CI: ${set.join(', ')}`);
  const forced = env.RIFTBORN_FORCE_LAUNCHED;
  const launched = forced === '1' ? true : forced === '0' ? false : LAUNCHED;
  const live = env.RIFTBORN_TEST_LIVE_ORIGIN ? origin(env.RIFTBORN_TEST_LIVE_ORIGIN, 'RIFTBORN_TEST_LIVE_ORIGIN') : HOSTS.live;
  const dev = env.RIFTBORN_TEST_DEV_ORIGIN ? origin(env.RIFTBORN_TEST_DEV_ORIGIN, 'RIFTBORN_TEST_DEV_ORIGIN') : HOSTS.dev;
  const legacyUrl = env.RIFTBORN_TEST_LEGACY_URL || HOSTS.legacyOrigin + HOSTS.legacyPath;
  if (!/^https?:\/\/[^/]+\/(.*\/)?$/.test(legacyUrl)) throw new Error('RIFTBORN_TEST_LEGACY_URL must be an http(s) URL ending in /.');
  return Object.freeze({
    launched,
    // True only for the committed switch, not a local override: the launch safety checks are hard
    // errors then (a forced local test build only warns).
    launchedForReal: launched && forced !== '1',
    testOverrides: set,
    live,
    dev,
    api: HOSTS.api,
    workersDev: HOSTS.workersDev,
    legacyUrl,
    projects: PAGES_PROJECTS
  });
}

/**
 * Why a CI run must not build a launched site ([] when it may, and always [] outside CI or before
 * launch): the Cloudflare deploy must be on (CF_PAGES_ENABLED=1), or github.io would hand players
 * over to a site nobody deployed; and the run must be on main (PRODUCTION_BRANCH), or a manual run
 * of another branch could put a second live site in front of players.
 */
export function ciLaunchRefusals({ launched, env = {} }) {
  if (!launched || !(env.CI || env.GITHUB_ACTIONS)) return [];
  const refusals = [];
  if (String(env.CF_PAGES_ENABLED || '').trim() !== '1') {
    refusals.push('LAUNCHED is true but the CF_PAGES_ENABLED repository variable is not 1: refusing to build the github.io handoff.');
  }
  if (env.GITHUB_REF !== `refs/heads/${PRODUCTION_BRANCH}`) {
    refusals.push(`LAUNCHED is true but this run is on ${env.GITHUB_REF || 'an unknown ref'}, not refs/heads/${PRODUCTION_BRANCH}: refusing to build the launch.`);
  }
  return refusals;
}
