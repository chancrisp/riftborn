# Riftborn refinement implementation plan

> For agentic workers: use superpowers:executing-plans inline; fresh whole-change review at completion.

Goal: implement the user's eight refinements without changing the game identity or progression.
Spec: attached eight-part refinement brief, 27 September 2026, in this conversation.
Baseline: clean 3469e35, confirmed live Sites version 15. Source checkout `.sites-runtime/source`; root is a mirror. Existing Sites public audience and project identity are fixed.

Architecture: retain game.js coordination; focused modules own upgrade calculations, feedback, scenery cutaway, run comparisons and durable score outbox. The existing music scheduler gains a bounded intensity state. No dependencies, backend rewrite or new gameplay systems.
Tech: Three.js, Web Audio, IndexedDB, native ES modules, Node VM/SQLite tests.

The supplied implementation brief and prior approved refinement direction authorize execution. Routine parameters are delegated to the implementer; no repeated plan-approval gate. GrillMe's role here is edge-case/fact review; Impeccable preserves the incumbent PS1 design. Work inline with one read-only pacing fact audit and one final independent review.

Review focus: same-run immutable retries across tabs; storage denied/full must retain unsaved in-memory entries visibly; cutoff cannot change physics/raycasts; warnings must follow actual damage geometry and owner cleanup; feedback/music cannot alter gameplay clocks or leak across sessions.

- [x] 1. Shared upgrade stats and comparisons. `dist/upgrades.js`: shotStats(player,weapon,boons), applyUpgrade(player,id), upgradePreview(player,id,weapon,boons). Test caps, all weapons, current powerups and nonmutation; replace equivalent combat/card formulas.
- [x] 2. Run feedback/reliability. `dist/run-history.js`: compareRun(run,runs); `dist/score-outbox.js`: transactional IndexedDB records, immutable enqueue, expiring claim leases, timed bounded retries and retained failures; integrate finish/report/reload/online events. Test shared store concurrency, failures, duplicate IDs and compatible comparisons. Browser probe exercises real IndexedDB in isolated test database.
- [x] 3. Warnings/weapon/mod/dash feedback. `dist/combat-feedback.js`: bounded event cues and warning styling; integrate existing attack owners, hit reaction, capped sound/visual cues and shared HUD. Test cancellation, pause, actual trigger counts and unchanged firing/damage. Read-only audit informs minimal timing corrections.
- [x] 4. Camera cutaway. `dist/occlusion.js` + retro/scenery shader hooks: screen-space dither around the player only for world surfaces in front of it; retained instancing/collision, bounded CPU uniform updates and hysteresis. Test shader inclusion/uniform lifecycle/world family geometry parity; inspect orbit/zoom in browser.
- [x] 5. Adaptive music. `dist/soundtrack.js`: bounded beat-boundary intensity, subdued reward/pause mix and denser trial/boss layers without restarting transport. Test normal/death, rapid switches, cadence and volume/recovery.
- [x] 6. Integrate/check. Add focused tests to package suite, run baseline suites, multi-seed high-upgrade simulations and bounded browser desktop/narrow/Normal/Death/Nightmare checks. Keep test data off production. Record measured performance and assisted-vs-manual coverage.
- [x] 7. Review/docs/release preparation. Resolve important review findings; update README/DESIGN/balance/manual guide and validation. Mirror verified changed files, package/publish through existing Sites workflow and verify terminal success.

Each implementation step: write focused failing assertions, confirm failure, implement, run focused checks and record evidence below. Low-impact copy/layout uses visual verification. Source commits follow tested milestones or final Sites workflow; no resets or force pushes.

Decisions: comparisons use device-local runs with known identical mode/version; completion speed only compares victories. IndexedDB transactional leases avoid competing upload ownership; idempotent server IDs cover crash-after-acceptance retries. No hard queue count cap or silent eviction. Camera treatment is a shader-only dither aperture, avoiding per-object scene unbatching. Gameplay version remains builds-1 unless the pacing review identifies a material balance change.

## Evidence ledger

Context inspected: shipped source and profile, combat, terrain, music, UI, leaderboard tests. Existing public v15 confirmed; Sites source opened cleanly. Impeccable context allows scoped refinement despite missing PRODUCT.md; existing DESIGN.md and screenshot evidence define the visual identity.

Completed implementation and checks: all eight refinements are integrated. Twenty-two suites pass; actual browser IndexedDB reload/concurrent-connection recovery and offline audio output checked; desktop/narrow scenes inspected. The final independent review has no unresolved blockers. README/DESIGN/balance/editing notes distinguish current behavior from historical v15 local-only notes. See `docs/REFINEMENT-VALIDATION.md` for measurements, limitations and precise test scope. Root mirroring and the native publication workflow follow these source checks; deployment confirmation is recorded in the conversation, not inferred from the local build.
