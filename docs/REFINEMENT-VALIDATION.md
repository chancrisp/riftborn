# Riftborn refinement validation — 27 September 2026

Implemented against published v15 source commit `3469e35cc55ed6c0d6490e3ac7be2f5956a784fd` in `.sites-runtime/source`. The project-root mirror is synchronized after checking it against that baseline. No dependencies, schema, Site identity, URL or sharing changes. Builds & Bargains was already live; older local-only wording is historical. Gameplay version remains `builds-1`.

## Delivered

1. Terrain-conforming, fixed-boundary crosshair/ring/corridor warnings; fog-independent priority, family-specific original sounds, committed sniper pitch, scaled/collision-aware charge paths, predicted leap landing and owned-marker disposal.
2. Distinct five-weapon recoil/light/impact/SFX profiles, bounded visual hit compression, reduced-motion handling; player damage, fire recovery and selection rules preserved.
3. Shared PS1 dither cutaway for obstructing scenery/ridges, with smooth restoration, floor/depth guards, no collision or instancing mutation and constant CPU projection work.
4. Shared upgrade effects and shot calculations; compact selected-weapon before/after values, healing/caps and Havoc applicability. Subsecond intervals use three significant digits to avoid hiding small changes.
5. One rate-limited actual-event build cue, preserved Storm counter, truthful Echo consumption and lifecycle cleanup; no per-pellet notification flood.
6. Small measured fairness corrections: consistent vent onset, 0.35s final leap warning, at least 0.25s ranged anticipation on fresh eligibility, full sniper direction commitment and visible Warden-node placement. Existing encounter HP/damage/rewards, curse/Death scales and supporting spawn budgets retained. Anchor tethers explain protection.
7. Bar-boundary adaptive original music, quiet reward/pause mix, Normal/Death arrangements, source caps, explicit cleanup and no hidden-tab catch-up scheduling.
8. Compatible personal-best/previous-run reports, retained best scores beyond recent history, immutable IndexedDB outbox, atomic tab leases, reload recovery, timeout/backoff, explicit rejected/storage states and retained fallback entries.

## Exact checks

The complete package suite was run using the available Node 24.19 launcher:

```sh
node -e "const {execSync}=require('node:child_process');execSync(require('./package.json').scripts.test,{stdio:'inherit'})"
```

Exit **0**, **22 test programs** passed: `audio-lifecycle`, `music`, `refinement`, `outbox`, `occlusion`, `graphics`, `ballistics`, `encounters`, `progression`, `mods`, `trials`, `dash-traits`, `challenges`, `profile`, `builds`, `campaign`, `polish-pacing`, `inputs`, `stress`, `smoke`, `terrain`, `server` (all in `tests/`, extension `.mjs`). The final interval-format precision adjustment was followed by `node tests/refinement.mjs`; final packaging uses `node build.mjs`, `node tests/server.mjs`, and `git diff --check`.

New focused assertions cover: Normal/Death and 0/10/50/100 curse warning paths; sampled warning heights; fixed blast radius; cancellation/disposal; actual mod/Echo events; blocked/capped Echo consumption; shared shot formulas and capped/healed values; five-world cutaway shader/collision/draw-call parity; music bar transitions/reset and hidden recovery; retained immutable payloads, same-store concurrent claims, expired-owner recovery, network backoff, permanent rejects, malformed records, unavailable storage and readable-but-full quota storage; compatible unknown fields and best retention.

Baseline suites retain manual-fire/selection recovery, crawler/3D bullet cover, all weapons/mod rules, progression, tutorial/attract/profile isolation, controller/touch/rebinding dispatch, bosses, powerups, 100 terrain worlds, 3,000 safe spawns, 400 large-enemy routes, SQLite migration preservation, server idempotency and mode/version ranking before LIMIT. VM tests use real scene/terrain math with mocked rendering/DOM/audio/network. They do not submit production scores.

Read-only independent review found and resolved a full-storage fallback queue bug, stale Echo READY at projectile capacity, and save-status/unknown-stage edge cases. Focused regressions were rerun. A reproduced ridge-blocked Warden node pair now chooses a visible alternative without consuming a failed placement event.

## Browser evidence

Local browser inspection covered desktop 1280×720 and narrow 390×844: Normal/Death, daytime/Nightmare, all five stage families, obstruction positioning and short/long zoom, dense scenes, ordinary/major/dash reward sequence with visible focus, Iron Maw, vent/anchor trials, Warden phase-two nodes, and expanded run reports. Cards remained readable; a filled corridor was replaced with perimeter rails after it obscured the player. The report's open state hides the floating skull to protect text. No runtime errors were captured in inspected scenes. Temporary viewport and Nightmare changes were restored.

A separate local-only browser probe used a QA IndexedDB database and a stubbed sender: an offline record survived reload with original ID/score, two independent IndexedDB connections produced one upload claim, and confirmation cleared it. The probe never called the production API. It also rendered a Death/boss bar through OfflineAudioContext: nonzero output, peak **0.127**, RMS **0.015**, bounded source pool and zero active sources after stop. Pre-scheduling that whole bar reached the 96-source cap; this is a cap/cleanup test, not a measurement of steady-state live voices or a subjective listening session. Reusable source is `tests/refinement-browser.html`, excluded from public assets.

Screenshots are local QA artifacts in the project root's `.sites-runtime/qa/`; `refinement-narrow.png` shows the actual narrow upgrade comparisons. The browser scenarios use invulnerability and developer controls. There was **no unassisted manual campaign playthrough**, physical controller/touch test or listening-based soundtrack evaluation in this pass.

## Measured performance and pacing

Final heavy-build stress sample: median **1,060ms**, max **1,579ms** CPU combat time per scenario (15 seeded worlds, rendering mocked). Peak counts: **121 shots, 12 scars, 8 pulls, 24 Wake segments, 361 particles**. Maximum terrain build time: **237ms**. These are this machine's measurements, not frame-rate guarantees.

The desktop browser counter sampled near **120 rendered FPS** at its 120 cap, including a 55-hostile scene. Cutaway uniform work averaged approximately **0.002–0.007ms** in sampled windows; renderer submission around **0.3–4.5ms** as scene density changed. Scene reset/compilation briefly reduced observed FPS. Total composer calls remained consistent with existing instancing; dense monsters dominate the draw count. CPU submission is not GPU time, and these varying scenes are not a controlled GPU before/after benchmark. The shader adds fragment work; low-powered hardware still needs testing.

The 24 additional 20s assisted samples use stages 2–5, seeds 11/7361/91257, both modes, +50 curse, all mods and moderately stacked ordinary stats. Actual player HP removed is recorded independently of healing. Sample peaks were 30 concurrent enemies and 11 delayed hazards. Warden-assisted resolution ranged 3.4–10.3s, and some Quarry samples resolved in 4.5–16.4s; other Quarry samples and all trial samples remained unfinished at 20s. The route/aim bot is not a human player and has inflated HP. Reward/visual randomness still varies results, despite fixed terrain seeds. These results support bounds and rule checks and expose heavy overlapping trial pressure; they do not justify broad balancing or establish fun.

## Remaining limits

- Human playtesting is still needed for late trial pressure, stacked builds/curses, warning density, audio mix and encounter enjoyment. Physical gamepad/touch and low-powered GPU performance are not established here.
- Charge corridors are conservative under temporary slows. Terrain-following outlines can look distorted on steep slopes and deliberately remain visible through foreground surfaces. The cutaway reveals only the immediate player window, not every distant enemy.
- Profiles/bests and retry storage are browser-local, not cloud-synchronized. Previously discarded pre-update retries cannot be recovered automatically. Storage denial/full conditions cannot promise survival after closing the tab; the UI says so. A crash after server acceptance may resend the same ID, safely deduplicated by the server. No authoritative anti-cheat or exactly-once HTTP claim.
- Existing detailed history is capped at 50, while best scores are retained separately. Older unknown fields stay unknown. `builds-1` is a compatibility bucket, not proof that every historical patch is competitively equivalent.
- No new modes, weapons, biomes, multiplayer, permanent combat progression, autofire or ammo/reloading were added. No production test scores were submitted.

Publication uses the existing public Sites project and native deployment status. The successful URL/version is reported in the conversation after packaging; this document records the verified source before that external deployment.
