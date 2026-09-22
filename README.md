# Neon Crypt · Riftlands

Five geographical stages, each rebuilt when entered:

- **Meadows:** rolling hills, shallow valleys, woodland and stone arches.
- **Shattered Quarry:** excavation shelves, steep cuts, switchbacks and mining gantries.
- **Ember Caldera:** a sunken basin, raised crater rim, radial climbs, basalt vents and lava outcrops.
- **Aurora Citadel:** stepped fortress platforms, broad avenues, towers and crenellations.
- **The Void Crown:** deep fissures, branching ridges, crystalline monoliths and suspended slabs.

Each run seeds different terrain detail and scenery. Entry plazas, connected paths and portal clearings are reserved. Players and enemies share the rendered triangle surface. Steep faces and solid structures stop movement; ramps provide walking routes. Dashes and charges use short collision steps. Enemy spawns are restricted to the connected navigation region, and enemies follow routes around obstacles and cliffs.

The existing weapons, planar combat hit rules, stage objectives, portals, XP collection, upgrades, boss, input settings, day/night controls, audio and online leaderboard remain. Projectiles and effects follow elevation; terrain does not introduce a new cover or projectile-occlusion system.

## Development and checks

Requires a recent Node.js release (Node 24 for the SQLite server tests).

```sh
npm ci
npm run build
npm test
```

Serve `dist/` with a local static HTTP server to preview the game. The leaderboard requires the existing Worker/D1 deployment; its schema and API have not changed.

`dist/game.js` integrates gameplay, `dist/terrain.js` owns generation/collision/navigation, and `dist/scenery.js` builds batched Three.js scenery. `build.mjs` packages the public modules into the existing Worker. The bundled Three.js assets and lockfile are preserved.

`tests/terrain.mjs` checks 100 seeded stages, 3,000 spawn locations, 400 routed large-enemy journeys, all landmark/portal routes, dash collisions, geography differences and exact agreement between rendered and sampled heights. The smoke suite simulates combat, controls, progression, lighting and the final boss; server tests cover leaderboard persistence and module serving.

Static scenery uses instancing; old terrain geometry, materials and instance buffers are disposed at each transition. No new runtime dependencies are introduced. Browser rendering was inspected across all five stages. CPU generation timings and draw-call counts are reported by the terrain suite; these do not guarantee a frame rate on every device.
