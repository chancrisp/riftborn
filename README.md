# Riftborn

## Campaign quality update, 27 September 2026

The current update gives the existing campaign a clearer beginning, encounter rhythm and ending while retaining manual fire, all five weapons/worlds, Normal/Death Mode and graphics-only Nightmare. Gameplay version is now `campaign-2`; older scores remain accessible under All versions, and the existing shared leaderboard, public audience and URL are preserved.

- Iron Maw rises from the quarry; the Warden descends, changes color when its crown breaks, and dissolves into a short aftermath before results. Combat and run clocks freeze during these brief sequences. Escape skips; Enter/Space or the on-screen button skip, or resume if paused. The configured Pause key and controller Menu pause/resume; controller A confirms and B skips. Reduced motion suppresses actor/camera motion. Opening and stage captions are brief and skippable too.
- Movement accelerates and brakes more responsively without changing top speed. Stick/touch elevation assistance selects visible, in-range enemies rather than an obstructed target. Shots retain natural 3D trajectories, standard crawler hitboxes and solid cover. Weapon roles, damage and shot recovery remain intact.
- Stage entry grants three seconds without new ambient spawns; ambient pressure rests for six seconds per 32-second cycle outside encounters. Trial completion grants six seconds and Iron Maw seven. Existing enemies remain active during these recovery windows. Ordinary enemies have a harmless 0.4-second arrival, and ambient/surge/summon populations share a 55-enemy budget. Trials defer without consuming the statue if the arena is full and place the roster at least six units from the player.
- Ordinary drafts contain an offensive and a survival/movement choice, exclude capped Deadeye, and keep unique options. Mod and dash cards show formula-derived effects and a relevant build tip. No alternate mods or permanent stat upgrades were added.
- Each world has a distinct discoverable landmark, short optional lore, and one recovery of up to 12 health plus four seconds without ambient spawning. Use Interact near it. Landmarks preserve navigation routes and bullet cover. Sparse synthesized ambient sounds distinguish the five stages and respect effects volume, mute and pause.
- The Journal adds five 75-kill weapon mastery goals, a damage-free Iron Maw challenge, a victory with at least three statues, and all-world discovery progress. Track one goal in the HUD. Rewards are an Aurora dash trail, Iron Maw badge and Cursed Crown badge; old cosmetics remain. Progress stays local to the browser; tutorial/demo/practice/test runs cannot earn it.
- Results show new accomplishments and advice for the lethal enemy. Tutorial guidance emphasizes evasion and terrain cover. Retry resets sequences, effects and queued rewards cleanly.

See [campaign validation and limitations](docs/CAMPAIGN-QUALITY-VALIDATION.md), [tuning](docs/BUILDS-BALANCE.md) and [editing guide](docs/MANUAL-EDITING.md). Automated assisted campaigns check progression; human difficulty and enjoyment still need playtesting.

The final pass also fixes off-route terrain traps: walkability uses the actual triangle slope, movement sweeps solid footprints and slides along valid contours, and navigation keeps a small margin from cliff edges. Portal approaches blend into their clearings more gently, and player size remains unchanged. Steep faces have darker rock textures, upper ledge markings and stronger ramp contrast. **Ultra fine** adds 720-pixel internal height above Fine's 480.

Audio now includes surface-specific footsteps, dash endings, a low-health heartbeat, shield/pickup/portal/death cues, flesh/stone impacts, monster voices and distinct five-world ambience. Effects are distance-attenuated where appropriate and rate-limited. Normal and Death music each have two alternating 16-bar sections; a separate 16-bar menu theme accompanies the CPU demo. Music begins after the first click/key/touch gesture, respects volume/mute and suspends hidden-tab scheduling. Demo combat effects remain silent. All music and SFX are original synthesized audio.

## Builds & Bargains + refinement update, 27 September 2026

Builds & Bargains shipped as Sites version 15 and the refinement pass below shipped as version 16. This section records that earlier baseline. The existing public site, account, audience, database and domain are preserved. That baseline used gameplay version `builds-1`; the current campaign update above uses `campaign-2`.

The refinement pass adds terrain-conforming danger outlines, scaled charge corridors, distinct attack sounds and stronger weapon feedback without changing player shot recovery or damage. Foreground scenery uses a small PS1 dither cutaway around the player; collision, bullet cover and instancing stay intact. Ordinary reward cards show current → upgraded values from shared combat calculations. One restrained build cue reports successful mod/dash events alongside the existing Storm Needle counter.

Trials and bosses add soundtrack layers at bar boundaries; rewards and pause ease the mix. Run reports compare compatible local runs and retain personal-best scores beyond the 50 recent-run list. An IndexedDB outbox preserves failed score uploads through reloads, with atomic tab ownership, fixed IDs, backoff and explicit failures. If local storage is blocked/full, unsaved fallback runs stay in memory with a keep-tab-open message. Tutorial/demo/practice/test runs remain isolated.

Small pacing fixes: ranged enemies get at least 0.25s of anticipation even when first entering range with a ready attack; leapers get a 0.35s final landing warning (formerly 0.2s); each vent active phase starts its pulse clock consistently; Warden nodes require two visible, separated placements before their six-second deadline starts. Encounter HP, damage, quotas, rewards and mode/curse multipliers are unchanged. See [refinement evidence and limitations](docs/REFINEMENT-VALIDATION.md).

Keep moving, manually aim/fire, collect XP and choose ordinary upgrades. Clear each stage's quota, then enter its rift. All five weapons remain available from the start. After Meadows, choose **Rift Echo** (one 50%-damage repeated volley after a dash) or **Void Wake** (a short slowing trail). Quarry now requires defeating **Iron Maw** after its 22-kill quota; bait its charge into solid cover to expose it. Defeating it guarantees a major weapon-mod draft before the exit opens.

The five independent run-only mods are **Splinter Rounds** (Rifle split shots), **Storm Needle** (Stinger hit-charge chains), **Graveburst** (Scatter close-kill fragments), **Rift Scar** (Lancer damaging flight traces), and **Event Horizon** (Havoc delayed pull/explosion). Ordinary upgrades remain a separate nine-item pool. Queued rewards pause combat and offer only valid choices. Pause lists your build and each effect.

One skull statue in each of the first four stages offers a **Skull Trial**. Preview the encounter and permanent-for-this-run +5 percentage-point curse before accepting. Defeat the marked enemies to choose one mod draft, ordinary draft, or **35 healing + 30 ward for 10s**. Other statues explicitly offer challenge without loot. Caldera trials add warned vents; Citadel trials use three destructible protective anchors. Abandon an active trial in Pause or leave through an open rift: the curse stays, but no reward is earned. Quarry waits for completion or explicit abandonment before its required boss. The Warden's second phase adds two charging nodes: break both within six seconds for a vulnerability opening, or avoid the warned blasts.

The **Journal** remembers discovered enemies, milestones, an editable last username, and two selectable cosmetic rewards (trial skull badge / Warden ember dash). No persistent combat stats or weapon access are gated. End-of-run reports show actual damage by weapon, build, stage/time, curse/trials and the actual lethal source. New leaderboard queries separate Normal, Death and historically unknown modes and filter gameplay version **before** the top-25 limit. Older servers remain honestly labeled as a combined legacy board; local personal results remain separate.

Weapon switching cannot shorten an existing shot cooldown. Havoc uses one critical roll per blast; Ghost Rounds remains bullet-only. Gameplay uses bounded 60 Hz simulation independent of render caps. Gaps over 250ms are discarded to avoid unseen catch-up damage. Controller menus include visible focus, confirm/back and an on-screen username keyboard. Mouse/keyboard, saved bindings and touch controls remain available.

See [tuning and interaction rules](docs/BUILDS-BALANCE.md), [manual editing and reproducible scenarios](docs/MANUAL-EDITING.md), and [validation / limitations](docs/BUILDS-VALIDATION.md). Fun and balance still need human playtesting.

Five geographical stages, each rebuilt when entered:

- **Meadows:** rolling hills, shallow valleys, woodland and stone arches.
- **Shattered Quarry:** excavation shelves, steep cuts, switchbacks and mining gantries.
- **Ember Caldera:** a sunken basin, raised crater rim, radial climbs, basalt vents and lava outcrops.
- **Aurora Citadel:** stepped fortress platforms, broad avenues, towers and crenellations.
- **The Void Crown:** deep fissures, branching ridges, crystalline monoliths and suspended slabs.

Each run seeds different terrain detail and scenery. Entry plazas, connected paths and portal clearings are reserved. Players and enemies share the rendered triangle surface. Walkability and movement use each actual triangle face slope, including off-route creases; swept solid footprints prevent tunneling, validated contour sliding avoids corner snags, and navigation routes keep a small clearance from cliff boundaries. Dashes and charges use short collision steps. Enemy spawns are restricted to the connected navigation region, and enemies follow routes around obstacles and cliffs. Broadleaf and conifer trees, broken trees, shrubs, ferns, mushrooms, colonnades, stacked quarry blocks, shrines and charred trees vary the scenery; assemblies reserve wider clearances.

Five weapons, stage objectives, portals, XP collection, upgrades, a final boss, input settings, Nightmare graphics, audio and an online leaderboard. Bullets keep their world-space position and velocity, including vertical aim. Swept collisions stop rounds on terrain and structures, distinguish shooting over an enemy from hitting it, and prevent fast shots tunneling through ridges. Explosions respect height and cover.

**Tutorial** on the main menu opens the separate Rift Cloister: an open stone courtyard that guides movement, dash, aim/fire, weapon switching, five slow enemies, and rift entry. The rift opens at exactly five kills and ends the tutorial when entered. The tutorial has forgiving health regeneration, no upgrades or random spawns, and never submits a leaderboard score. Guidance uses saved controls and supports keyboard, controller and touch. Player bullets now accept a standard standing-height hitbox for short/crawling enemies; their actual world-space trajectories, terrain collision and cover still apply.

Regular enemy kills have an 18% chance to drop one temporary powerup: **Speed Boost** (30% movement for 8s), **Rapid Fire** (50% faster firing for 8s), **Insta Kill** (5s; bosses instead take 1.5× damage), **Bone Ward** (30 damage absorption for up to 10s), or **Mend** (+20 health, capped at maximum). Up to four pickups can remain on the ground, expiring after 14s. Repeat pickups refresh rather than stack; their clocks pause with gameplay. Collected effects survive a rift, but a new run clears them.

Each regular stage scatters up to four reachable skull statues away from reserved paths. Approach one and use **Interact** (default **F**, controller **X**, or the touch button), then confirm its preview. Each statue activates once and adds five percentage points to run difficulty. The HUD appears at **Statue curse: 105%**, then 110%, and so on; this is not a measurement of total difficulty. The multiplier raises enemy health, speed, damage and spawn cadence, persists across stages, and combines with Death Mode. Starting another run resets it. Interact is rebindable in Settings; older saved keybindings are preserved. The first statue in stages 1–4 is reward-bearing; see the trial rules above.

The drifting red skull selects **Death Mode** on the main menu. A subtle red screen tint and label show the selection. Esc cancels it before starting (the skull also toggles it for touch users). After username entry, difficulty is locked for that run; Esc only pauses. Death Mode multiplies enemy movement speed by 1.35 and damage by 1.5, including boss attacks, and plays an original 168 BPM score instead of the normal 140 BPM arrangement. Exclusive Revenants telegraph rapid rushes, Hexers mark delayed cross-shaped blasts, and Broodmothers release bounded crawler packs from stage 2 onward.

Enemies use distinct textured low-poly monster rigs: shamblers, low crawlers, bile spitters, horned chargers, hulking brutes, swollen mortar creatures, needle stalkers, frog-like leapers, splitting egg carriers, floating storm creatures and the crowned Warden. Movement and attack patterns differ; monster ranged attacks no longer come from human firearms.

The PS1 visual pipeline uses textured low-poly models, nearest-filtered textures, affine UV interpolation, snapped vertices, low-resolution rendering, color dithering, and a bundled pixel font. All menus and the HUD share the same retro style. Weapon buttons use generated sprite art. Nightmare replaces the former Night Mode: wind-driven rain, occasional soft lightning and thunder, dense gray-blue fog and readable moonlight. The glowing night plants and their lights are removed. Fog starts beyond the player’s camera distance, including when zoomed out. Reduced motion suppresses lightning.

Nightmare now has heavier rain, a much shorter fog falloff, a dark sky, and a strongly desaturated cold-blue grade. Nearby terrain retains detail; the fog slider and reduced-motion preference still apply. This graphics setting never changes enemy difficulty.

## Development and checks

The centered main menu keeps the title, primary actions and secret skull over a live CPU-driven run at 1.5× speed. The CPU targets enemies, changes weapons, navigates terrain and portals, chooses upgrades, and loops through stages. Demo runs never submit scores or profile progress and reset completely when the player starts. Starting or replaying a run always opens username confirmation, now prefilled from the local profile and still editable.

Settings has Graphics, Audio and Controls tabs with keyboard navigation. Graphics offers a Nightmare toggle, automatic or 160/240/320/480/720-pixel internal vertical resolution, a fog slider including Off, and 30/60/120/unlimited FPS caps. The cap limits rendering without slowing simulation. Actual FPS depends on hardware/display; explicit pixelation choices are not overridden by automatic performance fallback. Audio retains separate master/music/effects levels and mute, with Test sound for an audible check. Starting a run explicitly resumes the audio context; later player input can recover an interrupted context. The sound indicator accounts for zero volume, and toggling sound on restores a zeroed master. Controls retains key rebinding and controller help. Preferences save locally under the existing compatibility key.

The leaderboard shows Player, Score, Stage (furthest world reached), and Date (run completion, formatted in the viewer's local timezone). New Death Mode runs show the same red skull beside the player name. Mode is captured when the run ends and retained through offline save retries; historical runs without recorded mode remain unmarked. Retries use the same run ID and do not duplicate a score. The additive database migration preserves old scores and their original dates; old scores without stage data show a dash. This remains a casual client-reported leaderboard, without competitive anti-cheat verification.

Requires a recent Node.js release (Node 24 for the SQLite server tests).

```sh
npm ci
npm run build
npm test
```

Run `npm run dev` (or `node server/dev.mjs`) and open http://127.0.0.1:4173/. The preview uses the same score handler and migrations as production, with a separate persistent SQLite database at `.sites-runtime/preview.sqlite`. A static-only server can render the game but cannot save scores. Local preview scores stay local.

`dist/game.js` integrates gameplay, `dist/ballistics.js` owns 3D projectile collision, `dist/terrain.js` owns generation/collision/navigation, `dist/scenery.js` builds batched scenery, `dist/terrain-visuals.js` colors exact terrain faces and adds upper rim markings, `dist/monsters.js` owns creature rigs, `dist/graphics.js` owns graphics tuning/render pacing, `dist/soundtrack.js` owns the original music arrangements and Web Audio instruments, `dist/audio-effects.js` defines the additional cues and their cooldowns, `dist/storm.js` owns bounded storm geometry and lightning, and `dist/retro.js` / `dist/retro.css` own rendering and interface style. `build.mjs` packages public modules and binary assets into the existing Worker. The bundled Three.js assets and lockfile are preserved. See `DESIGN.md` for the cohesive art direction and interaction contracts.

`tests/terrain.mjs` checks 100 seeded stages, 3,000 spawn locations, 400 routed large-enemy journeys, all landmark/portal routes, dash collisions, geography differences and exact agreement between rendered and sampled heights. Ballistics tests cover vertical misses, slopes, narrow ridges and overhead clearance. Audio lifecycle tests cover a suspended first context, interruption/closed-context recovery and zero-volume restoration. `tests/audio-live-probe.js` is a development-only analyser probe that can be loaded before `game.js` in a temporary preview copy to verify the actual output graph; it is never shipped. Graphics tests cover storm cycles, finite geometry, reduced motion and clean disable. The smoke suite simulates combat, controls, progression, lighting, the final boss, independent bullet altitude, username entry and score submission. Server tests cover migration preservation, run dates/stages/mode, ranking, idempotency and exact binary asset serving. Music tests check the menu, Normal and Death arrangements, changing phrases and bounded voices. For Web Audio verification, temporarily copy `tests/music-browser.html` to `dist/music-check.html`, run the preview, and click Render menu + both arrangements; it checks full-song output for finite samples, audible energy and clipping. Remove the temporary copy before packaging.

Static scenery uses instancing; old terrain geometry, materials and instance buffers are disposed at each transition. No new runtime dependencies are introduced. Browser rendering and menus were inspected at desktop and phone widths; simulation and geometry checks cover all five stages. CPU generation timings and draw-call counts are reported by the terrain suite; these do not guarantee a frame rate on every device.

`tests/encounters.mjs` checks pickup odds, refresh/expiry, healing/shield limits, saved Interact migration, 60 reachable statues and portal access across 15 seeded stages. The smoke suite also covers standard-height crawler hits, the full tutorial and its no-score lifecycle, statue activation, difficulty persistence, pickup collection and boss-safe Insta Kill.

## Editing the game manually

The editable game modules live in `dist/`. They are source files despite the folder name. Look for the uppercase section comments in `game.js`; they mark where each system begins. `dist/server/index.js` is generated by `node build.mjs` — edit `server/` for server changes instead. The working checkout is `.sites-runtime/source`; this local-only handoff also synchronizes the root mirror. Avoid editing both copies at the same time. See [the expanded editing guide](docs/MANUAL-EDITING.md) for the new modules, controls and seeded practice scenarios.

| What you want to change | File and place to look |
| --- | --- |
| Weapon damage, fire rate, pellets, range | `dist/rules.js` → `WEAPONS` |
| Enemy health, speed, damage; Death Mode multipliers | `dist/rules.js` → `ENEMY_TYPES`, `DEATH_TYPES`, `RUN_MODES` |
| Enemy attacks and movement patterns | `dist/game.js` → `enemyUpdate`, `deathEnemyUpdate`, `bossUpdate` |
| Player health, speed, dash; ordinary run upgrades | `dist/game.js` → `freshPlayer`, `dash`, `UPGRADES` |
| Powerup chance, duration, colors; statue bonus | `dist/encounters.js` → constants and `POWERUPS` |
| Powerup speed/fire multipliers and boss exception | `dist/game.js` → `update`, `hurtEnemy` |
| Tutorial steps, hints, kill goal | `dist/tutorial.js`; `game.js` → `tutorialEvent` for enemy spawning |
| Key defaults and labels | `dist/preferences.js` → `DEFAULT_BINDINGS`, `ACTION_LABELS` |
| Hills, paths and movement collision | `dist/terrain.js` → `layouts`, `raw`, `generatedHeight`, `canMove` |
| Trees, buildings and tutorial courtyard | `dist/scenery.js` → `buildStageWorld` |
| Monster shapes and animations | `dist/monsters.js` → `createMonster` |
| Fog / pixelation / FPS | `dist/graphics.js`; `game.js` → `applyLighting` |
| Nightmare rain and lightning | `dist/storm.js` → `createStorm`; color grade in `dist/retro.js` |
| Synth music notes, tempo and instruments | `dist/soundtrack.js`; effects in `dist/audio-effects.js`; triggers/mixing in `game.js` → `audio`, `updateFoley`, `updateAmbient` |
| Menu/HUD text and layout | `dist/index.html`, `dist/retro.css` |
| Scores and database rules | `server/`, `db/` |

Distances are world units, durations and cooldowns are seconds, and weapon cooldown is the interval between shots (smaller means faster). Change one system at a time, preview with `node server/dev.mjs`, and run its relevant test before publishing. Keep collision and rendered geometry in agreement when changing terrain or structures.

The soundtrack takes the user’s Megabonk reference as an energy direction: driving bass, punchy drums and catchy synth hooks. The melodies and arrangements are original, with alternating 16-bar sections, breakdowns, builds, harmonic-minor turns, organ chords, bell echoes, counter-melodies and a quieter dedicated menu theme. Death Mode adds denser percussion and heavier bass. Music respects the existing volume/mute controls; background scheduling avoids bursts of stale notes. No third-party music or samples are bundled.

## Publication and assets

The existing Sites project remains `appgprj_6aa98704c68481918773213043336865` at https://riftborn.chanmanc10.chatgpt.site. Its display name is Riftborn. Public access was explicitly requested to remove the sign-in landing page; preserve that audience and the existing URL. Custom-domain registration was deferred by the user.

`dist/assets/ps1-atlas.png` was generated from the prompt for a seamless 4×4 PS1 material atlas: skin, cloth, leather, steel, grass, masonry, rust, bark, basalt, lava, castle stone, purple rock, face, bone, foliage and UI metal. `dist/assets/weapons.png` was generated as a transparent horizontal sheet of five PS1-style side-view weapons: assault rifle, compact SMG, double-barrel shotgun, railgun and rocket launcher. Both are original assets. `crypt-pixel.ttf` is an original 5×7 pixel font.

`dist/assets/death-skull.png` is an original generated transparent sprite: one front-facing crimson PS1 skull with angular planes, hollow eye sockets, visible teeth, a stepped pixel silhouette and no glow or text. The menu freezes its motion on hover/focus and honors reduced-motion preferences.
