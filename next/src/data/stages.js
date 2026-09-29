// The campaign: five fractured worlds. `portal` is the fixed rift clearing, `pool` the
// ambient spawn kinds, `goal` the kill count that opens the rift (stage 2 summons Iron
// Maw first; stage 5 summons the Warden instead of a portal). KEEPERS additions: `keeper`
// (the world's keeper, data/keepers.js) and `extra` ([kind, weight, minStageKills] entries
// added to the pool; ORIGINAL never reads them).
const extra = (...entries) => Object.freeze(entries.map((entry) => Object.freeze(entry)));
export const STAGES = Object.freeze([
  Object.freeze({ id: 1, name: "MEADOWS", sky: "#89b4e2", fog: "#89b4e2", portal: [0, -30], pool: ["runner", "skitter", "gunner"], goal: 12, story: "The old paths still lead to the rift. Follow them.", trial: "HUNT THE RESTLESS", keeper: "bellwether", extra: extra(["drowned", 0.35, 6]) }),
  Object.freeze({ id: 2, name: "SHATTERED QUARRY", sky: "#7f8db6", fog: "#65708f", portal: [27, -19], pool: ["runner", "skitter", "gunner", "charger", "sniper"], goal: 22, story: "The miners dug until something answered.", trial: "QUARRY HUNT", keeper: "ironmaw", extra: extra(["drowned", 0.5, 0]) }),
  Object.freeze({ id: 3, name: "EMBER CALDERA", sky: "#574464", fog: "#3b263e", portal: [-28, 22], pool: ["charger", "brute", "mortar", "leaper", "splitter"], goal: 34, story: "The mountain burns around a wound that will not close.", trial: "VENT HUNT", keeper: "abbot", extra: extra(["ashworm", 0.6, 0]) }),
  Object.freeze({ id: 4, name: "AURORA CITADEL", sky: "#273c70", fog: "#182449", portal: [6, 34], pool: ["sniper", "leaper", "splitter", "stormer", "brute"], goal: 48, story: "The last defenders sealed their city from within.", trial: "ANCHOR GUARD", keeper: "castellan", extra: extra(["lamplighter", 0.5, 0]) }),
  Object.freeze({ id: 5, name: "THE VOID CROWN", sky: "#130e34", fog: "#0b0820", portal: [-34, -20], pool: ["stormer", "mortar", "brute", "sniper", "leaper"], goal: 64, story: "Every fracture ends beneath the same crown.", trial: null, keeper: null, extra: extra(["ashworm", 0.4, 0], ["lamplighter", 0.35, 0]) }),
]);
export const stageDef = (stage) => STAGES[Math.max(0, Math.min(STAGES.length - 1, (stage | 0) - 1))];

// Campaign cinematics. `stage` title/text are replaced by the stage name and story.
export const SEQUENCES = Object.freeze({
  opening: Object.freeze({ duration: 2.8, title: "THE FIRST FRACTURE", text: "Five broken worlds. One way home. Find the rifts.", cue: "bossIntro" }),
  stage: Object.freeze({ duration: 1.5, title: "BEYOND THE RIFT", text: "The fracture deepens.", cue: "bossIntro" }),
  maw: Object.freeze({ duration: 2.4, title: "IRON MAW", text: "The quarry has a keeper. Bait its charge into solid cover.", cue: "bossIntro" }),
  warden: Object.freeze({ duration: 3, title: "THE RIFT WARDEN", text: "The last rift is bound to its crown.", cue: "bossIntro" }),
  phase: Object.freeze({ duration: 1.8, title: "THE CROWN BREAKS", text: "Destroy both charging nodes to expose the Warden.", cue: "phase" }),
  victory: Object.freeze({ duration: 4.5, title: "THE RIFT FALLS SILENT", text: "The crown is broken. For a moment, the worlds can breathe.", cue: "victory" }),
  // KEEPERS (F1.8). `dais` frames a position actor (the pad centre) instead of a model.
  bellwether: Object.freeze({ duration: 2.6, title: "THE BELLWETHER", text: "The flock still follows its bell. Dash through the toll. Strike when it rests.", cue: "bossIntro" }),
  abbot: Object.freeze({ duration: 2.6, title: "THE CINDER ABBOT", text: "The last keeper swallowed the first ember. Its back still burns. Circle behind it.", cue: "bossIntro" }),
  castellan: Object.freeze({ duration: 2.6, title: "THE CASTELLAN", text: "The wall still has a keeper. When it keeps vigil, hold your fire.", cue: "bossIntro" }),
  dais: Object.freeze({ duration: 2.0, title: "THE CROWN AWAITS", text: "Ascend the dais before the crown grows impatient.", cue: "phase" }),
  unmade: Object.freeze({ duration: 1.8, title: "THE CROWN UNMADE", text: "The rift remembers every keeper you broke.", cue: "phase" }),
});

export const TRIAL_NAMES = Object.freeze(["HUNT THE RESTLESS", "QUARRY HUNT", "VENT HUNT", "ANCHOR GUARD"]);

export const FLOW = Object.freeze({
  PORTAL_RADIUS: 3.5,
  STATUE_BONUS: 5, // % difficulty per activated statue curse
  WAVE_LENGTH: 30, // seconds of total run time per wave
  STAGE_HEAL: 25,
  SURGE_HEAL: 12,
  KILL_HEAL_EVERY: 12,
  KILL_HEAL: 5,
  DEMO_SPEED: 1.5,
  DEMO_STAGE_SECONDS: 80,
  TUTORIAL_GOAL: 5,
  TUTORIAL_PORTAL: Object.freeze([0, -20]),
  FIRST_SPAWN: 0.8,
});

// Stamped on every submitted score so balance changes never mix silently on boards. Each
// ruleset has its own version (versionOf); records stamped by Wave-1 builds (`reborn-1`) count
// as the ORIGINAL ruleset (sameRuleset).
export const GAMEPLAY_VERSIONS = Object.freeze({ original: "original-1", keepers: "keepers-1" });
export const LEGACY_ORIGINAL = Object.freeze(["reborn-1"]);
// The Wave-1 stamp, kept by the Wave-1 submission path and personal bests until profile v2
// (F19.5) migrates them onto sameRuleset; that change switches it to GAMEPLAY_VERSIONS.original.
export const GAMEPLAY_VERSION = LEGACY_ORIGINAL[0];
const canon = (version) => (LEGACY_ORIGINAL.includes(version) ? GAMEPLAY_VERSIONS.original : version);
export const versionOf = (run) => (run?.original ? GAMEPLAY_VERSIONS.original : GAMEPLAY_VERSIONS.keepers);
export const sameRuleset = (a, b) => canon(a) === canon(b);
