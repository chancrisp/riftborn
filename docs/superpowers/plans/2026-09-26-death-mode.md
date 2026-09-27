# Death Mode and creature overhaul

> Execution: use superpowers:executing-plans. The Site owner integrates all source changes; delegates only bounded assets/research.

**Goal:** Add a secret Death Mode, readable monster silhouettes and distinct attacks, and remove terrain traps while increasing scenery variety.

**Architecture:** Keep the existing Three.js simulation and collision surface. Snapshot menu difficulty at run start; use shared immutable tuning for enemy movement, damage and music. The player retains the existing model; monsters use a separate shared-geometry rig.

**Tech stack:** JavaScript modules, Three.js, Node simulation tests, existing Sites Worker and D1 leaderboard.

**Spec:** User request: floating PS1 red skull selects Death Mode; red tint; Esc cancels only before starting; fresh username; faster, harder enemies; intense music; exclusive variants. Latest steering requests monsters/zombies with distinct attacks and movement. Preserve clean menus, PS1 style, leaderboard, existing public Site identity.

- [x] Add failing mode/attack integration checks, then implement selection, immutable run mode, red skull/tint and music. Validate Esc through the actual key handler before and during a run.
- [x] Replace enemy soldier rigs with visibly distinct creatures. Add exclusive stalker, hexer and broodmother behaviors; test attack outcomes, range behavior and exclusive spawn pools.
- [x] Reproduce the terrain trap, prevent unsafe entry with surface-aware movement, add connected scenery clearances and varied native low-poly structures/flora. Verify small-step escape, dashes, portals and large-enemy routes across seeds.
- [ ] Run combat, ballistics, terrain and server regressions; inspect desktop/mobile menu and gameplay. Review regressions, build, publish to the existing public Riftborn Site, and sync the workspace mirror.

**Review focus:** Modal Escape must not change active difficulty; damage applies exactly once; exclusive enemies never appear in normal pools; new cover retains exact bullet hulls; scenery leaves navigable gaps; reduced-motion skull remains reachable; real runs always capture a fresh username.


- [x] Latest user steering: simplify Settings with Graphics/Audio/Controls tabs, pixelation, fog and rendering FPS caps. Tests verify preference persistence, pacing and live handlers. Desktop/390px browser inspection confirms keyboard tabs, visible values, persistent choices and readable layout.
- [x] Whole-change read-only review found no confirmed actionable findings. Combat, geometry, 100-stage terrain and fresh Worker tests pass. Temporary creature inspection page removed.
- Ruling: keep public Riftborn URL; user explicitly deferred custom-domain registration. Publish through the same Sites project with unchanged access.
