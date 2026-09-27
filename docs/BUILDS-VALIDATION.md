# Builds & Bargains validation and handoff

27 September 2026. Implemented against the inspected `e79470c` checkout without resetting it. Local source is `.sites-runtime/source`, with changed files also mirrored to the project root after checking the root against the baseline. No new dependencies. No deployment, push, domain change or account change. Existing public site remains unchanged.

## Delivered milestones

1. Preserved recovery on all selection paths, Havoc one-roll blast criticals, shared damage/provenance/kill handling, bounded 60 Hz clock and complete controller menu/username route.
2. Five run-only weapon mods, nonrecursive bounded secondary effects, deterministic once-only reward queue, exhausted-pool handling, mandatory Quarry draft and descriptive Pause build reference.
3. Four optional rewarded trials, validated placement, previewed curse, explicit roster/descendants/state/abandonment, one chosen reward and challenge-only remaining statues.
4. Mutually exclusive Meadows Echo/Wake choice, manual-fire Echo volley and actual-route nonstacking Wake, with lifecycle cleanup.
5. Iron Maw cover stagger and required Quarry gate; Caldera vent trial; Citadel protective anchors; Warden phase-two interruptible node event.
6. Robust local profile, editable remembered username, bestiary, milestones, equipped visual cosmetics, accurate run report and additive mode/version/curse leaderboard support.
7. Deterministic isolated local practice, integrated tests, browser inspection, documentation and read-only implementation review.

Material implementation decisions: no starting weapons or ordinary upgrades removed; trial elites receive the boss-safe 1.5× Insta Kill rule; exhausted trial mods merge into one explicitly labeled ordinary draft instead of presenting duplicate options; Iron Maw waits for explicit trial resolution/abandonment; practice is invulnerable and never writes scores/progress. Local gameplay version is `builds-1`. Numerical choices are initial tuning, not established balance. Full defaults and interaction rules are in `BUILDS-BALANCE.md`.

## Commands and automated results

The exact package test script was run with Node 24.19 (npm launcher unavailable in this shell):

```sh
node -e "const {execSync}=require('node:child_process');const p=require('./package.json');execSync(p.scripts.test,{stdio:'inherit'})"
```

Exit **0**. Build packaged 114 public assets. All **18 test programs** passed:

| Test | Coverage |
| --- | --- |
| `audio-lifecycle.mjs`, `music.mjs` | Unlock/recovery, connected volume buses, both original music arrangements and voice bounds |
| `graphics.mjs`, `ballistics.mjs` | Render preferences/weather lifecycle; actual 3D bullets, cover, slopes, overhead misses |
| `encounters.mjs` | Existing pickups, binding migration, statues and safe portal routes |
| `progression.mjs`, `mods.mjs` | Distinct/exhausted drafts, stable queue IDs; all five effects, recursion/cover/tick/cap/pull rules |
| `trials.mjs`, `dash-traits.mjs`, `challenges.mjs` | Trial states/descendants/placement failure; Echo/Wake rules; node deadline and charge-only stagger |
| `profile.mjs`, `builds.mjs` | Corrupt/missing/old/full/unavailable storage, unlock/equip/isolation; cooldown spam, Havoc criticals, trial integration, source attribution, health-removed accounting, retry reset |
| `campaign.mjs` | Required Quarry gate and one reward, every weapon versus anchors, shield stages, vent cleanup, Warden deadline/interruption/victory, 15 seeded worlds |
| `inputs.mjs` | Actual pad dispatcher through menu → on-screen username → run → pause → draft → end → retry; held-opening-input suppression, touch fire, weapon reselection, full held-fire Echo volley |
| `stress.mjs` | 15 heavily upgraded worlds across all five families and three seeds, alternating dash traits, mixed 10–144 Hz updates, finite state/caps/reset and abandoned attack cleanup |
| `smoke.mjs` | Existing 75-second combat, CPU attract demo, manual fire/rebound keys, terrain shots/crawlers, portals, normal/Death scoring and retries, tutorial/powerups, final boss and restart |
| `terrain.mjs` | 100 generated stages, 3,000 safe spawns, 400 routed large-enemy journeys, landmark/portal access, dash walls and rendered-height agreement |
| `server.mjs` | Additive migrated SQLite data, nullable history, idempotency, invalid payloads, binary assets; mode/version WHERE before LIMIT with 30 higher Death scores and query-index verification |

After the final exhausted-trial label/test adjustment, `node build.mjs`, `node tests/builds.mjs`, `node tests/inputs.mjs`, `node tests/campaign.mjs` and `node tests/smoke.mjs` were rerun successfully. `git diff --check` found no whitespace errors (Git reports expected Windows LF/CRLF conversion notices).

VM tests use real Three.js scene/terrain/math with mocked rendering, DOM, audio and fetch. They do not send production scores. The SQL tests use a disposable local database. Assertions are not evidence of subjective fun or physical-device usability.

## Measured performance

The stress run measured median **883ms**, max **1,326ms** CPU combat work per seeded scenario on this machine, excluding terrain setup, with rendering mocked. Its mixed cadence advances roughly 27s per scenario (slightly less when a reward consumes a step). Peak counts were 114 live shots, 12 scars, 6 pulls, 24 Wake segments and 361 particles; the existing particle loop allows its documented 360 threshold plus the final particle. Configured limits are 320 shots, 12 scars, 8 pulls and 24 Wake segments. Terrain suite maximum generation time was **221ms** in this run. These are local measurements, not hardware FPS guarantees.

The browser's rendered-frame counter showed approximately **60 FPS at a 60 FPS cap** in desktop practice, including a Death + Nightmare scene with ten hostiles. UI transitions briefly reported lower rates. This was a short observation, not a sustained GPU stress benchmark or a promise for phone hardware. Clock tests separately cover 10, 15, 24, 30, 60, 120 and 144 Hz and pause/stall handling; gaps over 250ms intentionally discard simulation time.

## Browser inspection

Actual local browser at 1280×800 and 390×844:

- Normal daytime and Death Mode with Nightmare graphics; Death badge, rain/fog, visible terrain, and separate settings state.
- Major → ordinary → dash reward queue; distinct weapon sprites and readable narrow cards.
- Pause build, Journal locked/unlocked selections and actual header badge hide/show; practice clearly reports unsaved progress.
- On-screen username keyboard, character entry and retry. Fixed Space/Delete overlap and visually rechecked.
- Mode/version leaderboard empty state, narrow table/filter layout and collapsible personal results against the local migrated backend.
- Collapsible end report and retry on narrow screens. Reduced victory heading size to avoid broken words.
- One complete **scripted practice campaign** through all five stages, using developer objective helpers: Meadows dash selection; Iron Maw and guaranteed mod; Caldera trial reward; Citadel anchors; Warden nodes both ignored and interrupted; final victory/report.
- Browser warning/error log empty in the inspected scenes. No production leaderboard was written. Practice profile and score isolation were also explicitly verified during review.

The complete campaign used invulnerability and objective-resolution controls. It was **not an unassisted manual playthrough**. Physical controller/touch hardware was not available; input paths were automated through the game's dispatchers and browser buttons. The original soundtrack was regression-tested, not re-evaluated by listening in this turn. Ember selection and effect color wiring were tested/inspected, but no polished gameplay capture of the moving trail was produced.

Review found and fixed overlapping-scar tick multiplication, stale weapon mesh on restart, vent player/enemy cover disagreement, and misattributed projectiles from co-located enemies. Each has focused regression coverage. Trial-owned pending shots/hazards now disappear on abandonment. The reviewer did not implement code.

## Limits and remaining playtesting

- Backend changes are implemented and tested **locally**; production has not received the new migration or Worker. If this client meets a server without the new capabilities, it labels the combined legacy board instead of pretending to have complete mode rankings.
- Scores remain unverified and client-reported; old versions are not balance-equivalent. No statue score multiplier or authoritative anti-cheat was added.
- Profiles are per-browser/device, with no cloud sync. Unavailable storage means session-only progress. Failed upload retry state remains in memory until page reload; saved local personal results do not automatically upload later.
- Human playtesting remains for difficulty, drop/reward pacing, all-mod synergy and readability under sustained dense combat. Physical gamepad/touch and lower-powered devices need hands-on checks.
- Terrain coverage is broad and finite; it is not proof against every procedural seed. Long stalls deliberately lose simulation time rather than catch up unseen.
- Deferred as requested: Overcharge, multiplayer, new biomes/endless, permanent combat grinding, additional weapon variants/dash abilities, dimension switching and a server-authoritative rewrite.

Use the local preview at `http://127.0.0.1:4173/` for ordinary play, or the seeded scenarios in `MANUAL-EDITING.md` for reproducible comparisons. Root mirror source files, migration and generated Worker are included. No remote action is required to inspect this result.
