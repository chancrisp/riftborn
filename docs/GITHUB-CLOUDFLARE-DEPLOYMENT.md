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

The public leaderboard endpoint returns only the top 25, but the Sites database table viewer provides a separate read-only, paginated export. The initial 16-row snapshot is saved locally at `.sites-runtime/legacy-scores.sql`; that ignored path keeps player rows out of the public repository. Wrangler remote SQL execution currently fails in this Cloudflare account, so run the SQL from that snapshot in D1 Studio. The current imported snapshot contains 16 runs, with newest `played_at` timestamp `1790595906407`. The import uses `ON CONFLICT(id) DO NOTHING`, so it is safe to rerun after refreshing the snapshot.

Re-read the Sites table before any future final cutover, because the original game may continue receiving scores. Rebuild the ignored SQL snapshot with newer rows and rerun it in D1 Studio; this makes the catch-up safe without duplicating existing runs. Keep the Sites leaderboard accessible as an archive. The current ChatGPT Site and its database remain live during this transition.

To roll back the website, restore the previous Pages artifact or revert the Git commit. To roll back leaderboard traffic, rebuild Pages with the prior API origin or update its repository variable and redeploy. Keep the current ChatGPT Site and its D1 database available until the GitHub version has passed real-browser checks and the owner has decided where future scores should live.

## Current provisioning state

GitHub repository `chancrisp/riftborn`, Cloudflare D1 database `riftborn-leaderboard`, and the repository API-token secret are configured. D1 migrations `0000`–`0003` are installed. The production Worker is deployed at `https://riftborn-leaderboard.chanmanc10.workers.dev`, with its `DB` binding attached to that database. Its `/api/scores` endpoint has been checked from the GitHub Pages origin and returns all 16 imported historical runs in descending score order; the newest run matches the legacy snapshot. The Pages site is live at `https://chancrisp.github.io/riftborn/`, and its build workflow has succeeded. The API reports `verified: false`: score writes are client-reported and the leaderboard is not an anti-cheat system. A real score submission from a second browser/device has not yet been confirmed. The ChatGPT Site and its database remain live and unchanged.
