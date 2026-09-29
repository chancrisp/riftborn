// Pure rules of the rift-touched elites (IMPROVEMENTS F8), THREE-free so tests drive them
// directly; game/elites.js re-exports them.
import { ELITE, AFFIXES, NO_DUAL } from "../../data/affixes.js";

export const AFFIX_IDS = Object.freeze(Object.keys(AFFIXES));

// Per-stage table rows; stages past the table use its last row.
const stageRow = (table, stage) => table[Math.max(0, Math.min(table.length - 1, (stage | 0) - 1))];

// Live elite bodies a stage allows (a BOUND pair is two).
export const maxAlive = (stage) => stageRow(ELITE.maxAlive, stage);

// The chance per ambient spawn before the ledger: the stage rate plus a term that grows with
// the waves spent on this stage (restarting on every stage), x1.5 in Death Mode.
export function eliteChance(stage, stageWave, death = false) {
  const late = Math.min(ELITE.perStageWaveCap, ELITE.perStageWave * Math.max(0, stageWave - 3));
  return (stageRow(ELITE.chance, stage) + late) * (death ? ELITE.death.chanceMult : 1);
}

// Whether two affixes may share one elite (NO_DUAL; "*" pairs with anything).
export function dualAllowed(a, b) {
  if (a === b) return false;
  for (const [x, y] of NO_DUAL) if ((x === a && (y === "*" || y === b)) || (x === b && (y === "*" || y === a))) return false;
  return true;
}

// Affixes `kind` may carry next to `taken`: its exclusions, the dual rules, and BOUND only while
// `free` body slots fit the pair.
export function affixOptions(kind, free, taken = [], exclude = []) {
  return AFFIX_IDS.filter(
    (id) =>
      !AFFIXES[id].exclude.includes(kind) &&
      !exclude.includes(id) &&
      (id !== "bound" || free >= AFFIXES.bound.bodies) &&
      taken.every((other) => dualAllowed(other, id)),
  );
}

// One affix drawn uniformly from the options (null when none fit; no draw then).
export function pickAffix(kind, rng, free, taken = [], exclude = []) {
  const options = affixOptions(kind, free, taken, exclude);
  return options.length ? options[Math.min(options.length - 1, Math.floor(rng() * options.length))] : null;
}

// The elite roll of one ambient spawn -> { affixes: [ids], extra } | null.
// - never below stage 2, for ELITE.never kinds, during a keeper fight, or at the body cap;
// - p = chance x rules.mul("eliteChance"); u = rng(); elite when u < p; `extra` when it only
//   happened because the ledger raised the chance (u >= the base chance);
// - `forced` (the pity spawn) skips the chance draw and is never extra;
// - Death Mode only, from stage 4: a second compatible affix with dualChance.
export function rollElite({ kind, stage, stageWave = 0, death = false, alive = 0, keeperActive = false, forced = false, rng, rules = null }) {
  if (stage < 2 || ELITE.never.includes(kind) || keeperActive) return null;
  const free = maxAlive(stage) - alive;
  if (free <= 0) return null;
  let extra = false;
  if (!forced) {
    const base = eliteChance(stage, stageWave, death),
      u = rng();
    if (!(u < base * (rules?.mul?.("eliteChance") ?? 1))) return null;
    extra = u >= base;
  }
  const first = pickAffix(kind, rng, free);
  if (!first) return null;
  const affixes = [first];
  if (death && stage >= ELITE.death.dualFromStage && rng() < ELITE.death.dualChance) {
    const second = pickAffix(kind, rng, free, affixes);
    if (second) affixes.push(second);
  }
  return { affixes, extra };
}

// Pity: on stages 2-5, once stageKills reaches floor(goal x 0.5) with no elite spawned on the
// stage, the next ambient spawn is forced elite.
export const pityDue = ({ stage, stageKills, stageGoal, spawned }) =>
  stage >= ELITE.pity.fromStage && spawned === 0 && stageKills >= Math.floor(stageGoal * ELITE.pity.atGoalFraction);

// The elite's stat block: radius x1.1, score x3 (to the nearest 10), xp x3.
export function eliteDef(def) {
  return Object.freeze({
    ...def,
    radius: def.radius * ELITE.radius,
    score: Math.round((def.score * ELITE.score) / 10) * 10,
    xp: def.xp * ELITE.xp,
  });
}

// WARDED plates still orbiting: one falls away per third of the shell lost.
export function platesLeft(shell, shellMax, plates = AFFIXES.warded.plates) {
  if (!(shellMax > 0) || !(shell > 0)) return 0;
  return Math.min(plates, Math.ceil((shell / shellMax) * plates - 1e-9));
}

// Shardborn death burst: shot i leaves at i x (2 pi / n) plus a jitter inside its own sector, so
// the gaps stay about 2.3 m wide at 3 m. `random` draws [0, 1).
export function shardYaws(random, count = AFFIXES.shardborn.death.shots) {
  const sector = (2 * Math.PI) / count,
    yaws = [];
  for (let i = 0; i < count; i++) yaws.push(i * sector + random() * sector);
  return yaws;
}

// A windup under the HASTED multiplier, never below its floor; unchanged without one.
export const windupOf = (seconds, mul) => (mul === undefined || mul === 1 ? seconds : Math.max(AFFIXES.hasted.windupFloor, seconds * mul));

// The name plate and toast text: "{AFFIX} {NAME}", e.g. "HASTED WARDED SNIPER",
// "ENRAGED BOUND LEAPER".
export function eliteTitle(e) {
  const affixes = (e?.elite ?? []).map((id) => AFFIXES[id]?.name ?? String(id).toUpperCase()).join(" ");
  return `${e?.eliteEnraged ? "ENRAGED " : ""}${affixes} ${String(e?.def?.name ?? e?.kind ?? "").toUpperCase()}`.trim();
}

// The guaranteed powerup of a later elite: one kind drawn uniformly, never Insta Kill while one
// is running (the F9 reroll rule).
export function elitePowerup(random, kinds, executing = false) {
  const options = executing ? kinds.filter((kind) => kind !== "execution") : kinds;
  return options.length ? options[Math.min(options.length - 1, Math.floor(random() * options.length))] : null;
}
