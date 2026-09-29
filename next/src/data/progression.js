// Run-only build data. Nothing here grants permanent combat strength: every value is
// reset by a new run; the Journal only unlocks cosmetics and records.

export const PLAYER_DEFAULTS = Object.freeze({
  hp: 100,
  max: 100,
  xp: 0,
  next: 10,
  level: 1,
  speed: 6.4,
  damage: 1,
  rate: 1,
  pierce: 0,
  extra: 0,
  crit: 0.1,
  magnet: 3.8,
  regen: 0,
  radius: 0.45,
});
export const DASH = Object.freeze({ cooldown: 1.8, max: 2, duration: 0.22, speed: 27, invulnerability: 0.35 });
// Dash trail colour per equipped trail cosmetic.
export const TRAIL_COLORS = Object.freeze({ normal: "#81ffff", ember: "#f2af78", aurora: "#91cfff" });

// Ordinary level-up upgrades: [name, icon, card text]. Index = upgrade id.
export const UPGRADES = Object.freeze([
  Object.freeze({ id: 0, name: "Overclock", icon: "ϟ", text: "All weapons: fire 18% faster." }),
  Object.freeze({ id: 1, name: "Heavy rounds", icon: "✦", text: "All weapons: 25% more base damage." }),
  Object.freeze({ id: 2, name: "Forked chamber", icon: "⑂", text: "All weapons: one extra projectile." }),
  Object.freeze({ id: 3, name: "Phase armor", icon: "⬡", text: "Gain 20 max integrity and heal up to 45." }),
  Object.freeze({ id: 4, name: "Gravity well", icon: "◎", text: "Collect shards from farther away." }),
  Object.freeze({ id: 5, name: "Ghost rounds", icon: "➜", text: "Bullets pierce +1 target. No rocket penetration." }),
  Object.freeze({ id: 6, name: "Rush circuit", icon: "»", text: "Move 14% faster." }),
  Object.freeze({ id: 7, name: "Deadeye", icon: "◇", text: "Bullets and Havoc blasts: +15% critical chance, capped at 90%." }),
  Object.freeze({ id: 8, name: "Repair field", icon: "✚", text: "Recover 1 integrity each second." }),
]);
export const OFFENSE_UPGRADES = Object.freeze([0, 1, 2, 5, 7]);
export const CRIT_CAP = 0.9;

export function applyUpgrade(p, id) {
  switch (id) {
    case 0: p.rate *= 1.18; break;
    case 1: p.damage *= 1.25; break;
    case 2: p.extra++; break;
    case 3: p.max += 20; p.hp = Math.min(p.max, p.hp + 45); break;
    case 4: p.magnet += 2; break;
    case 5: p.pierce++; break;
    case 6: p.speed *= 1.14; break;
    case 7: p.crit = Math.min(CRIT_CAP, p.crit + 0.15); break;
    case 8: p.regen++; break;
  }
  return p;
}

// Spread of a volley whose ledger widens it (Severed Hand): never tighter than this.
export const WIDE_SPREAD = 0.08;

// One calculation path for combat AND card previews. `rules` (the Rules Ledger, IMPROVEMENTS
// F9.1; KEEPERS only) scales damage by playerDamage x projectileDamage, adds extraProjectiles
// and widens the spread; without it every number is the Wave-1 one.
export function shotStats(p, w, boons = {}, rules = null) {
  const spread = rules ? rules.mul("spread") : 1;
  return {
    interval: w.cooldown / p.rate / (boons.rapid ? 1.5 : 1),
    damage: rules ? w.damage * p.damage * rules.mul("playerDamage") * rules.mul("projectileDamage") : w.damage * p.damage,
    count: w.count + p.extra + (rules ? rules.sum("extraProjectiles") : 0),
    pierce: w.rocket ? 0 : w.pierce + p.pierce,
    crit: p.crit,
    spread: rules ? Math.max(w.spread * spread, spread > 1 ? WIDE_SPREAD : 0) : w.spread,
  };
}

// Mod-tuning constants for weapon mods and dash traits.
export const BALANCE = Object.freeze({
  splinter: 0.35,
  stormHits: 7,
  stormTargets: 3,
  stormRadius: 7,
  stormDamage: 0.7,
  graveRange: 8,
  graveFragments: 5,
  graveDamage: 0.6,
  scarLife: 1.4,
  scarTick: 0.3,
  scarDamage: 0.18,
  maxScars: 12,
  pullLife: 0.45,
  pullRadius: 5,
  pullSpeed: 7,
  maxPulls: 8,
  echoWindow: 2,
  echoDamage: 0.5,
  wakeLife: 2,
  wakeSlow: 0.6,
  maxWake: 24,
});

// Major weapon mods: index = the weapon slot it modifies.
export const MODS = Object.freeze([
  Object.freeze({ id: 0, name: "Splinter Rounds", weapon: "RIFLE", text: "First hit splits two 35% diagonal rounds. Splinters never split again." }),
  Object.freeze({ id: 1, name: "Storm Needle", weapon: "STINGER", text: "Seven connected trigger pulls chain to up to three nearby targets. Charge survives switching." }),
  Object.freeze({ id: 2, name: "Graveburst", weapon: "SCATTER", text: "A primary kill within 8m casts five 60% bone fragments. Once per trigger pull." }),
  Object.freeze({ id: 3, name: "Rift Scar", weapon: "LANCER", text: "Leaves a 1.4s damaging trace along its flight. Cover stops the scar." }),
  Object.freeze({ id: 4, name: "Event Horizon", weapon: "HAVOC", text: "Impact pulls ordinary enemies for 0.45s, then detonates once. Bosses resist." }),
]);

export const DASH_TRAITS = Object.freeze([
  Object.freeze({ id: "echo", name: "Rift Echo", blurb: "Repeat your next volley.", text: "Next fired volley within 2s repeats from your old position at 50% damage. Echoes cannot trigger weapon mods." }),
  Object.freeze({ id: "wake", name: "Void Wake", blurb: "Slow enemies behind you.", text: "Your traversed dash leaves a 2s slowing trail. Bosses resist; slows do not stack." }),
]);

export function createBuild() {
  return { mods: [], ordinary: {}, dash: null, charge: 0 };
}

// Powerups dropped by monsters. Durations in seconds; timers refresh, never stack strength.
export const POWERUPS = Object.freeze({
  speed: Object.freeze({ label: "SPEED BOOST", duration: 8, color: "#76bce3", shape: "gem" }),
  rapid: Object.freeze({ label: "RAPID FIRE", duration: 8, color: "#e4c16c", shape: "gem" }),
  execution: Object.freeze({ label: "INSTA KILL", duration: 5, color: "#d87e8c", shape: "ico" }),
  ward: Object.freeze({ label: "BONE WARD", duration: 10, color: "#d3d7ba", shape: "box" }),
  heal: Object.freeze({ label: "MEND +20", duration: 0, color: "#8fce95", shape: "ico" }),
});
export const DROPS = Object.freeze({ chance: 0.18, lifetime: 14, max: 4, pickupRadius: 1.35, wardShield: 30, heal: 20 });

export function createBoons() {
  return { speed: 0, rapid: 0, execution: 0, ward: 0, shield: 0 };
}
