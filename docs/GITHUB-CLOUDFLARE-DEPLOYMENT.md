# Riftborn on GitHub Pages with a Cloudflare leaderboard

The game is moving to GitHub Pages with a separate Cloudflare Worker + D1 leaderboard. The existing public ChatGPT Site remains live with its original identity, URL, and database. These workflows do not upload to or change that Site.

## What deploys where

- **GitHub Pages** serves only the static game from `_site/`. The build omits `.openai/` and the generated Sites Worker bundle.
- **Cloudflare Worker** serves `GET /api/scores` and `POST /api/scores`; D1 stores shared scores. The browser uses the same API contract, and the board remains explicitly client-reported (`verified: false`).
- **Local preview** continues to use `http://127.0.0.1:4173/api/scores` and its separate `.sites-runtime/preview.sqlite` database.
- **Existing ChatGPT Site** remains on its current handler and D1 database throughout this transition.

## GitHub repository settings

Use a public repository named `riftborn` (or another chosen repo name), with the existing project files on its `main` branch. In **Settings → Pages**, set the source to **GitHub Actions**.

Create these repository variables:

| Variable | Value |
| --- | --- |
| `RIFTBORN_SCORE_API_BASE` | Worker origin only, for example `https://riftborn-leaderboard.<account>.workers.dev` (no `/api/scores`) |
| `RIFTBORN_SITE_ORIGIN` | Exact origin of the Pages site, for example `https://<username>.github.io` (no repository path) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_D1_DATABASE_ID` | UUID returned when the D1 database is created |

Create a repository secret named `CLOUDFLARE_API_TOKEN`. Use a Cloudflare API token scoped to the account permissions needed for Workers deployment and D1 read/write/migration operations. Do not put tokens or database credentials in game code or repository variables.

The Pages workflow runs on pushes to `main` and manually. The Worker deploys on changes to its API/configuration files or manually. D1 migrations remain manual so a gameplay push cannot change production score data unexpectedly.

Only `main` deploys to production: the Worker job and the Cloudflare Pages job skip any other branch, and both deploy scripts refuse any other ref in CI. Keep the Cloudflare and account secrets as **environment secrets of `cloudflare-production`** (Settings → Environments → cloudflare-production, with Deployment branches set to `main` only), not repository secrets, so a workflow on another branch cannot read them.

`FEEDBACK_ADMIN_KEY` (secret) unlocks the feedback inbox, which holds every player message and contact line. Make it 24 or more random characters, generated the same way as `AUTH_SIGNING_KEY` (never a word or phrase). A shorter key prints a warning on every Worker deploy; once the key is long, set the repository variable `FEEDBACK_KEY_STRICT` to `1` so a short key fails the deploy instead. Every admin request is also limited to 30 a minute per network.

## Cloudflare setup

1. Set the repository variables and `CLOUDFLARE_API_TOKEN` secret above. The token needs Cloudflare Workers Scripts Write and D1 read/write permissions for this account.
2. In **Workers & Pages → riftborn-leaderboard → Settings → Bindings**, add the production D1 binding named `DB` and select `riftborn-leaderboard`. The deployment workflow then bundles `cloudflare/worker.js` and uploads it through Cloudflare's documented multipart Script Upload API. It inherits the existing `DB` binding and configures the origin and rate limiter. In this account Cloudflare rejects a direct database ID during script upload even though the same database is listed and works in the dashboard; the inherited binding avoids resubmitting that ID.
3. Run **Actions → Deploy Riftborn leaderboard Worker → Run workflow**. Future Worker uploads inherit `DB` from the latest deployed version.
4. Run the checked-in Drizzle SQL migrations against the new database. In this account, Wrangler can list D1 but its remote query/migration endpoint returns error 7404. Until Cloudflare resolves [Workers SDK issue #15144](https://github.com/cloudflare/workers-sdk/issues/15144), apply each SQL statement in D1 Studio and record each filename in `d1_migrations`. The transition database has migrations `0000`–`0003` recorded.
5. Run **Actions → Build and deploy Riftborn to GitHub Pages → Run workflow**. The workflow uses `https://riftborn-leaderboard.chanmanc10.workers.dev` by default; set repository variable `RIFTBORN_SCORE_API_BASE` only if the API hostname changes.
6. In Firefox, check a leaderboard read and a disposable completed run. Confirm that its row appears in a second browser/device before switching players to the new URL.

The Worker allows the exact `RIFTBORN_SITE_ORIGIN` origin. It accepts JSON score writes, caps bodies at 2 KiB, validates each run, deduplicates by run UUID, and uses a 30-write-per-minute Cloudflare rate-limit binding. The limit is per Cloudflare location and IP, so shared networks can group players; tune it if legitimate users ever hit it. CORS is not authentication, and this remains a casual leaderboard rather than an anti-cheat system.

## Build and preview

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:4173/` for the ordinary local game and local SQLite board. Build the GitHub Pages artifact after setting a real Worker origin:

```powershell
$env:RIFTBORN_SCORE_API_BASE = 'https://riftborn-leaderboard.<account>.workers.dev'
npm run build:pages
```

The resulting `_site/` folder is generated and ignored by Git. Review it locally with a static server that supports ES modules, or use the GitHub Pages preview after deployment. `npm run build` still makes the existing Sites Worker package in `dist/server/index.js`.

## Historical scores and safe rollback

The old ChatGPT Site's public leaderboard endpoint returns only the top 25, but its database table viewer provides a separate read-only, paginated export. The initial 16-row snapshot is saved locally at `.sites-runtime/legacy-scores.sql`; that ignored path keeps player rows out of the public repository. Wrangler remote SQL execution currently fails in this Cloudflare account, so run the SQL from that snapshot in D1 Studio. The current imported snapshot contains 16 runs, with newest `played_at` timestamp `1790595906407`. The import uses `ON CONFLICT(id) DO NOTHING`, so it is safe to rerun after refreshing the snapshot.

Re-read the Sites table before any future final cutover, because the original game may continue receiving scores. Rebuild the ignored SQL snapshot with newer rows and rerun it in D1 Studio; this makes the catch-up safe without duplicating existing runs. Keep the Sites leaderboard accessible as an archive. The current ChatGPT Site and its database remain live during this transition.

To roll back the website, restore the previous Pages artifact or revert the Git commit. To roll back leaderboard traffic, rebuild Pages with the prior API origin or update its repository variable and redeploy. Keep the current ChatGPT Site and its D1 database available until the GitHub version has passed real-browser checks and the owner has decided where future scores should live.

## After every deploy: the post-deploy check, and rolling back

**Check.** `.github/workflows/post-deploy-check.yml` runs whenever the Build and deploy workflow finishes on `main` (and on demand from Actions → Check riftborn.us after deploy → Run workflow). `scripts/post-deploy-check.mjs` opens https://riftborn.us/ in headless Chrome with sound muted and the welcome popup and patch notes pre-answered, and checks: `version.json` is the build committed in `live/`; the page boots with zero console errors; the menu shows the title and START RUN (read, never clicked) and SETTINGS opens and closes; every file the committed and the served `index.html` link, `/classic/` and `/privacy/` answer 200. The Open Graph/Twitter tags and the card image are checked only when the committed `live/index.html` of the deployed commit has them, so a rollback to a build from before the social card (2.2.1, 2.2.0) passes; the served page must also still link every file the committed one does (an old cached page fails). On https://dev.riftborn.us/ it checks only that the password gate shows and `version.json` is the build committed in `dev/`. Every write request from the page is blocked, so it can never post a score. Every HTTP GET is tried up to three times (2 s, then 4 s apart) on a timeout, a network error, 408, 429 or 5xx, so one slow edge does not alert. If something fails while `main` has moved on (a newer Build and deploy run is still going, or riftborn.us already serves the newer `live/version.json` on `main`), the run passes as **superseded** with a notice and no alert: the newer deploy's own check covers it (the job reads the deploy runs and `main` through the GitHub API with its read-only token, hence `actions: read`). Results appear as annotations and a table in the job summary; a failure fails the job, keeps a screenshot as an artifact, and posts one line to the feedback Discord channel through `DISCORD_WEBHOOK_URL` (the alert job uses the `cloudflare-production` environment only to read that secret). Run it locally with `npm ci --prefix tools/post-deploy-check --ignore-scripts` once, then `node scripts/post-deploy-check.mjs` (it drives an installed Chrome or Edge); `--live http://localhost:8791 --dev http://localhost:8792` checks local builds served by `scripts/serve-cf.mjs`, `--base <folder>` compares with another checkout's `live/` and `dev/` (for example an older release), and `--dry-run` is offline: it prints what the committed `live/` and `dev/` expect and checks that every file the committed page links is in `live/`. Errors that come from outside the build are listed in `TOLERATED` in the script and only warn: today that is Cloudflare Web Analytics, which injects a beacon script into every page that the site CSP blocks (the CSP stays as it is).

**Roll back.** From the source checkout (`C:\Riftborn`), `node .tools/rollback-live.mjs --dry-run` names the build it would restore (the build that was live just before the current one first went live) and runs every check; without `--dry-run` it rewrites `site/live` from the site repo history, byte for byte, and prints the `git -C site add/commit/push` lines to publish it. `--to <site commit>` or `--to <version>` picks another build, but only a real live release: a commit on `origin/main` that changed `live/` (`git -C site log --first-parent --oneline origin/main -- live/` lists them; fetch first). It refuses a dirty `site/live`, unknown options, and any build that `deploy-live.mjs` would refuse today (password gate, HOST CONFIG rules, missing hand-over importer, source map). The restored files are staged beside `site/live`, checked, and swapped in with two renames; if a rename fails (a local server or editor holding a file), `site/live` is left exactly as it was and the message says so. The push redeploys riftborn.us and the post-deploy check then confirms the restored version is served.

## Preview links (versions side by side)

Every build can have its own password-gated link next to dev.riftborn.us, named after its version (`v2-4-0`), with an optional tag for several previews of one version (`v2-4-0-logo`), so builds can be played side by side without replacing the release candidate on dev.

- **Stage.** In the source checkout, on the branch: `node .tools/build-dist.mjs --no-map && node .tools/deploy-preview.mjs [tag]`. The name always starts with the version of the build, from `dist-web/version.json`: `v<major>-<minor>-<patch>`, plus the tag when given, for side-by-side previews of one version. For a 2.4.0 build, `node .tools/deploy-preview.mjs` stages `previews/v2-4-0/` (`https://v2-4-0.riftborn-dev.pages.dev/`) and `node .tools/deploy-preview.mjs logo` stages `previews/v2-4-0-logo/` (`https://v2-4-0-logo.riftborn-dev.pages.dev/`). The tag is lowercase letters and digits starting with a letter (no `-`), and the whole name fits Cloudflare's 28-character branch alias (so never `main` and never 8 hex digits). It writes the gated build (same gate and password as dev; the tab title and the password screen show the full name), `noindex`, and a `preview.json`. It refuses unknown options and impossible tags (nothing is staged), and a `dist-web/` that looks stale (another version than `riftborn/src/data/version.js`, or built before the newest commit touching `riftborn/`) unless `--force`; staging an untagged version that another branch already staged replaces it, with a warning. `--list` shows the staged previews and their links, `--remove <full name>` (for example `--remove v2-4-0-logo`) takes one down.
- **Publish.** Commit and push this repo's `main`. `.github/workflows/previews.yml` ("Deploy Riftborn preview links") runs on a push that changes `previews/`, the preview scripts or `site.config.mjs`/`site.hosts.mjs` (or by hand, with "redeploy" to force every preview out again). `scripts/pages-previews.mjs` checks each preview (a safe name that starts with `v<version>` of the build in the folder, matching both its `version.json` and its `preview.json`, so a link never shows another version than its name; gate; noindex; HOST CONFIG giving the preview's address no scores, feedback or accounts) and stages it with the dev build's headers into `_cf/previews/`; `scripts/cloudflare-pages-deploy.mjs --previews` deploys each one as a branch deployment of the `riftborn-dev` project, skips a preview already served as staged, and deletes the deployments of previews removed from `previews/` (only deployments it made; production deployments never); `scripts/cloudflare-pages-verify.mjs --previews` checks each link serves its build. The run's summary lists the links: `https://<name>.riftborn-dev.pages.dev/`.
- **Isolation.** `pages.yml` ignores pushes that only change `previews/`, and `scripts/build-pages.mjs` never reads it, so riftborn.us, dev.riftborn.us and github.io are not redeployed. The workflow uses the same `cloudflare-production` environment and `CLOUDFLARE_API_TOKEN` (Cloudflare Pages: Edit) as the production deploy and runs only on `main`. The name and version rules are the same in both repos: `tests/preview-names.json` is checked against `scripts/pages-previews.mjs` here and against `.tools/deploy-preview.mjs` in the source repo, whose test also compares the two copies side by side on a generated set of names and versions.

## Current provisioning state

GitHub repository `chancrisp/riftborn`, Cloudflare D1 database `riftborn-leaderboard`, and the repository API-token secret are configured. D1 migrations `0000`–`0003` are installed. The production Worker is deployed at `https://riftborn-leaderboard.chanmanc10.workers.dev`, with its `DB` binding attached to that database. Its `/api/scores` endpoint has been checked from the GitHub Pages origin and returns all 16 imported historical runs in descending score order; the newest run matches the legacy snapshot. The Pages site is live at `https://chancrisp.github.io/riftborn/`, and its build workflow has succeeded. The API reports `verified: false`: score writes are client-reported and the leaderboard is not an anti-cheat system. A real score submission from a second browser/device has not yet been confirmed. The ChatGPT Site and its database remain live and unchanged.
