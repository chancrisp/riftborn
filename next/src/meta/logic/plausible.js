// The client plausibility guard (IMPROVEMENTS F15): a bound on a v2 row's Rift Score computed
// from the payload itself, checked before the row is queued for a shared board. Failing rows
// stay on this device, flagged unverified. THREE-free; meta/scores.js uses it.
import { OMENS } from "../../data/omens.js";
import { RELICS } from "../../data/relics.js";
import { STATUE_POINTS, TIERS } from "../../data/scoring.js";

const TOP_CHAIN = TIERS[TIERS.length - 1].mult;
const CANDLE_BONUS = 0.25; // Black Candle chainTierBonus
const BLOOD_BONUS = 0.1; // Omen of Blood chainTierBonus
const FEAT_PER_KILL = 200; // MASSACRE, SKEWER, DETONATION, RIFTBANE, PHASED
const FEAT_PER_STAGE = 6000; // UNTOUCHED, UNSCATHED, BAITED, INTERRUPTED, SWIFT, LAST GASP
const SLACK = 1.05;
const SCORE_PER_KILL = 5000;
const SCORE_FLOOR = 12000;
const SECONDS_PER_STAGE = 20;

const ids = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === "string") : []);
const num = (v) => (Number.isFinite(v) ? v : 0);
const cursed = (relics) => ids(relics).filter((id) => RELICS[id]?.rarity === "cursed").length;

// M at the end of the run described by a payload: 10 per statue, each omen's bonus and 10 per
// cursed relic, in percentage points. Board rows show it as X{M}; the guard uses it as Mmax.
export function payloadMultiplier(p) {
  const omenPoints = ids(p?.omens).reduce((sum, id) => sum + (OMENS[id]?.bonus ?? 0), 0);
  const points = STATUE_POINTS * num(p?.statue_count) + omenPoints + STATUE_POINTS * cursed(p?.relics);
  return Math.max(0.1, 1 + points / 100);
}

// plausible(payload) -> bool. A row passes when
//   rift_score <= ceil((score × chainMax + featCap) × Mmax × 1.05),
//   chain_best <= kills, score <= kills × 5000 + 12000 and seconds >= stage × 20.
export function plausible(p) {
  if (!p || typeof p !== "object") return false;
  const kills = num(p.kills),
    stage = num(p.stage),
    score = num(p.score);
  const chainMax = TOP_CHAIN + (ids(p.relics).includes("black_candle") ? CANDLE_BONUS : 0) + (ids(p.omens).includes("blood") ? BLOOD_BONUS : 0);
  const featCap = FEAT_PER_KILL * kills + FEAT_PER_STAGE * stage;
  const bound = Math.ceil((score * chainMax + featCap) * payloadMultiplier(p) * SLACK);
  return num(p.rift_score) <= bound && num(p.chain_best) <= kills && score <= kills * SCORE_PER_KILL + SCORE_FLOOR && num(p.seconds) >= stage * SECONDS_PER_STAGE;
}
