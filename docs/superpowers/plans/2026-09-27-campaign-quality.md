# Campaign quality update

User-approved scope: implement all seven campaign-quality directions in the conversation, fix discovered defects, and publish to the existing public Riftborn Site. Baseline: v16, `1fd67d65ce3b800989c48e5c6a96d5df3106dbce`. Source checkout is authoritative; preserve and verify the root mirror before synchronization.

## Design and constraints

Keep the five weapons/worlds, manual fire, PS1 materials/fonts, Normal/Death and graphics-only Nightmare. Extend existing systems; no alternate weapon-mod system, new modes, permanent combat stats, accounts or cloud profiles. Preserve database and historical scores. Version gameplay-affecting changes separately as `campaign-2` so comparisons remain honest.

1. Short, skippable Iron Maw/Warden entrances; Warden phase transition and death/aftermath. Dedicated sequence state freezes gameplay/timers, clears imminent dangers, respects reduced motion, hides on restart, and confirms victory exactly once. Accessible skip/continue works with keyboard/controller/touch. Brief opening and stage transition captions; helpful existing-bestiary death advice.
2. Investigate movement/aiming failures, add meaningful regression cases, tune acceleration/braking without altering dash collision or projectile cover. Retain weapon identities and cooldowns; make elevation assistance target actual standard hitboxes.
3. Explicit short ambient-spawn recovery after stage entry/trial/boss victories, bounded surge/summon populations and harmless ordinary enemy arrival. Existing attackers remain active outside sequences. Preserve encounter identities and difficulty multipliers.
4. Exclude capped no-op upgrades; improve contextual mod/dash descriptions using existing formulas. Keep all useful global upgrades available to every weapon.
5. One authored discoverable landmark in each current world, safely placed away from required clearings with readable interaction, short optional lore and one small per-stage recovery reward. Add bounded stage ambient synthesized sounds honoring effects/mute/hidden/pause controls.
6. Backward-compatible Journal weapon mastery, explicit challenges/discoveries, trackable goal and cosmetic-only rewards. Real-run eligibility required; tutorial/demo/practice/test isolation preserved. Persist at real milestones and explain browser-local storage.
7. Complete-run simulations plus browser checks of Normal/Death, sequences, rewards, Journal, landmarks and responsive/reduced-motion paths. Distinguish scripted assists from actual manual play and do not fabricate device or subjective audio validation.

## Work and ownership

- [x] Core integration: root agent owns game.js, index.html, style.css, build list, harness, pacing/sequence/aim helpers and campaign tests.
- [x] Mastery: bounded agent owns profile.js, mastery.js and mastery tests; returns integration API. No game/UI edits.
- [x] Landmarks: bounded agent owns landmarks.js and landmark tests; returns placement/render/disposal API. No game/UI edits.
- [x] Integrate, verify complete campaigns and focused regressions, inspect local UI; fix findings.
- [x] Update README/design/balance/editing/validation notes, independent review, verified build and root mirror; prepare existing-Site publication.

## Validation contract

Tests must cover sequence skip/finish exactly once, pause/visibility/restart, safe population limits, spawn warning before contact damage, capped drafts, persistent mastery migration/eligibility/deduplication, reachable discoveries/rewards once, collision/cover/elevation, normal versus Death campaign progression, and existing score/audio regressions. No production test scores. Record exact commands and limits in the final validation note.

## Decisions / ledger

- Existing source checkout was clean and reopened through Sites before edits. Public v16 confirmed.
- User explicitly authorized full implementation after the in-chat design; proceed without repeated design approvals. Parallel module work uses separate files; root owns all integration and publication.
- Initial confirmed code findings: Deadeye can be drafted after cap; surge packs bypass the ambient population limit. Ordinary spawn animation is not currently a gameplay grace period; add a regression before changing it.

## Added user steering before publication

- Diagnose and fix additional terrain traps beyond the reserved-route tests; improve elevation readability with contrasting rock faces, upper ledge lips and clearer ramps. Terrain movement remains aligned with rendered triangles and bullet cover.
- Add Ultra fine pixelation at 720 internal vertical pixels, above Fine (480), preserving explicit selection and saved preferences.
- Expand original music and SFX; add a quieter menu arrangement after the first user audio-unlock gesture. Keep CPU demo combat SFX silent, volume/mute/hidden behavior and voice limits intact.
- Additional separated ownership: terrain agent edits terrain.js/traversal tests, music agent edits soundtrack.js/music tests, SFX definitions agent edits audio-effects.js/tests; root integrates triggers, visual mesh and settings.

Final local verification: build + all31 test programs pass; five assisted full campaigns reach victory. Independent review and browser audio/visual checks recorded in CAMPAIGN-QUALITY-VALIDATION.md. Publishing uses the existing Site and unchanged public audience.
