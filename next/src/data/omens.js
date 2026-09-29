// Skull Omens (IMPROVEMENTS F12): curses worth taking. `effects` are Rules Ledger entries;
// `bonus` adds to the +10 Rift Score points every statue gives. Every id has an icon bitmap in
// data/icons.js.
import { FLOW } from "./stages.js";
import { STATUE_POINTS } from "./scoring.js";

const effect = (key, op, value) => Object.freeze({ key, op, value });
const mul = (key, value) => effect(key, "mul", value);
const add = (key, value) => effect(key, "add", value);
const flag = (key) => effect(key, "flag", true);

const omen = (id, name, text, effects, bonus) => Object.freeze({ id, name, text, effects: Object.freeze(effects), bonus });

export const OMENS = Object.freeze(
  Object.fromEntries(
    [
      omen("haste", "OMEN OF HASTE", "Monsters walk 10% faster.", [mul("enemySpeed", 1.1)], 15),
      omen("glass", "OMEN OF GLASS", "-20 max integrity.", [add("maxHp", -20)], 20),
      omen("famine", "OMEN OF FAMINE", "Kill and surge heals are halved; stage heal -10.", [mul("killHealMult", 0.5), mul("surgeHeal", 0.5), add("stageHeal", -10)], 15),
      omen("teeth", "OMEN OF TEETH", "Contact, slam and leap damage +25%.", [mul("enemyContact", 1.25)], 15),
      omen("swarm", "OMEN OF THE SWARM", "Surges bring 2 more monsters; 5 more may live; spawns 8% faster.", [add("surgeExtra", 2), add("liveCap", 5), add("keeperLiveCap", 1), mul("spawnInterval", 0.92)], 20),
      omen("dark", "OMEN OF DARKNESS", "The fog closes in by 30%. Health bars and distant radar blips hide.", [mul("fogMult", 0.7), flag("darkBars")], 15),
      omen("ash", "OMEN OF ASH", "Powerups drop half as often.", [mul("dropChance", 0.5)], 15),
      omen("iron", "OMEN OF IRON", "Monster projectiles fly 20% faster.", [mul("enemyShotSpeed", 1.2)], 15),
      omen("blood", "OMEN OF BLOOD", "Any hit breaks your chain; chain multipliers +0.1.", [flag("chainBreakOnWard"), add("chainTierBonus", 0.1)], 10),
      omen("hunt", "OMEN OF THE HUNT", "Rift-touched elites stir twice as often. The extra ones carry no powerup.", [mul("eliteChance", 2)], 5),
    ].map((row) => [row.id, row]),
  ),
);

// The Rules Ledger source of an active omen: its effects plus the Rift Score bonus it banks.
export function omenSource(id) {
  const o = OMENS[id];
  if (!o) return null;
  return { id: "omen:" + id, kind: "omen", label: o.name, icon: id, effects: [...o.effects, add("scoreMult", o.bonus)] };
}

// Copy of the KEEPERS statue dialog, its interact prompt and its refusal (F12, F1.3).
const CURSE = `+${FLOW.STATUE_BONUS}% persistent curse.`;
export const OMEN_TEXT = Object.freeze({
  title: "SKULL OMEN · CHOOSE A CURSE",
  prompt: `SKULL OMEN · +${FLOW.STATUE_BONUS}% CURSE · +${STATUE_POINTS}% SCORE`,
  silent: "THE SKULL IS SILENT WHILE A KEEPER STANDS",
  omenText: (o) => `${o.text} ${CURSE} +${STATUE_POINTS + o.bonus}% rift score.`,
  omenToast: (o) => `${o.name} · +${STATUE_POINTS + o.bonus}% RIFT SCORE`,
  bareTitle: "Bare curse",
  bareText: `${CURSE} +${STATUE_POINTS}% rift score.`,
  bareToast: `SKULL CURSE · +${STATUE_POINTS}% RIFT SCORE`,
  leaveTitle: "Leave",
  leaveText: "Keep your current difficulty.",
});
