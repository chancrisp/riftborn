# Builds & Bargains implementation checklist

Goal: recognizable run builds by stage 3, optional rewarded risk, accurate combat and feedback.
Spec: user's attached Builds & Bargains brief (27 September 2026). Execute inline, with focused regression checks at each milestone and a final read-only review. The user explicitly authorized implementation without routine approval gates.

Baseline: e79470c, clean checkout. Existing browser Three.js game and Node VM/SQLite tests; no new dependencies. Work locally only: no deployment, push, domain or external-account changes. Keep normal/Death gameplay separate from Nightmare rendering. Retain all existing weapons, upgrades, tutorial, routes and controls.

Architecture: keep game.js as scene/input coordinator. Add focused pure simulation/reward/profile modules, and a bounded combat-effects module. All damage enters one resolution path; all rewarded dialogs enter one queue. Objects, encounter membership and shot provenance have explicit IDs. SQL additions are nullable and additive.

- [x] 1. Foundation: reproduce equip exploit and rocket critical gap; shared provenance/damage; 60 Hz bounded simulation; complete controller UI and username entry. Verify current regressions.
- [x] 2. Builds: five independent major mods; bounded effects; queued rewards, guaranteed Quarry draft and pause build display. Test interactions and collision.
- [x] 3. Bargains: validated optional trials, explicit states/abandonment, curse and one reward; complete first playable milestone.
- [x] 4. Dash: stage-1 choice of Echo or Wake, actual trajectory/collision and lifecycle tests.
- [x] 5. Encounters: Quarry charging miniboss/reward gate; Caldera vents; Citadel anchors; Warden node interruption. Verify all stage seeds and transitions.
- [x] 6. Feedback: robust local profile/bestiary/cosmetics; actual damage/death summary; compatible mode/version/curse leaderboard queries and local fallback.
- [x] 7. Integration: full suite, isolated seeded scenarios, browser desktop/narrow checks, measured simulation performance, documentation and final review.

Interface review: foundation shot metadata is consumed by mods, dash and summary; all secondary effects use sourceWeapon/shotId/generation. Trials and boss gates share stage lifecycle: cleanup never counts as victory. Queue events use stable keys; portal gates await mandatory rewards. Profile and scores share real-run eligibility, excluding demo/tutorial/debug/tests. Ranking filtering happens in SQL before LIMIT.

Design decisions and exact tuning are recorded in docs/BUILDS-BALANCE.md as implemented. Progress/evidence below is updated after each milestone.

Foundation evidence: real VM test reproduced Lancer recovery 0.70 → 0.16 seconds on selection; fixed. Foundation/build tests and existing smoke pass. Clock tested at 10/15/24/30/60/120/144 Hz, with stalls discarded. Mod unit scenarios cover bounds, recursion, cover and cleanup. Legacy route tests explicitly accept the new Quarry reward.

Trial lifecycle and integrated terrain/kill/claim tests pass; existing full smoke passed after fixing a null-trial equality bug caught by tutorial coverage.

Dash module and full existing smoke pass. Stage-one reward queue chooses the trait before departure; actual fire owns echo emission.

Campaign tests and full smoke pass: Quarry trial wait/abandon/stagger/reward, every weapon against anchors, progressive shield, vent pause/cleanup, Warden interruption/deadline/victory, 15 seeded worlds. Review caught scar tick overlap and stale reset weapon model; both reproduced and fixed with focused regression tests.

Profile/summary and migrated SQLite tests pass, including 30 higher Death scores not hiding Normal results and the query plan using its new index. Browser practice is loopback-only, seeded, invulnerable for inspection, and score/profile-isolated. Second review caught vent collision mismatch and position-inferred projectile killers; both now use shared collision/explicit emitter provenance and regression coverage.

Final evidence: all 18 test programs pass, including a 15-world heavily upgraded stress test and actual gamepad-dispatch username/menu/draft/retry route. Scripted browser campaign reached final victory, and desktop/narrow Normal/Death/day/Nightmare interfaces were inspected. Narrow username keys and long victory copy were corrected and rechecked. README, DESIGN, tuning and editing guides match the implementation; docs/BUILDS-VALIDATION.md records measured results, exact commands and remaining human/device/balance limitations. Local-only handoff; no production changes.
