# Riftborn design

Riftborn is a PS1-era survival shooter across five fractured landscapes. The user approved the name and a cohesive period look for every screen, based on low-poly textured character models in the supplied fern video. The main menu is centered over a real CPU run at 1.5× speed; it contains a title and three actions, with controls confined to Settings.

## Visual system

`dist/retro.css` owns interface tokens and overrides the legacy layout styles. Ink `#15151e`, cream `#ded6be`, muted olive `#b8c49a`, aged gold `#d4bc78`, and gray `#9c9a8b` form the UI palette. Use the bundled Crypt pixel font for headings, labels, buttons, and data, with Courier New as fallback. Hard beveled borders, square corners, solid fills, and offset pixel shadows are deliberate. No blur, bloom, glass, rounded cards, modern gradients, or smooth UI transitions.

`dist/retro.js` owns the 3D material pipeline: low-poly silhouettes, nearest-filtered atlas textures, affine texture interpolation, snapped vertices, and 5-bit color dithering. Render at 320 vertical pixels (240 on touch/performance fallback), scaling the canvas with nearest-neighbor interpolation. The player retains a low-poly human rig; enemies are zombies and monsters with hunched bodies, claws, jaws, horns, swollen sacs, crawling legs or floating tendrils. Their silhouettes and attacks identify their roles. Palette and textures distinguish terrain and enemy types. Fog is atmosphere, not a substitute for legible nearby terrain: its near plane sits beyond the normal gameplay camera distance in both lighting modes.

Weapon selection uses five raster sprites matching the weapon shapes. Keyboard shortcut numbers are functional labels. Menus and dialogs stay centered and fit narrow screens; form and Settings content scroll internally when necessary.

## Interaction ownership

`openPanel` / `closePanel` own settings, leaderboard, and new-run dialogs, focus restoration, inert backgrounds, and input clearing. The existing keyboard handler traps dialog focus and Escape closes the active panel. The username form requires nonblank input on every run and never pre-fills a previous name. Each score captures that run's username, furthest stage, and completion timestamp. Old scores without stage data show a dash rather than infer progress from elapsed-time waves. Dates display in the viewer's local timezone. The leaderboard has Player, Score, Stage, and Date columns, with loading, empty, failure, and refresh states. Scores retain idempotent run IDs for retries.

`retro.css` owns global scrollbar and focus styling. The game toast owns gameplay notices; inline live regions own form validation and score saving feedback. Desktop, touch, and controller input continue to share the existing action bindings. Reduced motion disables camera shake and freezes the secret skull. The skull floats around the outer menu, stops on hover/focus, and toggles Death Mode with a subtle red tint. Esc cancels only before starting; run difficulty is immutable.


## Settings surface

Operate mode: change one preference and return to the run. Graphics, Audio and Controls use three equal console tabs, with one visible panel, persistent Done action, aligned labels/values, and internal scrolling for bindings. Arrow keys, Home and End switch tabs; hidden panels do not participate in dialog focus trapping. Existing controls and audio settings remain accessible.

Graphics uses a compact choice for lighting, a pixelation selector, a single fog slider, and a frame-rate selector. Changes apply immediately and save locally. Automatic resolution can reduce under sustained slow frames; explicit choices stay fixed. FPS is a rendering cap, independent of simulation. Inputs use square native controls, the existing pixel font, cream/olive/gold colors and beveled console borders. Small screens retain two columns for labels and controls; longer labels wrap.

The Impeccable scoped distill workflow informed this surface. Its detector flagged inherited small HUD text and legacy styles outside Settings; Settings labels/controls use 12–16px minimums and were inspected at desktop and 390px width. No new visual world replaces the approved PS1 style.
