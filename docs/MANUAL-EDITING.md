# Editing and testing Builds & Bargains

`dist/` contains editable browser source, despite its name. The working Git checkout for this session is `.sites-runtime/source`; the project-root mirror is synchronized at handoff. Edit one copy at a time. Generated `dist/server/index.js` is built from `server/worker.js` and the public asset whitelist in `build.mjs`; never edit the generated Worker directly.

## Launch and check

From the checkout containing `package.json`:

```sh
npm ci
npm run dev
npm test
```

Open `http://127.0.0.1:4173/`. If npm is unavailable but dependencies exist, preview with `node server/dev.mjs`, build with `node build.mjs`, and run the exact package suite with:

```sh
node -e "const {execSync}=require('node:child_process');execSync(require('./package.json').scripts.test,{stdio:'inherit'})"
```

The preview migrates its own `.sites-runtime/preview.sqlite`. It does not read or write the production leaderboard. A static file server cannot save scores. No dependency changes were needed for this update.

## Where to edit

| Change | Source |
| --- | --- |
| Base weapons, monsters and Death multipliers | `dist/rules.js` |
| Ordinary upgrades / shared combat previews | `dist/upgrades.js`; `dist/game.js`: `freshPlayer` |
| Major-mod / dash tuning and descriptions | `dist/progression.js`: `BALANCE`, `MODS`, `DASH_TRAITS` |
| Secondary hits, chains, scars, pulls | `dist/combat-effects.js` |
| Echo lifetime / Wake route tracking | `dist/dash-traits.js` |
| Reward queue / exhausted draft pool | `dist/progression.js`; `game.js`: `showReward` |
| Trial roster/state/placement validation | `dist/trials.js`; `game.js`: `beginTrial`, `clearTrialObjects` |
| Iron Maw, vents, anchors and nodes | `dist/challenges.js`: `CHALLENGE`; `game.js`: encounter section |
| Fixed-step overload policy / menu repeat | `dist/simulation.js` |
| Last username, bestiary, milestones, cosmetics | `dist/profile.js`; `game.js`: profile section |
| Actual damage totals, death cause and reports | `game.js`: `hurtEnemy`, `hurtPlayer`, `captureSummary` |
| Menus, input help and narrow layout | `dist/index.html`, `dist/retro.css`; `game.js`: input dispatch / `pollPad` |
| Leaderboard queries and new metadata | `server/worker.js`, `db/schema.ts`, additive migration `drizzle/0003_builds_bargains.sql` |

Tune numbers with their labels together. Durations are seconds and distances are world units. Major effects use sourceWeapon/shotId/generation and enter shared damage resolution; avoid direct enemy-health mutation in new attacks. Kill processing is once-only and summaries count actual HP removed. Keep secondary generation bounded. Never turn cleanup into trial victory.

For future schema edits, update `db/schema.ts`, generate a new migration (`npm run db:generate`), and test preservation of old rows. Do not rewrite historical migrations or remove production data.

## Reproducible local practice

Use `http://127.0.0.1:4173/?scenario=campaign&seed=7361`. These controls activate only on `localhost` or `127.0.0.1`. The entire page, including retries, suppresses score submissions and profile saves. Practice has invulnerability so inspection can pause between actions; it is not a normal balance run. The developer panel shows measured rendered frames per second and effect counts.

| `scenario` | Starting point |
| --- | --- |
| `campaign` | Meadows, normal progression |
| `mods` | All five mods, extra projectiles, piercing and stronger/faster shots |
| `rewards` | Queued major → ordinary → dash choices |
| `quarry` | Iron Maw encounter |
| `caldera` | Active vent trial |
| `citadel` | Active three-anchor trial |
| `warden` | Final boss |

Change the seed to compare terrain. **Reset scenario** also applies the panel's Death Mode checkbox. Normal graphics / Nightmare remain independent Settings preferences. **Resolve objective** deliberately applies test damage to progress the encounter; its kills are not evidence of weapon balance. **Break anchors / nodes**, **Warden phase 2**, **Start trial**, and **Enter open rift** exercise the intended gates. **Preview cosmetics** unlocks/equips only the temporary practice profile. To test a real local run and persistence, use the plain URL; those scores stay in the local database.

## Controls

Defaults remain movement WASD, mouse aim and held left-click fire, Space dash, 1–5 weapons, Q/E or right-drag camera rotation, wheel zoom, F interact and P/Esc pause. See Settings for saved/rebound values. Controller uses left/right sticks to move/aim, right trigger fire, A dash, bumpers weapons, X interact and Menu pause. In menus use D-pad/stick, A confirm and B back; A cycles settings values and opens the username keyboard. Touch controls share the existing movement/aim sticks, fire/dash/interact buttons and menu actions.

Useful focused checks: `node tests/builds.mjs`, `node tests/mods.mjs`, `node tests/campaign.mjs`, `node tests/inputs.mjs`, `node tests/stress.mjs`, and `node tests/server.mjs` (build first for packaged-asset assertions). Run the complete `npm test` before publishing. Publishing must update the existing Sites project and preserve its public audience/URL. The prior Builds & Bargains local-only handoff was later published as version 15.

## Refinement editing map

- `warnings.js`: terrain-conforming ring/corridor geometry and charge prediction. `game.js`: `warnLine`, `warnLanding`, hazard/vent lifecycle. Dispose owned geometries through `disposeMarker`; never resize the damage boundary as a pulse animation.
- `combat-feedback.js`: five weapon feel profiles and one bounded build notification. `CombatEffects.api.event` / `DashEffects.api.event` report actual events. Secondary/projectile adapters return a created shot or falsey; do not announce a successful volley from a failed allocation.
- `occlusion.js`: aperture size, floor/depth guards, restoration rate and PS1 checker mask. `retroMaterial(...,{occlusion:true})` opts scenery in. Collision and navigation never read these shader uniforms.
- `upgrades.js`: `shotStats`, `applyUpgrade`, `upgradePreview`. Combat and card values share this path. The preview clones the player; it must never apply the offered upgrade prematurely.
- `soundtrack.js`: `MusicIntensity`, encounter additions in `scoreEvents`, source limits, stop/disconnect. `game.js` audio coordinator owns music bus easing, gesture recovery and hidden-tab scheduling.
- `run-history.js`: compatible previous-run/best comparisons. `profile.js` retains bests independently of the recent-50 list.
- `score-outbox.js`: immutable local queue, atomic IndexedDB transaction adapter, expiring leases, backoff, retained rejection/fallback states. Never replace an existing ID's payload on retry. `game.js` owns HTTP timeout and visible save status.

Practice adds **Camera obstruction**, **Toggle zoom** and **Disable/Enable cutaway** for A/B inspection. Its player stays visible despite practice invulnerability. Metrics show rolling cutaway CPU cost, renderer submission CPU time and total composer draw calls; none is GPU execution time. The three new controls are loopback-only. The regular camera uses Q/E/right-drag and wheel zoom.

New checks: `node tests/refinement.mjs`, `node tests/occlusion.mjs`, `node tests/outbox.mjs`, `node tests/polish-pacing.mjs`. The pacing script records actual HP removed by `hurtPlayer` separately from healing and writes ignored `.sites-runtime/refinement-pacing.json`. Terrain seeds are fixed, but random reward offers and visual RNG can still vary outcomes; do not present a single sample as a deterministic balance result.

For browser storage/audio checking, copy `tests/refinement-browser.html` to `dist/qa-refinement.html` temporarily and visit the loopback page. It uses a separate QA IndexedDB database and stubbed network sender, never `/api/scores`. Its reload button verifies durable recovery; an offline audio graph checks nonzero output and source cleanup. The probe is excluded from the public asset whitelist; remove the temporary copy after use.
