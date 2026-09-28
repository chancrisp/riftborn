# Riftborn GitHub Pages + Cloudflare D1 transition

## Goal

Move the static game to GitHub Pages and the shared leaderboard API to a Cloudflare Worker backed by D1, while keeping the current public ChatGPT Site available until the new site has been built and checked.

## Current implementation state

- [x] Add a configurable browser API origin without changing the existing same-origin default.
- [x] Extract score API behavior for reuse by the existing Sites Worker and a standalone API Worker.
- [x] Add exact-origin CORS, OPTIONS preflight, request validation, idempotent inserts, and optional per-IP write limiting.
- [x] Add a curated GitHub Pages build that excludes Sites configuration and bundled Worker source.
- [x] Add separate GitHub Actions for Pages deploy, manual Worker deploy, and manual D1 migrations.
- [x] Document account setup, required secrets, deployment order, rollback, and historical leaderboard import.
- [x] Export the current 16 Sites scores to an ignored local SQL snapshot for idempotent D1 import.
- [ ] Build and inspect both package outputs.
- [ ] Create/configure GitHub and Cloudflare resources, deploy Worker/D1, then deploy Pages.
- [ ] Open the project in VS Code and the resulting repository in Firefox.

## Deployment sequence

1. Build `_site/` locally with the API base set to a real Worker origin.
2. Create a Cloudflare D1 database named `riftborn-leaderboard` and apply the existing additive migrations.
3. Set GitHub repository variables and the Cloudflare API token secret described in `docs/GITHUB-CLOUDFLARE-DEPLOYMENT.md`.
4. Deploy the Worker manually and exercise public ranking plus a disposable score submission.
5. Deploy GitHub Pages and verify gameplay, assets, score submission, leaderboard reads, and browser refresh under the repository subpath.
6. Refresh and import the Sites rows immediately before cutover, then keep the ChatGPT Site and its existing D1 database online as a rollback/archive until the replacement is confirmed.

## Risks and limits

- The export currently contains 16 rows; new scores may arrive before cutover, so refresh it immediately before import.
- GitHub account/repository and Cloudflare account credentials are not present in this workspace; external resources cannot be provisioned from local files alone.
- The local tree contains schema and migrations but not the production score rows. The existing public board exposes only a top-25 slice.
- The leaderboard remains client-reported. CORS, validation, and rate limiting reduce casual abuse but do not prove scores are legitimate.
- Free Cloudflare quotas may reject requests after limits are reached; review current Cloudflare pricing/limits when provisioning.
