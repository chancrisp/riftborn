# Riftborn design

Riftborn is a PS1-era survival shooter across five fractured landscapes. The user approved the name and a cohesive period look for every screen, based on low-poly textured character models in the supplied fern video. The main menu is centered over a real CPU run at 1.5× speed; it contains a title and three actions, with controls confined to Settings.

## Visual system

`dist/retro.css` owns interface tokens and overrides the legacy layout styles. Ink `#15151e`, cream `#ded6be`, muted olive `#b8c49a`, aged gold `#d4bc78`, and gray `#9c9a8b` form the UI palette. Use the bundled Crypt pixel font for headings, labels, buttons, and data, with Courier New as fallback. Hard beveled borders, square corners, solid fills, and offset pixel shadows are deliberate. No blur, bloom, glass, rounded cards, modern gradients, or smooth UI transitions.

`dist/retro.js` owns the 3D material pipeline: low-poly silhouettes, nearest-filtered atlas textures, affine texture interpolation, snapped vertices, and 5-bit color dithering. Render at 320 vertical pixels (240 on touch/performance fallback), scaling the canvas with nearest-neighbor interpolation. Models should have human proportions rather than voxel bodies. Palette and textures distinguish terrain and enemy types. Fog is atmosphere, not a substitute for legible nearby terrain: its near plane sits beyond the normal gameplay camera distance in both lighting modes.

Weapon selection uses five raster sprites matching the weapon shapes. Keyboard shortcut numbers are functional labels. Menus and dialogs stay centered and fit narrow screens; form and Settings content scroll internally when necessary.

## Interaction ownership

`openPanel` / `closePanel` own settings, leaderboard, and new-run dialogs, focus restoration, inert backgrounds, and input clearing. The existing keyboard handler traps dialog focus and Escape closes the active panel. The username form requires nonblank input on every run and never pre-fills a previous name. Each score captures that run's username, furthest stage, and completion timestamp. Old scores without stage data show a dash rather than infer progress from elapsed-time waves. Dates display in the viewer's local timezone. The leaderboard has Player, Score, Stage, and Date columns, with loading, empty, failure, and refresh states. Scores retain idempotent run IDs for retries.

`retro.css` owns global scrollbar and focus styling. The game toast owns gameplay notices; inline live regions own form validation and score saving feedback. Desktop, touch, and controller input continue to share the existing action bindings. Reduced motion disables camera shake; menus do not add decorative animation.
