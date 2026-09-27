# Campaign quality validation — 27 September 2026

Baseline: Sites v16 / `1fd67d65ce3b800989c48e5c6a96d5df3106dbce`. Current gameplay cohort: `campaign-2`. Public Site identity, audience, database and historical scores are retained. This document distinguishes automated integration checks from browser inspection and human playtesting.

## Implemented scope

- Brief opening, stage transitions, Iron Maw/Warden entrances, Warden phase change and victory aftermath. Pause/skip/restart, reduced motion, once-only completion and combat/timer suspension.
- Responsive acceleration/braking, occlusion-aware elevation assistance, harmless ordinary arrivals, bounded ambient/surge/summon counts and short spawn-recovery windows.
- Unique offense/survival draft choices, capped-option removal, calculated mod/dash previews and build tips.
- Five optional authored landmarks with reachable interaction, brief lore, one small recovery per stage, terrain/structure cover and owned disposal.
- Local Journal weapon mastery, specific challenges, tracked goal and cosmetic-only rewards; end-of-run accomplishments and death advice.
- Exact face-slope walkability, swept collision, validated contour sliding and navigation margins; clearer rock faces, ramp treads and upper ledge markings. Ultra fine 720-pixel graphics option.
- Additional player/monster/interaction/ambient SFX, alternating 32-bar Normal/Death music and a dedicated 16-bar main-menu theme after browser audio unlock.

## Regressions found and fixed

Actual terrain face gradients could exceed the movement limit even when averaged cardinal samples declared a point walkable. This created isolated off-route trapping cases. The new solver and visual classification share actual face slopes; the player radius stays unchanged. A full-suite failure also exposed a steep shoulder on the authored direct Citadel portal approach; its transition was eased from radius 5–8 to 5–10 while preserving the flat inner clearing. Thirty new direct-portal cases cover all five stages across six seeds. At diagnostic seed 7919 only 224 of 23,409 vertices per world changed, all between radii 5 and 10; authored stage geography stays intact. The smoke test now fixes its random seed for repeatability. Navigation no longer relies on knife-edge paths. Landmark placement now rejects an approach that is connected but too low to interact. Upper rim triangle winding is checked so edge markings face the overhead camera.

Other fixed cases include capped Deadeye still appearing in drafts, surge/summon paths bypassing population bounds, ordinary arrival animation allowing immediate contact damage, an exact-overlap crawler distance producing no contact, blocked/out-of-range elevation-assist targets, and sequence entry being overwritten by trial-abandon/pause logic. Phase and Rift Echo material copies retain the PS1 shader callbacks; Warden phase resources survive through the victory aftermath. Dynamic Journal actions restore keyboard focus.

## Automated complete campaigns

`node tests/campaign-runs.mjs` executes the real game update at 60 Hz with terrain navigation, real firing/projectiles, XP/drafts, both required bosses and actual rift entry. It does not edit enemy health, kills, quotas or portal state. It starts with **10,000 player HP** and scripted targeting that knows enemy positions. This tests progress and lifecycle correctness, not ordinary-player survival or fun. Optional trials/discoveries have separate tests.

| Run | Simulated seconds | Kills | HP damage received | Outcome |
| --- | ---: | ---: | ---: | --- |
| normal-rifle | 240.47 | 211 | 427 | victory |
| death-stinger | 204.92 | 199 | 271.5 | victory |
| normal-scatter | 273.1 | 188 | 2860.4 | victory |
| death-lancer | 209.9 | 194 | 159 | victory |
| normal-havoc | 277.58 | 205 | 1297.4 | victory |

All five visited all five stages and reached victory. Across these runs the driver exercised 46 pauses, queued rewards, transitions and normal/skipped sequences. The Scatter run took substantially more damage; these bots are not competent or equally optimized weapon play, so these values are a playtest lead rather than a balance verdict. The ignored `.sites-runtime/campaign-runs.json` retains the full per-stage/build/bounds report.

## Focused simulation and geometry checks

- Terrain: 100 seeded worlds, 3,000 spawn samples and 400 routed large-enemy journeys, plus required waypoints, exact render-height agreement and collision/dash coverage.
- Off-route traversal: 69,120 walking/dash steps, 65,993 straight-leg walking reversals, 51,095 off-route keyboard-escape samples, unchanged narrow-passage clearance and bounded displacement. A separate read-only review sampled another 2,160 movements with randomized camera headings in Quarry/Citadel/Void seeds.
- Terrain readability: each of five rendered surfaces matches actual slope classification; rim normals face upward, positions are finite and the visual builder leaves the collision heightfield untouched. At most three terrain-surface draw calls.
- Fifteen worlds retain accessible, once-only landmark claims, portal/outer routes, statues and matching projectile/movement solids. Fifteen seeded campaign worlds also exercise existing trials and boss requirements.
- Campaign state, mastery/profile migration and isolation, dynamic build previews, population/arrival constraints, aiming/cover/crawler hits, score outbox and server contracts all have focused regressions in the package suite.

## Browser checks actually performed

Local Chromium preview, not production test runs: desktop campaign UI, discovery interaction/reward, Journal tracking/cosmetics, 390×844 Journal layout, Warden entrance framing/phase/aftermath, new Quarry cliff/ramp contrast, and Ultra fine's 720-high canvas with preference retained after reload. Local Pixelation was restored to the prior Fine setting. The final Quarry view had no captured console errors. Test pages/tabs were removed afterward. Practice is score/profile isolated.

The Impeccable detector ran on the current UI; body viewport clipping is intentional for the game surface, retro styling overrides inherited modern CSS, and functional HUD/table labels were raised to at least 11px. Two-choice rewards center on desktop and stack/scroll on narrow screens. This is bounded visual inspection, not exhaustive screen-reader or device certification.

Native OfflineAudioContext rendered the full menu/Normal/Death arrangements. All samples were finite, both halves had nonzero energy, no clipping occurred and no music voices were dropped:

| Arrangement | Bars | Peak amplitude | RMS | Peak live voices |
| --- | ---: | ---: | ---: | ---: |
| Menu | 16 | 0.03568 | 0.00340 | 18 |
| Normal | 32 | 0.20746 | 0.02160 | 45 |
| Death | 32 | 0.22047 | 0.02784 | 57 |

A separate live analyser verified the actual main-menu AudioContext after clicking Settings: running, one resume, nonzero output peak 0.01409. This establishes graph output, not subjective speaker listening. Audio lifecycle tests cover gesture unlock, suspended/interrupted/closed context recovery, mute/zero volume, menu scheduling, demo effect silence and warning headroom. Effect definitions have bounded tails, layers and cooldowns.

## Commands and remaining limits

The package test script builds the Worker, then runs the project's complete Node test list. On this Windows session npm was absent from PATH, so an equivalent Node runner executed each literal `node ...` command from `package.json` in order using the bundled Node 24 executable. Output is retained in ignored `.sites-runtime/campaign-quality-final.log`. Build output must match current assets for the server binary-asset test; an earlier stale-build failure was corrected by rebuilding after edits.

Final package result: **PASS — all 32 commands (one build + 31 test programs)**, followed by a clean `git diff --check`. Independent final terrain/audio review found no remaining reproducible serious blockers.

No full unassisted human campaign, physical controller, real mobile GPU, broad browser matrix or subjective audio-mix assessment is claimed. Automated geometry sampling cannot prove that every possible procedural seed is free of all navigation problems. Browser-local Journal progress does not sync between devices. The leaderboard remains shared/server-backed but client-reported, without competitive anti-cheat. No production scores were submitted during testing.
