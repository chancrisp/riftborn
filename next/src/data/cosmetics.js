// Keepsakes (IMPROVEMENTS F19.4): the cosmetic catalogue (badges, dash trails, titles) and the
// MASTERY & CHALLENGES entries that unlock them. Records and cosmetics only: gameplay reads
// none of this except through the profile's whitelisted cosmetics getters (§1.4).
import { LANDMARK_IDS } from "./landmarks.js";
import { RELICS } from "./relics.js";

// { slot, value, label, color, text }: `text` is the header badge text (#earnedBadge) or the
// title shown under a name on board rows and the results card.
const item = (slot, value, label, color = null, text = "") => Object.freeze({ slot, value, label, color, text });

// Catalogue order is Journal order within each slot.
export const COSMETICS = Object.freeze([
  item("badge", "none", "No badge"),
  item("badge", "skull", "Trial skull badge", "#f2af78"),
  item("badge", "iron", "Iron Maw badge", "#b7d6e8", "IRON"),
  item("badge", "crown", "Cursed crown badge", "#e4b6ff", "CROWN"),
  item("badge", "bell", "Bell badge", "#d2cba6", "BELL"),
  item("badge", "ember", "Ember badge", "#ff8a3c", "EMBER"),
  item("badge", "aegis", "Aegis badge", "#83e7ff", "AEGIS"),
  item("badge", "unmade", "Unmade badge", "#d9d2b0", "UNMADE"),
  item("badge", "omen", "Omen badge", "#cd7767", "OMEN"),
  item("badge", "chain", "Chain badge", "#d4bc78", "CHAIN"),
  item("badge", "keeper", "Keeper badge", "#91cfff", "KEEPER"),
  item("trail", "normal", "Normal trail", "#81ffff"),
  item("trail", "ember", "Warden ember trail", "#f2af78"),
  item("trail", "aurora", "Aurora trail", "#91cfff"),
  item("trail", "jade", "Jade trail", "#6be7a6"),
  item("trail", "azure", "Azure trail", "#6ad6ff"),
  item("trail", "amethyst", "Amethyst trail", "#b899ff"),
  item("trail", "rose", "Rose trail", "#f497ff"),
  item("trail", "amber", "Amber trail", "#ffca65"),
  item("title", "wanderer", "Wanderer title", null, "WANDERER"),
  item("title", "wardenbane", "Wardenbane title", null, "WARDENBANE"),
  item("title", "cursebearer", "Cursebearer title", null, "CURSEBEARER"),
  item("title", "unmade", "Unmade title", null, "UNMADE"),
  item("title", "crownbreaker", "Crownbreaker title", null, "CROWNBREAKER"),
  item("title", "hunter", "Hunter title", null, "HUNTER"),
]);

// The value every slot starts with, always available.
export const DEFAULT_COSMETICS = Object.freeze({ badge: "none", trail: "normal", title: "wanderer" });

// Weapon slot 0..4 -> its mastery trail (F19.4).
export const WEAPON_TRAILS = Object.freeze(["jade", "azure", "amethyst", "rose", "amber"]);
const WEAPON_NAMES = Object.freeze(["Rifle", "Stinger", "Scatter", "Lancer", "Havoc"]);
export const WEAPON_IDS = Object.freeze(WEAPON_NAMES.map((name) => name.toLowerCase()));
export const MASTERY_KILL_TARGET = 75;
export const CHAIN_TARGET = 100;
export const ELITE_TARGET = 10;
export const RELIC_TARGET = Object.keys(RELICS).length;

// MASTERY & CHALLENGES entries in Journal order: the original eight, then the Wave-2 eight.
// `rewards` are [slot, value] pairs of COSMETICS.
const challenge = (id, title, description, target, rewards) =>
  Object.freeze({ id, title, description, target, rewards: Object.freeze(rewards.map((r) => Object.freeze(r))) });

export const CHALLENGES = Object.freeze([
  ...WEAPON_NAMES.map((name, i) =>
    challenge(`weapon-${WEAPON_IDS[i]}`, `${name} mastery`, `Credit ${MASTERY_KILL_TARGET} enemy kills to ${name} across runs.`, MASTERY_KILL_TARGET, [["trail", WEAPON_TRAILS[i]]]),
  ),
  challenge("clean-maw", "Untouched by Iron", "Defeat Iron Maw without taking damage during its encounter.", 1, [["badge", "iron"]]),
  challenge("cursed-victory", "Crowned in Curses", "Win a run after activating at least 3 skull statues.", 1, [["badge", "crown"], ["title", "cursebearer"]]),
  challenge("world-discoverer", "World Discoverer", "Discover the landmark in each of the 5 worlds.", LANDMARK_IDS.length, [["trail", "aurora"]]),
  challenge("keeper-bell", "Unmoved by the Bell", "Silence the Bellwether without taking toll damage.", 1, [["badge", "bell"]]),
  challenge("keeper-ember", "Quenched", "Deal at least half the Cinder Abbot's damage to its back.", 1, [["badge", "ember"]]),
  challenge("keeper-aegis", "Held Fire", "Defeat the Castellan without taking reflected damage.", 1, [["badge", "aegis"]]),
  challenge("crown-unmade", "The Crown Unmade", "Win after facing the shade of every keeper you broke, without taking shade damage.", 1, [["badge", "unmade"], ["title", "unmade"]]),
  challenge("omen-victory", "Omen-crowned", "Win a run with at least 3 Skull Omens active.", 1, [["badge", "omen"]]),
  challenge("chain-100", "Crownbreaker", `Reach a ${CHAIN_TARGET} Rift Chain.`, CHAIN_TARGET, [["badge", "chain"], ["title", "crownbreaker"]]),
  challenge("elite-10", "Rift-touched Hunter", `Slay ${ELITE_TARGET} rift-touched elites across runs.`, ELITE_TARGET, [["title", "hunter"]]),
  challenge("codex-relics", "Reliquary Keeper", "Take every relic across your runs.", RELIC_TARGET, [["badge", "keeper"]]),
]);
