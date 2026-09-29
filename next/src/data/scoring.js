// Rift Chain and Rift Score (IMPROVEMENTS F11): chain tiers, feats and the pure rules shared by
// game/scoring.js and its tests. The base score (run.score) never reads any of this.

// Chain window (s), and the extra grace a live chain gets on stage entry (the arrival rest).
export const CHAIN = Object.freeze({ window: 3.0, stageGrace: 3.5 });

// Rift Score points (%) each statue activation banks, bare curse, omen or trial alike.
export const STATUE_POINTS = 10;

// Overtime (anti-stall): full pay for `grace[kind]` seconds after the trigger (the goal, the
// portal or the dais: "portal"; a keeper spawn: "keeper"), then a linear fade to nothing over
// `fade` seconds.
export const OVERTIME = Object.freeze({ grace: Object.freeze({ portal: 45, keeper: 90 }), fade: 30 });

export const TIERS = Object.freeze([
  Object.freeze({ min: 0, name: "", mult: 1.0, color: "#ded6be" }),
  Object.freeze({ min: 10, name: "BLOODED", mult: 1.1, color: "#b8c49a" }),
  Object.freeze({ min: 25, name: "RAVENOUS", mult: 1.25, color: "#d4bc78" }),
  Object.freeze({ min: 50, name: "RIFTBOUND", mult: 1.5, color: "#e0aa91" }),
  Object.freeze({ min: 100, name: "CROWNBREAKER", mult: 2.0, color: "#e4d6b6" }),
]);

// FEATS[id] = { id, name, cue, bonus(args) }. Cue feats show a #featCue line and play `feat`;
// silent ones only reach the pause summary and the run report. The bonus is multiplied by the
// Rift multiplier M at award time (or by the snapshot M of stage-end and keeper feats).
const feat = (id, name, cue, bonus) => Object.freeze({ id, name, cue, bonus });
const extra = (kills, base, each) => base + each * Math.max(0, kills - 3);

export const FEATS = Object.freeze({
  massacre: feat("massacre", "MASSACRE", true, ({ kills = 0 } = {}) => 60 * (kills - 3)),
  skewer: feat("skewer", "SKEWER", true, ({ kills = 0 } = {}) => extra(kills, 150, 50)),
  detonation: feat("detonation", "DETONATION", true, ({ kills = 0 } = {}) => extra(kills, 100, 50)),
  baited: feat("baited", "BAITED", true, () => 400),
  interrupted: feat("interrupted", "INTERRUPTED", true, () => 750),
  unscathed: feat("unscathed", "UNSCATHED", true, () => 800),
  untouched: feat("untouched", "UNTOUCHED", false, ({ stage = 0 } = {}) => 500 * stage),
  swift: feat("swift", "SWIFT TRIAL", false, () => 600),
  riftbane: feat("riftbane", "RIFTBANE", false, () => 300),
  phased: feat("phased", "PHASED", false, () => 40),
  lastgasp: feat("lastgasp", "LAST GASP", false, () => 250),
});

// Trigger thresholds of the feats that game/scoring.js detects itself.
export const FEAT_RULES = Object.freeze({
  massacre: Object.freeze({ window: 0.3, kills: 4 }),
  skewer: Object.freeze({ kills: 3 }),
  detonation: Object.freeze({ kills: 3 }),
  swift: Object.freeze({ seconds: 45 }),
  phased: Object.freeze({ gap: 0.5, perStage: 10 }),
  lastgasp: Object.freeze({ kills: 5, integrity: 0.15, recent: 10 }),
});

// The highest tier whose minimum the chain count has reached.
export function tierOf(count) {
  let tier = 0;
  for (let i = 1; i < TIERS.length; i++) if (count >= TIERS[i].min) tier = i;
  return tier;
}

// M from the banked percentage points (ledger scoreMult plus STATUE_POINTS per statue).
export const riftMultiplier = (points) => Math.max(0.1, 1 + points / 100);

// Overtime pay factor `t` seconds after the trigger with `grace` seconds of full pay.
export function overtimeFactor(t, grace) {
  return Math.min(1, Math.max(0, 1 - Math.max(0, t - grace) / OVERTIME.fade));
}

// Score parts are whole points. The epsilon keeps float noise from costing a point
// (100 × 1.15 is 114.99999999999999 in doubles).
export const points = (value) => Math.floor(value + 1e-6);
