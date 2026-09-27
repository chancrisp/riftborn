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
| Ordinary upgrade choices and player base stats | `dist/game.js`: `UPGRADES`, `freshPlayer` |
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

Useful focused checks: `node tests/builds.mjs`, `node tests/mods.mjs`, `node tests/campaign.mjs`, `node tests/inputs.mjs`, `node tests/stress.mjs`, and `node tests/server.mjs` (build first for packaged-asset assertions). Run the complete `npm test` before publishing. This handoff deliberately does not publish.
