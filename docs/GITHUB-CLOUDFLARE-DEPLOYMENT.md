# Riftborn on GitHub Pages with a Cloudflare leaderboard

This package prepares the game for GitHub Pages and a separate Cloudflare Worker + D1 leaderboard. The current public ChatGPT Site remains live and keeps its original identity, URL, and database. Nothing in the build uploads to or changes that Site.

## What deploys where

- **GitHub Pages** serves only the static game from `_site/`. The build omits `.openai/` and the generated Sites Worker bundle.
- **Cloudflare Worker** serves `GET /api/scores` and `POST /api/scores`; D1 stores shared scores. The browser uses the same API contract, and the board remains explicitly client-reported (`verified: false`).
- **Local preview** continues to use `http://127.0.0.1:4173/api/scores` and its separate `.sites-runtime/preview.sqlite` database.
- **Existing ChatGPT Site** remains on the current handler and D1 database. The shared handler used in later Site packages permits the current Site origin, but this transition has not deployed that update.

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

The Pages workflow runs on pushes to `main` and manually. The Worker deployment and D1 migration workflows are manual so a gameplay push cannot migrate or replace production score data unexpectedly. The Worker deployment expects the Cloudflare variables/secrets above; the D1 migration workflow applies the existing `drizzle/` SQL migrations to the named remote D1 database.

## Cloudflare setup

1. Create a Cloudflare account if needed and install Wrangler locally (`npm install --global wrangler`), then authenticate with `wrangler login`.
2. From the repository root, create the database with `wrangler d1 create riftborn-leaderboard`. Copy its UUID into `CLOUDFLARE_D1_DATABASE_ID`.
3. Set the GitHub variables and secret above. After the repository exists, the Workers origin can be read from the Worker deployment output; set `RIFTBORN_SCORE_API_BASE` to that origin.
4. Run **Actions → Apply Riftborn D1 migrations → Run workflow** once against the new empty database.
5. Run **Actions → Deploy Riftborn leaderboard Worker → Run workflow**.
6. Set `RIFTBORN_SCORE_API_BASE` to the resulting `workers.dev` origin and run the Pages workflow.
7. In Firefox, check a leaderboard read and a disposable completed run. Confirm that its row appears in a second browser/device before switching players to the new URL.

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

The public leaderboard endpoint returns only the top 25, but the Sites database table viewer provides a separate read-only, paginated export. I confirmed all current rows fit in the first page and saved a 16-row SQL snapshot at `.sites-runtime/legacy-scores.sql`. That path is ignored by Git, so player rows stay out of the public repository. After the D1 schema migrations, import it once with:

```powershell
npx wrangler d1 execute riftborn-leaderboard --remote --file=.sites-runtime/legacy-scores.sql
```

Re-read the Sites table immediately before the eventual cutover, because the original game may continue receiving scores until then. Rebuild the ignored SQL snapshot with the newer rows and re-run the `ON CONFLICT(id) DO NOTHING` import; this makes the catch-up safe without duplicating existing runs. Keep the Sites leaderboard accessible as an archive until the GitHub board has been verified.

To roll back the website, restore the previous Pages artifact or revert the Git commit. To roll back leaderboard traffic, rebuild Pages with the prior API origin or update its repository variable and redeploy. Keep the current ChatGPT Site and its D1 database available until the GitHub version has passed real-browser checks and the owner has decided where future scores should live.

## Current provisioning state

The source and workflows are prepared locally. No GitHub repository, Cloudflare Worker, D1 database, secret, deployment, or data import has been created by this package yet. Those steps require access to the user's GitHub and Cloudflare accounts.
