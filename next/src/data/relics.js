// Rift Relics (IMPROVEMENTS F9.2): run-only passives. `effects` are Rules Ledger entries
// ({ key, op: "mul" | "add" | "flag", value }, canonical keys in F9.1); `hook` names the code
// path that implements the rest (game/relics.js). Every id has an icon bitmap in data/icons.js.
const effect = (key, op, value) => Object.freeze({ key, op, value });
const mul = (key, value) => effect(key, "mul", value);
const add = (key, value) => effect(key, "add", value);
const flag = (key) => effect(key, "flag", true);
// Cursed relics also pay +10 Rift Score points (F11).
const CURSE_BONUS = add("scoreMult", 10);

function relic(id, name, rarity, text, effects = [], hook = null) {
  const all = rarity === "cursed" ? [...effects, CURSE_BONUS] : effects;
  return Object.freeze({ id, name, rarity, text, effects: Object.freeze(all), hook });
}

export const RELICS = Object.freeze(
  Object.fromEntries(
    [
      relic("lodestone_eye", "Lodestone Eye", "common", "Shards within 12m drift to you at 2 m/s, even outside your magnet.", [], "gems"),
      relic("quarry_bell", "Quarry Bell", "common", "Every Rift Surge grants 4s of RAPID FIRE.", [], "surge"),
      relic("pilgrim_salts", "Pilgrim Salts", "common", "Landmark recovery heals 30 instead of 12 and grants BONE WARD.", [], "landmark"),
      relic("bone_lantern", "Bone Lantern", "common", "Powerup drop chance 18% to 22%. Pickups last 20s.", [mul("dropChance", 1.22), mul("dropLifetime", 1.43)]),
      relic("leaden_heart", "Leaden Heart", "common", "+30 max integrity (heals 30). Move 5% slower.", [add("maxHp", 30), mul("moveSpeed", 0.95)]),
      relic("citadel_frost", "Citadel Frost", "common", "Hits on enemies below 30% health slow them to 70% speed for 1s. Keepers resist.", [], "frost"),
      relic("grave_dirt", "Grave Dirt", "common", "Each level-up heals 8 integrity.", [], "levelUp"),
      relic("warden_splinter", "Warden's Splinter", "common", "+20% damage to keepers, elites, anchors and nodes.", [mul("bossDamage", 1.2)]),
      relic("tithe_hammer", "Tithe Hammer", "common", "Dashing into a hazard prop sets it off at once. Your dash carries you through the blast.", [], "dashSweep"),
      relic("ash_salts", "Ash Salts", "common", "Lava and cinders no longer burn you. Kill heals are halved.", [flag("burnImmune"), mul("killHealMult", 0.5)]),
      relic("silt_boots", "Silt Boots", "common", "Slowing ground never slows you. Slowed monsters take 20% more damage from you.", [flag("slowImmune")], "hitMul"),
      relic("hunters_mark", "Hunter's Mark", "common", "Molten and Shardborn death bursts never hurt you. The radar shows elites at any range.", [flag("eliteBurstSafe")], "radar"),
      relic("hollow_crown", "Hollow Crown Shard", "rare", "+1 dash charge.", [add("dashCharges", 1)]),
      relic("witch_glass", "Witch Glass", "rare", "Critical hits burst for 30% of the hit in 1.6m. Bursts cannot crit or trigger mods.", [], "critBurst"),
      relic("ferryman_coin", "Ferryman's Coin", "rare", "Once per run, lethal damage leaves you at 1 integrity with 2s invulnerability. The coin shatters.", [], "cheatDeath"),
      relic("stillwater_idol", "Stillwater Idol", "rare", "After standing still for 0.6s, deal +30% damage until you move or dash.", [], "stillness"),
      relic("ember_reliquary", "Ember Reliquary", "rare", "Your Havoc blasts leave burning ground for 2.5s (2m, 10 damage every 0.5s).", [], "havocZone"),
      relic("phase_lung", "Phase Lung", "rare", "Dashing through an enemy deals 40 damage and gives back up to 0.6s of dash recharge per dash.", [], "dashSweep"),
      relic("reaper_thread", "Reaper's Thread", "rare", "Every 40th kill releases a bone nova: 60 damage to enemies within 8m.", [], "reaper"),
      relic("glutton_maw", "Glutton's Maw", "cursed", "Shards are worth 30% more XP. -20 max integrity.", [mul("xpMult", 1.3), add("maxHp", -20)]),
      relic("red_hourglass", "Red Hourglass", "cursed", "Speed, Rapid Fire and Bone Ward last twice as long. You take 15% more damage.", [mul("boonDuration", 2), mul("damageTaken", 1.15)]),
      relic("crown_thorns", "Crown of Thorns", "cursed", "+25% damage. While any enemy is within 4m you bleed 3% of your max integrity per second (at least 2) and cannot heal.", [mul("playerDamage", 1.25)], "thorns"),
      relic("severed_hand", "Severed Hand", "cursed", "+1 projectile for every weapon. -40% damage per projectile. Wider spread.", [add("extraProjectiles", 1), mul("projectileDamage", 0.6), mul("spread", 1.5)]),
      relic("black_candle", "Black Candle", "cursed", "Chain multipliers +0.25. Any hit breaks your chain, even one your ward absorbs.", [add("chainTierBonus", 0.25), flag("chainBreakOnWard")]),
    ].map((row) => [row.id, row]),
  ),
);

// Offer weights by rarity; from stage `lateStage` on, the late row applies.
export const RARITY_WEIGHTS = Object.freeze({
  base: Object.freeze({ common: 60, rare: 28, cursed: 12 }),
  late: Object.freeze({ common: 50, rare: 36, cursed: 14 }),
  lateStage: 4,
});

// Card chip border per rarity (F9.3; P8 renders).
export const RARITY_COLORS = Object.freeze({ common: "#ded6be", rare: "#91cfff", cursed: "#cd7767" });
export const CURSED_TAG = "CURSED · +10% RIFT SCORE";

// The numbers behind each hook (F9.2). Lodestone Eye and Pilgrim Salts are read by encounters.
export const RELIC_TUNING = Object.freeze({
  offerFloor: 50, // relics that cut max integrity are not offered below this projected max
  lodestone: Object.freeze({ reach: 12, speed: 2 }),
  quarryBell: Object.freeze({ rapid: 4 }),
  pilgrim: Object.freeze({ heal: 30 }),
  frost: Object.freeze({ below: 0.3, slow: 0.7, seconds: 1 }),
  graveDirt: Object.freeze({ heal: 8 }),
  silt: Object.freeze({ damage: 1.2 }),
  glass: Object.freeze({ share: 0.3, radius: 1.6, color: "#f0e6ff" }),
  ferryman: Object.freeze({ invulnerability: 2, color: "#d4bc78", ring: 4 }),
  still: Object.freeze({ speed: 0.2, after: 0.6, damage: 1.3 }),
  ember: Object.freeze({ radius: 2, life: 2.5, tick: 0.5, damage: 10, live: 6 }),
  lung: Object.freeze({ damage: 40, refund: 0.3, cap: 0.6, lockout: 3 }),
  reaper: Object.freeze({ every: 40, radius: 8, damage: 60, color: "#d9d2b0" }),
  thorns: Object.freeze({ reach: 4, share: 0.03, min: 2 }),
});
