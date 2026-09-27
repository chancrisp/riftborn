# Builds & Bargains balance and editing notes

This update keeps manual fire, all five starting weapons, nine ordinary upgrades, baseline dash physics and the five world quotas. Tuning lives in `dist/progression.js` (BALANCE), `dist/rules.js` (base weapons/enemies), `dist/encounters.js` (pickups/curse), and the encounter coordinator in `dist/game.js`.

## Combat rules

Weapon switching never changes the outstanding recovery from the last shot. Recovery uses the firing weapon's cooldown, Overclock, and Rapid Fire at fire time. Havoc rolls one critical per explosion, shared by every affected target. Ghost Rounds affects bullets, including splinters and bone fragments; it does not extend explosions, chains or scars. The global ordinary upgrade pool remains unchanged.

Every projectile records sourceWeapon, shotId, generation and a shared trigger-pull group. Secondary effects cannot generate additional mod effects. Forked Chamber adds ordinary primary projectiles; Storm Needle charges only once per original trigger pull and Graveburst can emit only one cone per original volley. Rifle primaries each split at most once. Lancer rays share the bounded scar pool and one per-target cooldown across ALL traces, preventing overlapping scars from multiplying tick rate. Heavy Rounds scales the initiating damage; secondary fractions derive from that value. Deadeye applies to bullet impacts and Havoc explosions; chains and scars use their stated base fractions without another critical roll. Overclock/Rapid Fire change fire cadence, not effect lifetime. Insta Kill keeps its ordinary-enemy rule; bosses, minibosses and marked trial elites instead receive 1.5× damage. Environmental vent damage does not inherit player powerups.

Defaults: Splinter 2×35% rounds, Storm 7 connected pulls → at most 3 targets within 7m at 70%, Graveburst 5×60% fragments after a kill within 8m, Scar 1.4s at 18% every 0.3s per target (12 traces maximum), Horizon 0.45s pull within 5m at 7m/s (8 pending maximum). Storm charge persists through switching and resets per run. Secondary bullets still collide with terrain/cover. Pulls use terrain movement; bosses and fixed encounter objects resist.

## Time and capacity

The simulation uses 60 Hz fixed steps. Render limits do not set game speed. Cadences down to 10 Hz are tested in simulation; this is not a hardware FPS guarantee. A frame gap over 250ms discards the entire gap and any remaining debt. Pauses/hidden tabs clear debt; no lethal catch-up on return. At most 15 steps are processed per frame. Primary and secondary projectiles share a 320-live-shot safety cap. Particles retain the existing cap. Long stalls therefore lose game time intentionally rather than processing unseen combat.

## Rewards and trials

Stable event IDs deduplicate the queued drafts. Each reward freezes combat and clears held input. The Quarry major draft is mandatory before leaving. Major offers include up to three distinct unowned mods, with an ordinary draft when all five are owned. Each weapon keeps its own mod until the run ends.

Each first-four-stage world designates its first skull statue as a rewarded trial; other statues explicitly grant no loot. Four validated reachable spawn sites are required before consuming it. Activation adds a persistent +5 percentage points to statue curse and proportionally rescales living health. Only the designated hunt and registered descendants count. Completion offers one mod draft, ordinary draft, or heal35 + ward30/10s. When mods are exhausted, the draft is labeled “All mods owned · ordinary upgrade” alongside the defensive option, with no duplicate ordinary choices. Pause offers explicit abandonment. Abandonment/portal cleanup removes owned monsters, shots, hazards and objects, preserves the curse and awards no victory. No Rift Overcharge or statue score multiplier is added.

## Dash and encounter tuning

Meadows awards one mutually exclusive dash trait. Echo lasts 2s and repeats the complete next manually fired volley at 50% damage toward the same world-space target, from a validated original position; echoed shots cannot trigger major mods. Wake lasts 2s, slows eligible ordinary enemies to 60% movement and has at most 24 route segments. Neither trait changes baseline dash cooldown/invulnerability. Switching preserves an unused Echo; stage cleanup/death/restart clears both effects. Bosses/fixed objects resist Wake.

`dist/challenges.js` centralizes encounter values. Iron Maw has 680 base HP, a 1.05s warning, 0.85s charge at 20 units/s, and 2s of 1.5× incoming damage after an attack charge hits solid cover. Navigation bumps do not trigger it. Its health scales with statue curse; Death Mode and curse scale movement/damage. While active, spawning is limited to eight enemies and a four-second base cadence; normal surge packs are suppressed. The active optional trial must complete or be explicitly abandoned before Iron Maw begins. Its victory owns the one stable Quarry major reward.

Caldera has three trial vents: 1.5s warning, 1.4s active, 2s recovery; active pulses every 0.5s do 26 base damage in radius 2.2 with the same height/cover checks for enemies and player. Warnings and safe spaces remain within the existing terrain. Citadel has three 120-HP anchors: the elite initially receives 40% damage, then 60%, 80%, and 100% as anchors fall. All weapons can destroy encounter objects; these objects grant no kills/XP/drops.

Warden nodes begin only in phase two, outside an incompatible pending ground attack. Two 110-HP nodes charge for 6s. Destroying both gives 2.5s of 1.5× incoming damage; otherwise three radius-2.6 ground blasts warn for 1.5s before 42 base damage. The Warden stays damageable, ordinary attacks are held during the node charge, and the subsequent attack cooldown is 3s. Node events have a 15s cooldown and at most three occurrences. Killing the Warden cancels the event and wins once.

## Profile and ranking contracts

`riftborn-profile-v1` stores last username, discovered/defeated types, three milestones, two cosmetic selections and up to 50 recent personal runs plus per-mode/version score bests. Best scores persist after old detailed records age out. Comparisons skip unknown mode/version; stage deltas require known stages and time improvements compare only consecutive compatible victories. Trial completion unlocks the skull badge; Warden victory unlocks ember dash effects. Equip is explicit in Journal. Storage failure leaves play functional, with session-only progress clearly indicated. Tutorial, attract-demo, test and developer practice are ineligible for real progress.

Score metadata is additive and nullable: statue count/modifier, outcome and gameplay version `builds-1`. Historical unknowns stay unknown. The server applies mode/version predicates before ordering/limiting 25 results. Unsupported servers are labeled as legacy combined rankings; client-side splitting of a combined top 25 is never presented as a full mode ranking. This remains a client-reported, unverified leaderboard. Pending uploads now live in a separate IndexedDB outbox. Each immutable payload retains its original ID; atomic 30s claims coordinate tabs, requests time out after 8s, and retries back off from 2s to 5 minutes (checked every 15s while visible, and on reconnect). At most eight attempts are processed per flush. Rejected 4xx payloads remain visibly failed for explicit retry, while 408/429/5xx/network failures retry. No unconfirmed record is evicted. When durable storage fails, fallback entries stay in memory and the UI warns to keep the tab open. Server IDs remain idempotent after crash-after-acceptance retries; exactly-once network delivery is not claimed. No anti-cheat or server authority is claimed.

## Verification status

See `docs/BUILDS-VALIDATION.md` for exact checks and limitations and `docs/MANUAL-EDITING.md` for local scenarios. Balance and enjoyment still require human playtesting.

## Refinement tuning log — 27 September

| Rule | Before | After / reason |
| --- | --- | --- |
| Charger / Revenant / Iron Maw marker | Fixed 12 / 9 / 18 units, 0.22 width | Terrain-sampled swept corridor from actual speed/duration, mode/curse scaling and body radius; cover-aware Maw stop. Fixed markers understated Death/cursed travel. No attack speed/damage change. |
| Ground marker | Pulsed between 80–100% radius | Stable full-radius outer outline; opacity indicates countdown. No blast radius change. |
| Spitter / Stormer anticipation | Immediate ready attack; early visual cue could be skipped on range entry | Preview during final 0.35s of existing cooldown, with at least 0.25s visible anticipation on first eligibility. Regular in-range firing cadence unchanged. |
| Leaper landing | 0.2s final marker | 0.35s, plus predicted landing ring during windup/flight. Gives a readable response window at higher movement scales. |
| Vent onset | Residual pulse clock leaked between phases (observed 0, ~0.133, ~0.283s delays) | Reset to immediate first pulse on every active phase. Warning/active/recovery durations, 0.5s pulse spacing and damage unchanged. |
| Sniper | Horizontal direction committed; vertical pitch recomputed on fire | Full 3D direction committed with the warning; cover clips its projected trace. |
| Warden nodes | Reachable separated sites could be behind a ridge | Up to 14 candidates; both must have a current terrain/cover sightline and be within 30m. Retry placement after 2s if no pair; normal attacks continue and no event is consumed. Six-second deadline unchanged. |

Retained: Iron Maw 680HP, 1.05s warning / 0.85s charge / 2s stagger, 1.5× vulnerability, eight-enemy/four-second supporting spawn budget; Caldera 1.5/1.4/2s cycle and 26 base damage; anchors 120HP and 40/60/80/100% elite damage; Warden nodes 110HP, six-second deadline and 2.5s opening. Added anchor tethers and preserved protection text instead of changing HP. Stage quotas, early progression, trial rewards, all upgrades/mod damage, powerups and mode/curse multipliers remain unchanged.

Evidence: regression sweeps cover Normal/Death charge paths at 0/10/50/100 curse, three terrain seeds, all world families, a reproduced ridge-blocked node pair, and consistent vent phase starts. The pacing probe samples 24 assisted 20s encounters across three seeds, both modes and 50-point curse, with stacked representative mods/upgrades; the existing stress suite covers heavier all-mod builds in 15 worlds. These bots use scripted aim/routes, inflated HP and automatic draft choice; several trials do not finish in 20s. Their outcomes support bounds/cleanup checks, not a human-fairness judgment. No broad numerical buffs/nerfs are justified from them. See the new validation note for measurements and playtesting gaps.

## Campaign-2 tuning log

- Movement response uses exponential acceleration 18/s, reversal 24/s and braking 28/s. Top speed and dash duration are unchanged. The terrain solver now validates exact face slopes, swept solids and contour sliding; navigation has a narrow cliff-edge margin. The reserved portal floor stays flat inside 5 units, with its shoulder blended out to 10 units (previously 8).
- Stick/touch pitch assistance ignores targets beyond the equipped range or behind cover; bullet trajectories still do not home or follow terrain. Short enemies retain standard hitboxes.
- A 0.4s ordinary spawn grace now prevents both movement and attacks during arrival. Live hostile cap 55 covers ambient spawns, surges and descendants; a trial needs enough capacity before accepting its curse, plus four separated placements at least 6 units from the player. Failure preserves the statue.
- Ambient spawn recovery: stage/opening 3s, landmark 4s, completed trial 6s, defeated Maw 7s. Outside an active trial/Maw encounter, each 32s cycle has a final 6s without new spawns. These are spawn rests, not invulnerability; surviving enemies still attack.
- Drafts include one offense and one survival/movement option, plus a unique third; Deadeye is excluded at 90%. Mod/dash previews derive base damage and limits from BALANCE/shotStats. Weapon damage/range/cadence and all nine upgrade magnitudes are retained; the assisted runs do not justify broad numerical nerfs.
- Landmark recovery is once per stage: heal up to 12; no curse, stat or score bonus. Journal rewards are cosmetic only. Five mastery goals require 75 credited kills each; one completed weapon or all five discoveries unlocks Aurora. Clean Maw awards Iron; victory with at least three statues awards Crown.
- Explicit sequences: opening 2.8s, stage 1.5s, Maw 2.4s, Warden 3s, phase 1.8s, aftermath 4.5s. All are skippable; clocks/combat freeze. Boss entries clear ambient enemies and attacks; one second of control-return protection prevents surprise contact. Death Mode multipliers remain unchanged.

New scoring balance version `campaign-2` keeps earlier `builds-1` results out of the default current-version ranking. No scores or database records were erased.
