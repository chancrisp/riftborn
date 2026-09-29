// Pure run-flow rules of the director (IMPROVEMENTS F1.3, F6, F18.5, §1.4), THREE-free so tests
// drive them directly; director.js re-exports them.
import { MAX_HOSTILES } from "../../data/enemies.js";
import { keeperDef } from "../../data/keepers.js";
import { stageDef } from "../../data/stages.js";

// Wave-2 ledger sources may raise the Wave-1 hostile cap, never past this (§1.4).
export const HOSTILE_CEILING = 65;
// The Crown Dais summons the Warden when the player comes this close to the pad centre, or
// this many seconds of play after the goal, whichever is first (F6).
export const DAIS_REACH = 6;
export const DAIS_PATIENCE = 45;

// The keeper that gates this stage's portal under KEEPERS: the world's keeper unless it is
// optional (the Bellwether, woken by the shrine bell). Stage 5 has none (the Warden waits on
// the Crown Dais).
export function keeperFor(stage) {
  const id = stageDef(stage)?.keeper ?? null;
  return id && !keeperDef(id)?.optional ? id : null;
}

// Live hostiles allowed outside keeper fights: MAX_HOSTILES plus rules.sum("liveCap"), clamped.
export const hostileCap = (liveCapBonus = 0) => Math.min(HOSTILE_CEILING, MAX_HOSTILES + liveCapBonus);

// The stage-entry heal after rules.sum("stageHeal") (the Omen of Famine takes 10), never below 0.
export const stageHealAmount = (base, bonus = 0) => Math.max(0, base + bonus);

// Game speed (F18.5): the fixed step scaled by speed / 100. Full speed returns dt untouched, so
// the ORIGINAL simulation stays bit-identical.
export const scaledDt = (dt, speed) => (speed > 0 && speed < 100 ? (dt * speed) / 100 : dt);

// The assists a preference set leans on (F18.5), in a fixed order: game speed below 100,
// auto-fire "always" and aim assist "high". Each marks a run ASSISTED.
export function assistKinds(prefs, speed) {
  const kinds = [];
  if (speed > 0 && speed < 100) kinds.push("speed");
  if (prefs?.autoFire === "always") kinds.push("autoFire");
  if (prefs?.aimAssist === "high") kinds.push("aimAssist");
  return kinds;
}

// Folds the assists in use now into the run's sticky flags { assisted, assistKinds, assistSpeed }.
// Returns true when something new was marked (reverting a preference never clears a flag).
export function markAssists(flags, kinds, speed) {
  let changed = false;
  for (const kind of kinds)
    if (!flags.assistKinds.includes(kind)) {
      flags.assistKinds.push(kind);
      changed = true;
    }
  if (kinds.includes("speed") && speed < flags.assistSpeed) {
    flags.assistSpeed = speed;
    changed = true;
  }
  if (changed) flags.assisted = true;
  return changed;
}

// True when the awake dais should summon the Warden: `t` seconds of play since the goal, the
// player's position, the pad centre.
export function daisDue(t, player, pad) {
  if (t >= DAIS_PATIENCE) return true;
  return !!player && !!pad && Math.hypot(player.x - pad.x, player.z - pad.z) <= DAIS_REACH;
}

// The v2 payload's feat list: "skewer:3,baited:1" from { id: count }, zero counts left out.
export const featList = (feats = {}) =>
  Object.entries(feats ?? {})
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${id}:${n}`)
    .join(",");
