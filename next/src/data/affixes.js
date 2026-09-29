// Rift-touched elites (IMPROVEMENTS F8): spawn rates and the six affixes. The roll itself is
// rollElite in game/logic/elites.js. Every affix id has an icon bitmap in data/icons.js.
export const ELITE = Object.freeze({
  chance: Object.freeze([0, 0.015, 0.02, 0.025, 0.03]), // per ambient spawn, by stage (stage 1 none)
  perStageWave: 0.001, // + min(cap, 0.001 × max(0, stageWave − 3))
  perStageWaveCap: 0.01,
  maxAlive: Object.freeze([0, 1, 1, 2, 2]), // counts bodies (a BOUND pair is 2)
  death: Object.freeze({ chanceMult: 1.5, dualFromStage: 4, dualChance: 0.35 }), // duals only in Death Mode
  pity: Object.freeze({ fromStage: 2, atGoalFraction: 0.5 }),
  hp: 2.5,
  radius: 1.1,
  scale: 1.18,
  score: 3,
  xp: 3,
  grace: 0.6,
  never: Object.freeze(["skitter", "broodmother"]),
});

export const AFFIXES = Object.freeze({
  molten: Object.freeze({
    name: "MOLTEN",
    color: "#ff8a3c",
    exclude: Object.freeze(["drowned"]),
    death: Object.freeze({ delay: 0.8, radius: 3.0, player: 20, monsters: 40, source: "Molten burst" }),
  }),
  warded: Object.freeze({ name: "WARDED", color: "#c9efd1", exclude: Object.freeze(["lamplighter"]), shell: 0.4, regenDelay: 6, plates: 3 }),
  hasted: Object.freeze({ name: "HASTED", color: "#76bce3", exclude: Object.freeze(["revenant"]), walk: 1.3, cooldown: 0.65, windup: 0.85, windupFloor: 0.3 }),
  shardborn: Object.freeze({
    name: "SHARDBORN",
    color: "#b64ff6",
    exclude: Object.freeze([]),
    death: Object.freeze({ delay: 0.3, shots: 8, speed: 7, range: 14, damage: 9, source: "Shardborn shard" }),
  }),
  hexing: Object.freeze({
    name: "HEXING",
    color: "#f19fb2",
    exclude: Object.freeze(["hexer", "lamplighter"]),
    every: 5,
    first: 2,
    range: 22,
    radius: 1.8,
    fuse: 1.0,
    damage: 16,
    source: "Hex mark",
  }),
  bound: Object.freeze({
    name: "BOUND",
    color: "#9c7992",
    exclude: Object.freeze(["brute", "lamplighter", "drowned", "ashworm"]),
    split: 0.5,
    bodies: 2,
    enrage: Object.freeze({ walk: 1.3, cooldown: 0.7, tint: "#ff7979" }),
  }),
});

// Affix pairs a dual roll may never combine ("*" = with anything).
export const NO_DUAL = Object.freeze([Object.freeze(["molten", "shardborn"]), Object.freeze(["bound", "*"])]);
