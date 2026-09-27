# Riftborn

Five geographical stages, each rebuilt when entered:

- **Meadows:** rolling hills, shallow valleys, woodland and stone arches.
- **Shattered Quarry:** excavation shelves, steep cuts, switchbacks and mining gantries.
- **Ember Caldera:** a sunken basin, raised crater rim, radial climbs, basalt vents and lava outcrops.
- **Aurora Citadel:** stepped fortress platforms, broad avenues, towers and crenellations.
- **The Void Crown:** deep fissures, branching ridges, crystalline monoliths and suspended slabs.

Each run seeds different terrain detail and scenery. Entry plazas, connected paths and portal clearings are reserved. Players and enemies share the rendered triangle surface. Steep faces and solid structures stop movement; ramps provide walking routes. Dashes and charges use short collision steps. Enemy spawns are restricted to the connected navigation region, and enemies follow routes around obstacles and cliffs.

Five weapons, stage objectives, portals, XP collection, upgrades, a final boss, input settings, day/night controls, audio and an online leaderboard. Bullets keep their world-space position and velocity, including vertical aim. Swept collisions stop rounds on terrain and structures, distinguish shooting over an enemy from hitting it, and prevent fast shots tunneling through ridges. Explosions respect height and cover.

The PS1 visual pipeline uses textured low-poly models, nearest-filtered textures, affine UV interpolation, snapped vertices, low-resolution rendering, color dithering, and a bundled pixel font. All menus and the HUD share the same retro style. Weapon buttons use generated sprite art. Day and night retain visible nearby terrain; fog begins beyond the normal gameplay camera distance.

## Development and checks

The centered main menu keeps only the title and primary actions over a live CPU-driven run at 1.5× speed. The CPU targets enemies, changes weapons, navigates terrain and portals, chooses upgrades, and loops through stages. Demo runs never submit scores and reset completely when the player starts. Lighting and control instructions live in Settings. Starting or replaying a run always requests a fresh username.

The leaderboard shows Player, Score, Stage (furthest world reached), and Date (run completion, formatted in the viewer's local timezone). Retries use the same run ID and do not duplicate a score. The additive database migration preserves old scores and their original dates; old scores without stage data show a dash. This remains a casual client-reported leaderboard, without competitive anti-cheat verification.

Requires a recent Node.js release (Node 24 for the SQLite server tests).

```sh
npm ci
npm run build
npm test
```

Run `npm run dev` (or `node server/dev.mjs`) and open http://127.0.0.1:4173/. The preview uses the same score handler and migrations as production, with a separate persistent SQLite database at `.sites-runtime/preview.sqlite`. A static-only server can render the game but cannot save scores. Local preview scores stay local.

`dist/game.js` integrates gameplay, `dist/ballistics.js` owns 3D projectile collision, `dist/terrain.js` owns generation/collision/navigation, `dist/scenery.js` builds batched scenery, and `dist/retro.js` / `dist/retro.css` own rendering and interface style. `build.mjs` packages public modules and binary assets into the existing Worker. The bundled Three.js assets and lockfile are preserved. See `DESIGN.md` for the cohesive art direction and interaction contracts.

`tests/terrain.mjs` checks 100 seeded stages, 3,000 spawn locations, 400 routed large-enemy journeys, all landmark/portal routes, dash collisions, geography differences and exact agreement between rendered and sampled heights. Ballistics tests cover vertical misses, slopes, narrow ridges and overhead clearance. The smoke suite simulates combat, controls, progression, lighting, the final boss, independent bullet altitude, username entry and score submission. Server tests cover migration preservation, run dates/stages, ranking, idempotency and exact binary asset serving.

Static scenery uses instancing; old terrain geometry, materials and instance buffers are disposed at each transition. No new runtime dependencies are introduced. Browser rendering and menus were inspected at desktop and phone widths; simulation and geometry checks cover all five stages. CPU generation timings and draw-call counts are reported by the terrain suite; these do not guarantee a frame rate on every device.

## Publication and assets

The existing Sites project remains `appgprj_6aa98704c68481918773213043336865` at https://neon-crypt-voxel.chanmanc10.chatgpt.site. Its display name is Riftborn. Public access was explicitly requested to remove the sign-in landing page; preserve that audience and the existing URL.

`dist/assets/ps1-atlas.png` was generated from the prompt for a seamless 4×4 PS1 material atlas: skin, cloth, leather, steel, grass, masonry, rust, bark, basalt, lava, castle stone, purple rock, face, bone, foliage and UI metal. `dist/assets/weapons.png` was generated as a transparent horizontal sheet of five PS1-style side-view weapons: assault rifle, compact SMG, double-barrel shotgun, railgun and rocket launcher. Both are original assets. `crypt-pixel.ttf` is an original 5×7 pixel font.
