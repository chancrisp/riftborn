# Riftborn leaderboard backend proposal

> **Research snapshot — 28 September 2026.** This note was written before the user authorized a Cloudflare D1 transition. That approval has since been given, and a local deployment package is now prepared; see [the current deployment guide](GITHUB-CLOUDFLARE-DEPLOYMENT.md) and [the implementation plan](superpowers/plans/2026-09-28-github-pages-cloudflare-d1.md). No account, public repository, production Worker, D1 database, data import, or cutover has yet been provisioned. Pricing and quotas are point-in-time facts and should be rechecked immediately before provisioning.

## Recommendation

Experiment with a **standalone Cloudflare Worker plus D1**, while serving the game from GitHub Pages. This is the lowest-risk path because Riftborn's production handler already uses the Cloudflare Worker `fetch(request, env)` interface and a `DB` binding, its migrations are SQLite, and its tests mock D1's `prepare().bind().all()/run()` interface. The project is already substantially shaped like the proposed backend.

The main work is to separate the API from the current Worker-bundled static assets, change the browser from a relative `/api/scores` URL to a configurable Worker URL, and explicitly support cross-origin requests from the GitHub Pages origin. The existing `Sec-Fetch-Site: cross-site` rejection would otherwise block every legitimate score submission from GitHub Pages.

Cloudflare D1 is a managed serverless database with SQLite semantics and Worker bindings. On the Free plan, current allowances are 5 million rows read/day, 100,000 rows written/day, 5 GB total D1 storage, a 500 MB per-database ceiling, 10 databases, and seven days of Time Travel. Workers Free allows 100,000 requests/day with 10 ms CPU per invocation. Free D1 queries now fail until midnight UTC when a daily read or write limit is reached; the paid Workers plan starts at $5/month and replaces those daily D1 caps with monthly included usage and overage pricing. D1 does not charge egress. [D1 overview](https://developers.cloudflare.com/d1/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [September 2026 D1 enforcement notice](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)

Those limits are comfortably above a small game's expected traffic, but they are hard failure thresholds on the Free plan. The existing indexed top-25 query is a good fit because D1 charges by rows scanned and documents that indexes reduce row reads.

## Proposed Cloudflare experiment

### Architecture

```text
VS Code commit -> push to GitHub main
                         |
                         +-> test + build -> GitHub Pages -> static Riftborn game
                         |
                         +-> Worker deploy (backend paths only) -> score API -> D1
```

The public components would be:

- `https://<user>.github.io/<repo>/` for the static game.
- `https://riftborn-api.<account>.workers.dev/api/scores` for the first experiment, with an optional `api.<custom-domain>` later. Cloudflare describes `workers.dev` as suitable for personal/hobby projects and recommends a route or custom domain for business-critical production use. [workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- One D1 database, with a separate staging database for integration tests and migration rehearsals.

### Code changes I would propose after approval

1. **Separate static hosting from the API.** Keep `npm run build` producing `dist/` for GitHub Pages. Make the deployed Worker API-only instead of embedding every asset in the Worker bundle.
2. **Add a configurable API origin.** Replace the two relative `/api/scores` calls with a small shared API URL helper. Production would point at the Worker; local development would continue using the same-origin local server. No Cloudflare secret belongs in browser code.
3. **Implement narrow CORS.** Handle `OPTIONS`; allow `GET` and `POST`; return `Access-Control-Allow-Origin` only for the exact GitHub Pages origin (plus an explicitly configured custom domain and local development origins); add `Vary: Origin`; and reject non-allowlisted browser origins. Cloudflare's own examples require API code to attach CORS headers to responses and preflight responses. [Cloudflare CORS guidance](https://developers.cloudflare.com/workers/static-assets/headers/), [Worker CORS example](https://developers.cloudflare.com/workers/examples/cors-header-proxy/)
4. **Preserve the current API contract.** Keep `GET /api/scores?mode=...&version=...`, `POST /api/scores`, top-25 ordering, idempotent UUID inserts, payload limits, field validation, `capabilities`, and the explicit `verified: false` response.
5. **Add abuse controls in layers.** Keep the 2 KiB body cap and strict validation. Add a Worker Rate Limiting binding to the POST path and return `429` when exceeded. Since this is anonymous play, any per-IP limit risks grouping legitimate players behind shared networks; Cloudflare explicitly warns about this tradeoff, and its Worker rate counters are local to a Cloudflare location. Start with a generous ceiling and tune from observed traffic. [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
6. **Reserve Turnstile for demonstrated abuse.** If automated spam appears, require a Turnstile token when saving a score and verify it in the Worker. Turnstile is free for up to 20 widgets with unlimited challenges; tokens expire after five minutes and are single-use. This reduces automated abuse but adds browser work and may add friction, so it should not be the first experiment. [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/), [Turnstile setup](https://developers.cloudflare.com/turnstile/get-started/)
7. **Keep the board honest about trust.** CORS is a browser rule, not authentication, and an attacker can call the Worker directly or falsify game results. Rate limiting and Turnstile reduce spam; they do not make client-reported scores authoritative. Server-authoritative runs would be a different game architecture.

### Verification before any cutover

- Extend the existing server tests with allowed/disallowed origin cases, `OPTIONS` preflight, missing/malformed origin behavior, and `429` handling.
- Run the current complete test suite.
- Run the Worker and D1 locally with Wrangler; Cloudflare states that local D1 uses the same D1 version as production. [D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/)
- Deploy to a staging Worker and staging D1 database first. Exercise every mode/version query and an idempotent duplicate submission.
- Build GitHub Pages against the staging API and inspect it in a browser before switching to production.
- Keep the ChatGPT Site online during the experiment so rollback is just restoring the previous API URL or reverting the Git commit.

### Data migration and backups

The local repository contains the complete schema, but it does not contain production rows by default. The public API returns only a filtered top 25, but a separate read-only Sites database table viewer was available. During implementation, it returned the complete current 16-row table in one page; an ignored SQL snapshot is saved at `.sites-runtime/legacy-scores.sql` for D1 import. Refresh it immediately before cutover to include any intervening runs.

If a complete SQLite/SQL export is available, D1 is the easiest target: `wrangler d1 execute --file` imports SQL, and `wrangler d1 export` creates a SQL export for backups. Raw SQLite files must first be converted to SQL; a running D1 export blocks other database requests, so exports should be scheduled during quiet periods. [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)

If a full export becomes unavailable during cutover, leave the old Site available as an archive and do not claim that the GitHub board contains the complete history. Scraping the visible top 25 would produce an incomplete and misleading history.

## GitHub and VS Code workflow

VS Code would remain the place where edits and local commits happen. A commit records history locally; **Push/Sync** uploads those commits to GitHub. A push to `main` would then trigger GitHub Actions:

1. install locked dependencies;
2. run tests and build `dist/`;
3. upload and deploy the static artifact to GitHub Pages;
4. deploy the Worker only when backend/config files change and only after tests pass.

GitHub's supported Pages flow uses `configure-pages`, `upload-pages-artifact`, and `deploy-pages`, with the `github-pages` deployment environment. [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

Cloudflare supports either direct GitHub integration or an official Wrangler GitHub Action. For the explicit, reviewable workflow proposed here, the action would run `wrangler deploy` using narrowly scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets; Cloudflare says not to store the token in the repository. [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Cloudflare Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)

Database migrations should be a separate manually triggered production job or a protected deployment step, not an unconditional side effect of every site push. GitHub environments can restrict deployment branches and withhold environment secrets until protection rules pass. [GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)

## Alternatives

| Option | Current free/entry position | Fit for Riftborn | CORS and abuse controls | Migration and workflow | Assessment |
|---|---|---|---|---|---|
| **Cloudflare Worker + D1** | Worker: 100,000 requests/day. D1: 5M rows read/day, 100k rows written/day, 500 MB/database, 5 GB/account. Paid Worker minimum $5/month. | Excellent: current code already uses Worker + D1/SQLite semantics. | Explicit origin allowlist and preflight; Worker rate-limit binding; optional free Turnstile. CORS does not prevent direct API calls. | Existing SQLite migrations; native SQL import/export; Wrangler local development; official GitHub Action. | **Recommended experiment.** Smallest change, easiest rollback, strongest continuity with current tests. |
| **Supabase Postgres + Edge Function** | Free: 500 MB database/project, 5 GB egress, 500k Edge Function calls/month, 50k MAU. Pro is $25/month and includes one Micro compute credit. Free projects with low activity may pause after seven days; exceeding 500 MB can make the database read-only. | Good relational fit, but SQLite SQL and Worker code must be ported to Postgres and a Deno/TypeScript Edge Function (or a carefully secured Data API/RPC). | Browser invocation needs explicit CORS/preflight. Supabase documents Postgres pre-request checks for per-IP write rate limiting and requires RLS/grants for exposed Data API objects. | Import via CSV/`COPY`/API after SQLite-to-Postgres conversion; export with `supabase db dump`/`pg_dump`. Official CLI and GitHub Action support migrations/functions. | Credible second choice if a broader Postgres/Auth platform is desired. More moving parts and a higher always-on paid floor. |
| **Firebase Firestore + Cloud Functions** | Firestore free quota: 1 GiB, 50k reads/day, 20k writes/day, 20k deletes/day, 10 GiB outbound/month. Cloud Functions requires the Blaze billing plan/payment account, though it includes 2M invocations, 400k GB-seconds, 200k CPU/GHz-seconds, and 5 GB egress monthly at no charge before usage pricing. | Weakest data-model fit: current SQL ranking/filter indexes become Firestore documents and composite indexes. A Function wrapper is needed to preserve the current HTTP contract and validation. | HTTP Functions have no CORS by default and can allow exact origins. Security Rules validate direct client access; App Check can reject unattested clients, but baseline tokens are reusable and are not a score-integrity system. | Firebase CLI/emulators are mature. Managed Firestore export/import requires billing and charges document operations plus Cloud Storage. GitHub workflows can deploy rules/functions, but this is a broad rewrite. | Best when the project wants Firebase Auth/App Check/SDKs for future features, not for this leaderboard alone. |
| **Neon Postgres + Neon Function** | As announced at GA on 17 Sep 2026: Free projects receive 100 CU-hours, 0.5 GB database storage, and 10 branches; Functions receive 10 active Capacity-Hours, 400 waiting Capacity-Hours, and 1M invocations/project/month. | Relationally sound and a Node HTTP Function can preserve the API, but SQLite must be translated to Postgres. Neon Functions and the full backend suite only became GA this month. | Function code must implement the exact-origin CORS policy and an abuse strategy. Neon Data API offers JWT + RLS, but anonymous public score submission still needs custom policy/validation. | Standard Postgres tools (`pg_dump`, `pg_restore`, CSV) and Neon branches work well with GitHub previews; `neon.ts` can declare functions. | Strong watchlist/experimental alternative. Attractive current free tier and portability, but too newly GA to displace the much smaller Cloudflare migration. |

Supabase sources: [billing and quotas](https://supabase.com/docs/guides/platform/billing-on-supabase), [free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing), [database size behavior](https://supabase.com/docs/guides/platform/database-size), [Edge Function pricing](https://supabase.com/docs/guides/functions/pricing), [CORS](https://supabase.com/docs/guides/functions/cors), [API security/rate limiting](https://supabase.com/docs/guides/api/securing-your-api), [imports](https://supabase.com/docs/guides/database/import-data), [backups](https://supabase.com/docs/guides/platform/backups), [deployments](https://supabase.com/docs/guides/deployment), [Pro pricing](https://supabase.com/pricing).

Firebase sources: [Firebase pricing](https://firebase.google.com/pricing), [Firestore pricing/free quota](https://firebase.google.com/docs/firestore/pricing), [Firestore indexes](https://firebase.google.com/docs/firestore/query-data/indexing), [HTTP Function CORS](https://firebase.google.com/docs/functions/http-events), [Cloud Functions requirements](https://firebase.google.com/docs/functions), [App Check enforcement](https://firebase.google.com/docs/app-check/enable-enforcement), [web App Check](https://firebase.google.com/docs/app-check/web/recaptcha-provider), [Firestore security](https://firebase.google.com/docs/firestore/security/overview), [Firestore export/import](https://firebase.google.com/docs/firestore/manage-data/export-import), [Local Emulator Suite](https://firebase.google.com/docs/emulator-suite).

Neon sources: [September 2026 backend GA and free allowances](https://neon.com/blog/neon-backend-is-ga), [Neon Functions architecture](https://neon.com/blog/neon-functions-backend-logic-next-to-your-data), [Data API](https://neon.com/blog/a-postgrest-compatible-data-api-now-on-neon), [Postgres migration tools](https://neon.com/tools), [GitHub schema workflow](https://neon.com/blog/track-schema-changes-automatically-in-your-pull-requests).

## Approval gates for a later implementation

No account or deployment work is needed to prepare a reviewable code prototype. If this direction is approved, the safest sequence is:

1. prepare and test the Worker split, API configuration, CORS, and rate limiting locally;
2. show the exact diff and test results;
3. only then create/connect the Cloudflare and GitHub resources;
4. rehearse schema/data import against staging;
5. publish GitHub Pages against staging;
6. approve the production data import and API cutover after the historical-score export question is resolved.

At the time this proposal was written, the next decision was approval for a local prototype. The user has since approved starting the full transition; remaining external steps are listed in the current deployment guide.
