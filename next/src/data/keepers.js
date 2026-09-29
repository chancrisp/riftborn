// Rift Keepers (IMPROVEMENTS F1.2): the ENEMY_TYPES stat shape plus keeper extras.
// stage (campaign home), title/epithet (sequence and title card), turn (rad/s while approaching),
// liveCap (live hostiles incl. the keeper and its summons), trickle (s between ambient spawns
// during the fight, divided by hpScale()), tagline (toast after the name), sequence (SEQUENCES
// key), spawn ("between" | "bell" | "dais" | a fixed [x, z]), reward ("spoils" | "major" | null),
// optional (woken by the player), gates (HP fractions crossed in order, F1.6) and guard
// (directional armour, F1.4). The table key is the bestiary key.
import { IRON_MAW, WARDEN } from "./enemies.js";

export const KEEPERS = Object.freeze({
  bellwether: Object.freeze({ name: "The Bellwether", hp: 1500, speed: 2.0, radius: 1.15, damage: 16, score: 1200, xp: 14, color: "#d2cba6",
    stage: 1, title: "THE BELLWETHER", epithet: "KEEPER OF THE MEADOWS", turn: 3.0, liveCap: 5, trickle: 5.0,
    tagline: "DASH THROUGH THE TOLL", sequence: "bellwether", spawn: "bell", reward: "spoils", optional: true,
    gates: Object.freeze([0.66, 0.5, 0.33]) }),
  ironmaw: Object.freeze({ ...IRON_MAW, hp: 1600,
    stage: 2, title: "IRON MAW", epithet: "KEEPER OF THE QUARRY", turn: 6.0, liveCap: 8, trickle: 4.0,
    tagline: "BAIT ITS CHARGE INTO SOLID COVER", sequence: "maw", spawn: Object.freeze([10, -8]), reward: "major",
    gates: Object.freeze([0.5]) }),
  abbot: Object.freeze({ name: "The Cinder Abbot", hp: 3800, speed: 1.55, radius: 1.3, damage: 20, score: 2200, xp: 20, color: "#ff8a3c",
    stage: 3, title: "THE CINDER ABBOT", epithet: "KEEPER OF THE CALDERA", turn: 1.2, liveCap: 6, trickle: 4.5,
    tagline: "CIRCLE BEHIND IT", sequence: "abbot", spawn: "between", reward: "spoils",
    gates: Object.freeze([0.5]),
    guard: Object.freeze({ front: 70, frontMult: 0.35, rear: 110, rearMult: 2.0 }) }),
  castellan: Object.freeze({ name: "The Castellan", hp: 4500, speed: 1.9, radius: 1.3, damage: 22, score: 3000, xp: 24, color: "#b8b4ac",
    stage: 4, title: "THE CASTELLAN", epithet: "KEEPER OF THE CITADEL", turn: 2.0, liveCap: 6, trickle: 4.5,
    tagline: "IN VIGIL · HOLD FIRE", sequence: "castellan", spawn: "between", reward: "spoils",
    gates: Object.freeze([0.7, 0.5, 0.35]),
    guard: Object.freeze({ front: 55, frontMult: 0.5 }) }),
  warden: Object.freeze({ ...WARDEN, hp: 4200,
    stage: 5, title: "THE RIFT WARDEN", epithet: "BOUND TO THE CROWN", turn: 4.0, liveCap: 0, trickle: 0,
    tagline: "FINAL ENCOUNTER", sequence: "warden", spawn: "dais", reward: null,
    gates: Object.freeze([0.5, 0.25]) }),
});

// The order the Warden raises its shades in (F6).
export const KEEPER_ORDER = Object.freeze(["bellwether", "ironmaw", "abbot", "castellan"]);

export const keeperDef = (id) => (Object.hasOwn(KEEPERS, id) ? KEEPERS[id] : null);
