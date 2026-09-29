// Living Worlds (IMPROVEMENTS F10): each world's hazard prop or zone. Props are encounter
// objects of kind "prop" (run.objects); lava pools are world zones (run.worldZones). The
// toasts show on the first sighting per run.
const freezeDeep = (row) => Object.freeze(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v && typeof v === "object" ? Object.freeze(v) : v])));

export const PROP_KINDS = Object.freeze({
  marsh: freezeDeep({ stage: 1, count: 6, hp: 1, fuse: 0.35, radius: 0.9, blast: { r: 3.5, monsters: 70, player: 14, source: "Marsh gas" }, regrow: 30, toast: "MARSH GAS · SHOOT TO IGNITE", sound: "gasPop" }),
  charge: freezeDeep({ stage: 2, count: 5, hp: 20, fuse: 0.5, radius: 0.8, blast: { r: 4.0, monsters: 90, player: 24, source: "Blasting charge" }, chain: 4, shake: 0.35, toast: "BLASTING CHARGE · SHOOT TO DETONATE", sound: "fuse" }),
  beacon: freezeDeep({ stage: 4, count: 3, hp: 60, fuse: 1.0, radius: 2.0, flare: { r: 14, stun: 1.6, damage: 30 }, relight: 45, toast: "LIVE BEACON · SHOOT THE RUNE TO FLARE", sound: "beaconFlare" }),
  crystal: freezeDeep({ stage: 5, count: 8, hp: 50, fuse: 0.8, radius: 2.2, blast: { r: 4.0, monsters: 90, player: 22, source: "Falling crystal" }, toast: "FALLING CRYSTAL · SHOOT THE SPIRE", sound: "crystalFall" }),
});

export const ZONE_KINDS = Object.freeze({
  lava: freezeDeep({ stage: 3, tick: 0.5, player: 8, monsters: 25, navCost: 8, sear: 0.5, immune: ["abbot", "ashworm"], source: "Lava", toast: "LAVA BURNS · LURE THEM IN" }),
});

// fx.zone visuals: flat unlit discs draped at ground + 0.12, flickering at 15 fps.
export const ZONE_STYLES = Object.freeze({
  cinder: Object.freeze({ color: "#ff7a2e", opacity: 0.55, ember: 0.3 }),
  embers: Object.freeze({ color: "#ffb05c", opacity: 0.45, ember: 0.25 }),
  silt: Object.freeze({ color: "#6f8a7a", opacity: 0.5, ember: 0 }),
  lava: Object.freeze({ color: null, opacity: 0, ember: 0.5 }), // the pool mesh is the visual
});

// Shared rules of the hazard system (game/hazards.js) and its tests.
export const HAZARD = Object.freeze({
  seen: 12, // first-encounter distance (toast, codex)
  minHeight: 2.3, // every hit volume is at least this tall
  // Towers and spires take hits on their cover only below this height above the base.
  register: Object.freeze({ beacon: 2.6, crystal: 3 }),
  flash: 0.13, // the white crack flash: 2 frames at 15 fps
  blastHeight: 0.5,
  swell: 0.3, // marsh pods swell to x1.3 over their fuse
  regrowTime: 2, // pods scale back up over 2 s, untargetable
  bubbleEvery: 0.6,
  sparkEvery: 0.05, // a lit charge's fuse
  fallTime: 0.4, // a crystal's visible drop, the end of its fuse
  fallsAtOnce: 2,
  cloud: Object.freeze({ color: "#9fbf7a", life: 1.5 }),
  flareTint: Object.freeze({ color: "#83e7ff", strength: 0.25, duration: 0.15 }),
  pillar: Object.freeze({ color: "#aef4ff", height: 20, width: 1, opacity: 0.5 }),
  castellanStagger: 0.8,
  grid: 8, // broad-phase cell size of the hit volumes
  // Telegraph kind of each prop's fuse (F1.5): the gas cloud, the charge's blast, the flare
  // radius and the crystal's landing.
  marker: Object.freeze({ marsh: "gas", charge: "artillery", beacon: "beacon", crystal: "rockfall" }),
});

// Prop-to-prop reach (blast chains): centre distance, inclusive, so 4.0 m chains at r 4 and
// 4.1 m does not.
export const chainReach = (a, b, radius) => Math.hypot(a.x - b.x, a.z - b.z) <= radius;

// Inside a lava pool's footprint (axis-aligned sx x sz box), grown by `pad` (a body's radius).
export const inPool = (pool, x, z, pad = 0) => Math.abs(x - pool.x) <= pool.sx / 2 + pad && Math.abs(z - pool.z) <= pool.sz / 2 + pad;

// Whether damage came from the player (Rift Chain credit, F11): player weapons, mods and relics,
// or a source flagged `player` (a player-triggered prop, a friendly zone); environment and
// friendly-fire blasts are not.
export function playerTriggered(source) {
  if (!source || typeof source !== "object") return false;
  if (source.player === true) return true;
  if (source.environment || source.friendlyFire) return false;
  return source.relic === true || (Number.isInteger(source.weapon) && source.weapon >= 0);
}
