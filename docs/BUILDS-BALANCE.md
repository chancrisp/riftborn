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

`riftborn-profile-v1` stores last username, discovered/defeated types, three milestones, two cosmetic selections and up to 50 recent personal runs. Trial completion unlocks the skull badge; Warden victory unlocks ember dash effects. Equip is explicit in Journal. Storage failure leaves play functional, with session-only progress clearly indicated. Tutorial, attract-demo, test and developer practice are ineligible for real progress.

Score metadata is additive and nullable: statue count/modifier, outcome and gameplay version `builds-1`. Historical unknowns stay unknown. The server applies mode/version predicates before ordering/limiting 25 results. Unsupported servers are labeled as legacy combined rankings; client-side splitting of a combined top 25 is never presented as a full mode ranking. This remains a client-reported, unverified leaderboard. Pending upload retries remain session-local; refreshing after a failed upload can lose the retry, although an eligible local personal result is retained when storage works. No anti-cheat or server authority is claimed.

## Verification status

See `docs/BUILDS-VALIDATION.md` for exact checks and limitations and `docs/MANUAL-EDITING.md` for local scenarios. Balance and enjoyment still require human playtesting.
