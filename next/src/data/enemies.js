import { PLAYER_DEFAULTS } from "./progression.js";
import { stageDef } from "./stages.js";

// Monster base stats. `damage` is CONTACT damage; ranged/slam attacks define their own
// numbers in the AI (see spec/enemies.md §6). `color` tints death bursts. `score` is
// awarded on kill; `xp` is the value of the XP shard dropped.
export const ENEMY_TYPES = Object.freeze({
  runner: Object.freeze({ name: "Restless", hp: 50, speed: 2.7, radius: 0.5, damage: 10, score: 100, xp: 1, color: "#cb86ea" }),
  skitter: Object.freeze({ name: "Skitter", hp: 27, speed: 4.4, radius: 0.38, damage: 7, score: 90, xp: 1, color: "#a2e48b" }),
  gunner: Object.freeze({ name: "Spitter", hp: 64, speed: 2.1, radius: 0.5, damage: 9, score: 160, xp: 2, color: "#ffd080" }),
  charger: Object.freeze({ name: "Charger", hp: 125, speed: 2.2, radius: 0.65, damage: 17, score: 220, xp: 3, color: "#ff998b" }),
  brute: Object.freeze({ name: "Brute", hp: 310, speed: 1.25, radius: 0.88, damage: 22, score: 400, xp: 5, color: "#b99beb" }),
  mortar: Object.freeze({ name: "Mortar", hp: 95, speed: 1.8, radius: 0.5, damage: 10, score: 240, xp: 3, color: "#93bfff" }),
  sniper: Object.freeze({ name: "Sniper", hp: 76, speed: 1.25, radius: 0.52, damage: 28, score: 330, xp: 4, color: "#ff6fa5" }),
  leaper: Object.freeze({ name: "Leaper", hp: 145, speed: 2.9, radius: 0.62, damage: 24, score: 300, xp: 4, color: "#ffad5c" }),
  splitter: Object.freeze({ name: "Splitter", hp: 190, speed: 1.9, radius: 0.7, damage: 15, score: 360, xp: 5, color: "#65e7d1" }),
  stormer: Object.freeze({ name: "Stormer", hp: 210, speed: 2.35, radius: 0.72, damage: 12, score: 440, xp: 6, color: "#6d96ff" }),
});

// Death Mode adds these to every stage pool (broodmother from stage 2).
export const DEATH_TYPES = Object.freeze({
  revenant: Object.freeze({ name: "Revenant", hp: 100, speed: 3.7, radius: 0.48, damage: 16, score: 250, xp: 3, color: "#cf484e" }),
  hexer: Object.freeze({ name: "Hexer", hp: 150, speed: 2.3, radius: 0.6, damage: 18, score: 330, xp: 4, color: "#dc7392" }),
  broodmother: Object.freeze({ name: "Broodmother", hp: 340, speed: 1.5, radius: 1.1, damage: 22, score: 500, xp: 6, color: "#b5574e" }),
});

// Bosses. Warden HP is scaled by the normal spawn HP factor at stage 5; Iron Maw HP is
// 680 x difficultyScale() only (independent of stage and wave).
export const WARDEN = Object.freeze({ name: "Rift Warden", hp: 1300, speed: 1.8, radius: 1.35, damage: 24, score: 5000, xp: 0, color: "#c78dff" });
export const IRON_MAW = Object.freeze({ name: "Iron Maw", base: "charger", hp: 680, speed: 3, radius: 1.35, damage: 18, chargeDamage: 34, score: 1400, xp: 18, color: "#ff998b" });

export const ALL_TYPES = Object.freeze({ ...ENEMY_TYPES, ...DEATH_TYPES });
export const typeOf = (kind) => ALL_TYPES[kind] || (kind === "warden" ? WARDEN : kind === "ironmaw" ? IRON_MAW : null);

// KEEPERS creatures (IMPROVEMENTS F7). Deliberately outside ENEMY_TYPES and ALL_TYPES, so the
// Wave-1 pools, typeOf and the ORIGINAL ruleset never see them; data/defs.js resolves them.
export const EXTRA_TYPES = Object.freeze({
  drowned: Object.freeze({ name: "Drowned", hp: 70, speed: 1.7, radius: 0.55, damage: 8, score: 150, xp: 2, color: "#a4b236" }),
  ashworm: Object.freeze({ name: "Ashworm", hp: 130, speed: 3.6, radius: 0.6, damage: 14, score: 320, xp: 4, color: "#baa495" }),
  lamplighter: Object.freeze({ name: "Lamplighter", hp: 120, speed: 2.0, radius: 0.55, damage: 10, score: 380, xp: 5, color: "#9fe8ff" }),
});

// Run tuning: enemy speed multiplier, damage-to-player multiplier, music tempo.
export const RUN_MODES = Object.freeze({
  normal: Object.freeze({ speed: 1, damage: 1, bpm: 140 }),
  death: Object.freeze({ speed: 1.35, damage: 1.5, bpm: 168 }),
});

// The ambient spawn pool as weighted entries [[kind, weight], ...] (IMPROVEMENTS F7). The
// stage's own kinds and the Death Mode kinds weigh 1; KEEPERS adds the stage's `extra`
// creatures, each once stageKills reaches its threshold. ORIGINAL (the default) returns the
// Wave-1 kinds only, in their Wave-1 order, so the uniform pick over them is unchanged.
export function enemyPool(pool, death, stage, { original = true, stageKills = 0 } = {}) {
  const base = pool && pool.length ? pool : Object.keys(ENEMY_TYPES);
  const kinds = death ? [...base, "revenant", "hexer", ...(stage > 1 ? ["broodmother"] : [])] : base;
  const entries = kinds.map((kind) => [kind, 1]);
  if (original) return entries;
  for (const [kind, weight, minKills] of stageDef(stage).extra ?? []) if (stageKills >= minKills) entries.push([kind, weight]);
  return entries;
}

// KEEPERS walk cap (IMPROVEMENTS §1.4): no non-keeper monster or elite walks faster than this,
// whatever Death Mode, wave, curse, omen or affix terms stack up. Charges and leaps are exempt.
export const WALK_CAP = 0.95 * PLAYER_DEFAULTS.speed;

// Encounter tuning (Iron Maw, Warden nodes, trial anchors and vents).
export const CHALLENGE = Object.freeze({
  quarryHP: 680,
  quarryWindup: 1.05,
  quarryCharge: 0.85,
  quarrySpeed: 20,
  quarryStagger: 2,
  quarryVulnerability: 1.5,
  anchorHP: 120,
  nodeHP: 110,
  nodeDeadline: 6,
  nodeCooldown: 15,
  nodeEvents: 3,
  ventWarning: 1.5,
  ventActive: 1.4,
  ventRecovery: 2,
  ventDamage: 26,
});
export const anchorMultiplier = (count) => Math.round((1 - Math.min(3, Math.max(0, count)) * 0.2) * 10) / 10;

export const MAX_HOSTILES = 55;
