# Riftborn design

Riftborn is a PS1-era survival shooter across five fractured landscapes. The user approved the name and a cohesive period look for every screen, based on low-poly textured character models in the supplied fern video. The main menu is centered over a real CPU run at 1.5× speed; it contains a title, Start Run, Tutorial, Settings and Leaderboard. Control reference stays in Settings; guided instruction appears inside the tutorial world.

## Visual system

Player status follows the character in screen space: two 13px white diamond dash charges sit below the feet and fill as each charge recharges; a compact numbered health bar sits above the head and moves from green through yellow and orange to red. A saved Graphics slider controls both cues' opacity from 0 to 100%. These cues use the existing pixel type and solid console colors, stay outside pointer input, and disappear with the gameplay HUD.

`dist/retro.css` owns interface tokens and overrides the legacy layout styles. Ink `#15151e`, cream `#ded6be`, muted olive `#b8c49a`, aged gold `#d4bc78`, and gray `#9c9a8b` form the UI palette. Use the bundled Crypt pixel font for headings, labels, buttons, and data, with Courier New as fallback. Hard beveled borders, square corners, solid fills, and offset pixel shadows are deliberate. No blur, bloom, glass, rounded cards, modern gradients, or smooth UI transitions.

`dist/retro.js` owns the 3D material pipeline: low-poly silhouettes, nearest-filtered atlas textures, affine texture interpolation, snapped vertices, and 5-bit color dithering. Render at 320 vertical pixels (240 on touch/performance fallback), scaling the canvas with nearest-neighbor interpolation. The player retains a low-poly human rig; enemies are zombies and monsters with hunched bodies, claws, jaws, horns, swollen sacs, crawling legs or floating tendrils. Their silhouettes and attacks identify their roles. Palette and textures distinguish terrain and enemy types. Fog is atmosphere, not a substitute for legible nearby terrain: its near plane sits beyond the normal gameplay camera distance in both Normal and Nightmare graphics.

Weapon selection uses five raster sprites matching the weapon shapes. Keyboard shortcut numbers are functional labels. Menus and dialogs stay centered and fit narrow screens; form and Settings content scroll internally when necessary.

## Interaction ownership

`openPanel` / `closePanel` own settings, leaderboard, Journal and new-run dialogs, focus restoration, inert backgrounds, and input clearing. The keyboard handler traps dialog focus and Escape closes the active panel. Every run requires a confirmed nonblank username; the local profile now pre-fills the last name, which remains editable. Controller users can enter characters on the on-screen keyboard. Each score captures that run's username, furthest stage and completion timestamp. Old scores without stage data show a dash rather than infer progress from elapsed-time waves. Dates display in the viewer's local timezone. The leaderboard keeps Player, Score, Stage and Date columns, with mode/version filters, loading, empty, failure and refresh states. Curse/outcome/version metadata appears compactly beneath the name. Scores retain idempotent run IDs for retries. A 24px copy of the existing red skull sits immediately after recorded Death Mode usernames, with accessible text “Death Mode.” Normal and historically unknown runs remain unmarked. Mode/version filtering must occur on the server before LIMIT; unsupported servers show a labeled legacy combined board.

`retro.css` owns global scrollbar and focus styling. The game toast owns gameplay notices; inline live regions own form validation and score saving feedback. Desktop, touch, and controller input continue to share the existing action bindings. Reduced motion disables camera shake and freezes the secret skull. The skull floats around the outer menu, stops on hover/focus, and toggles Death Mode with a subtle red tint. Esc cancels only before starting; run difficulty is immutable.


## Settings surface

Operate mode: change one preference and return to the run. Graphics, Audio and Controls use three equal console tabs, with one visible panel, persistent Done action, aligned labels/values, and internal scrolling for bindings. Arrow keys, Home and End switch tabs; hidden panels do not participate in dialog focus trapping. Existing controls and audio settings remain accessible.

Graphics uses a Nightmare checkbox, a pixelation selector, a single fog slider, and a frame-rate selector. Changes apply immediately and save locally. Automatic resolution can reduce under sustained slow frames; explicit choices stay fixed. FPS is a rendering cap, independent of simulation. Inputs use square native controls, the existing pixel font, cream/olive/gold colors and beveled console borders. Small screens retain two columns for labels and controls; longer labels wrap.

The Impeccable scoped distill workflow informed this surface. Its detector flagged inherited small HUD text and legacy styles outside Settings; Settings labels/controls use 12–16px minimums and were inspected at desktop and 390px width. No new visual world replaces the approved PS1 style. Nightmare adds rain, thick distance fog, soft infrequent lightning and darker moonlight without luminous plants. Nearby geometry stays readable as the camera zooms. Nightmare affects visuals only; Death Mode owns difficulty. Audio settings include Test sound and concise status feedback, and the HUD correctly reports a zero-volume state as Sound Off.

## Tutorial and optional run modifiers

The Rift Cloister is a distinct open stone courtyard. Its centered, beveled guide shows one step at a time: movement, dash, firing, weapon switching, five easy kills, and the exit rift. Enemy spawns wait until weapon switching is learned. Guidance reflects saved keybindings and current input device. Entering the rift ends the tutorial; it never writes a score or changes the regular run state.

Optional skull statues reuse the red skull sprite above stone plinths. A proximity prompt names Interact; a preview states the +5 percentage-point curse, encounter and reward before activation. One statue in each of stages 1–4 is a rewarded trial; other statues clearly promise no loot. The curse readout remains hidden until the first use, then starts at 105% and persists through stages. Gold ground markers identify the trial roster. Caldera vents and Citadel anchors use distinct low-poly shapes and advance warnings; regular lava scenery stays harmless. Powerups are small, colored low-poly pickups with brief names on collection and countdowns in the HUD. Durations refresh without stacking; boss/elite-safe Insta Kill and bounded drop counts preserve pressure.

## Builds & Bargains interaction contract

One reward modal owns focus at a time; FIFO events have stable once-only IDs. Primary buttons show the weapon sprite, mod name and effect. Offers exclude owned mods and exhausted pools fall back to ordinary upgrades. The guaranteed Quarry draft and stage-one dash choice resolve before leaving. Combat and temporary effects freeze during choices. Pause shows a scrollable build reference and an explicit active-trial abandonment action; leaving keeps the curse and forfeits unearned loot.

Gamepad D-pad/stick navigates menus with delayed repeat, A confirms, B backs out, and A cycles native settings controls. Opening presses cannot immediately confirm the next screen. Touch shares the same buttons. Journal cosmetics are visual only: the trial badge appears in the header, and the Warden ember selection recolors dash particles, Wake and Echo. Discovery and unlocks exclude tutorial, attract-demo, automated and loopback practice sessions.

Run reports use a collapsible, internally scrolling detail area so retry remains reachable on narrow screens. Developer practice controls appear only on loopback URLs with an explicit scenario parameter; they are never part of the public menu. They label score isolation and are for reproducible inspections, not evidence of balance.

Nightmare uses a pronounced desaturated blue grade, heavier diagonal rain and a shorter distant fog falloff. Ground detail and the player's silhouette remain visible. It adds no luminous flora, modern glow effects, or difficulty changes. The added HUD elements keep square borders, the existing pixel font and restrained spacing.

## Refinement presentation contracts

Danger owns the highest in-world effect priority. Ground warnings conform to sampled terrain and keep a fixed outer boundary; opacity advances instead of shrinking the danger area. Aimed blasts use crosshairs, projectile emitters use spokes, slams use double rings, and charges use outlined corridors with direction marks. Thin sniper traces follow the committed 3D shot. Markers ignore fog and depth occlusion deliberately, so a threat remains readable behind scenery or rain; they are indicators rather than new collision surfaces. Recovery dims vents to wire outlines. Warning families have short original tones, rate-limited across dense encounters.

`warnings.js` owns disposable marker geometry. Charge prediction uses the same movement solver and mode/curse speeds, with Iron Maw's special cover stop. A slowed charge can travel less than the conservative full-speed corridor. Landing predictions refresh at 10 Hz and finish with an exact-radius warning. A killed/cancelled windup removes its owned marker; already committed projectiles and delayed ground blasts retain their existing independent lifetime unless their trial/stage is cleared.

`occlusion.js` supplies one shared, smoothly restored dither aperture to scenery and foreground ridges through the existing retro shader. Only pixels ahead of the player's chest and above their floor enter the aperture; the floor beneath the player, enemies and weapons are untouched. Three projections update the uniforms; no per-instance traversal, cloning or collision mutation. Distant zoom keeps a compact silhouette window rather than making the whole map transparent.

Ordinary cards keep the existing square PS1 buttons and add one gold comparison line. Values are for the currently selected weapon and active Rapid Fire, with explicit Havoc/Ghost applicability and capped critical chance. No estimated DPS. Focus and touch targets remain the existing cards. Run reports retain internal scrolling; expanding a report temporarily hides the floating skull so it cannot obscure text. Close it to reveal Death Mode access again.

`combat-feedback.js` owns one short, noninteractive build cue, rate-limited per event family. Combat/Dash adapters emit only after actual effects are created. Consuming an Echo clears READY even if a blocked/capped volley creates no shot. Visual hit compression does not alter movement, collision, damage or AI timers. Reduced motion lowers player recoil, removes muzzle light flashes and keeps the existing shake/lightning suppression.

Music intensity latches on 16-step bar boundaries without resetting the transport. Quiet reward/pause gain eases immediately, while quiet instrumentation arrives at the next boundary. Trial/boss layers retain the two original arrangements. A 96-source music limit and 32-tone SFX limit bound audio work; ended nodes disconnect. Hidden/muted/inactive contexts stop scheduled music, and recovery begins at current audio time, never replaying a backlog.

## Campaign presentation and return goals

Short in-world sequences use solid letterboxing, the existing cream/gold pixel type and one centered caption/action. They freeze combat, clear imminent attacks, support explicit pause/skip and respect reduced motion. Warden phase material copies retain the custom PS1 shader; phase materials live until the aftermath ends. Rift Echo clones retain the same material callbacks. No new cinematic rendering framework is used.

Two-option discovery and dash drafts center their cards; narrow screens stack and scroll them. Numeric build detail replaces repeated static explanation. Journal challenges use plain progress rows, one Track action each, and cosmetic choices with visible disabled/selected states. Tracking/equipping restores focus after updating the rows. The phone layout was checked at 390×844. Functional HUD/table labels are at least 11px in the adjusted rules.

Landmarks are part of the world's stone/wood/metal vocabulary and safe navigation/collision model. Optional lore appears only on interaction and can be left immediately. One recovery per stage is distinct from permanent Journal discovery. The Journal explicitly labels browser-local storage; practice cannot earn progress.


Elevation cues follow collision truth: walkable ground is lighter, steep faces use darker vertically textured stone, and upper boundaries carry thin upward-facing lips. Authored ramp colors are stronger without adding obstacles or changing heights. Ultra fine keeps the same PS1 textures, snapping and palette at a clearer 720-pixel internal height.

The menu has a restrained original synth/organ theme after browser audio unlock. Normal/Death scores extend to alternating 32-bar forms. Steps, monster voices, impacts and environmental cues are sparse, distance-aware and rate-limited; warning tones retain voice headroom. No external recordings or licensed music are bundled.
