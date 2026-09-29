// The Rules Ledger (ctx.rules, IMPROVEMENTS F9.1): one registry of stat and flag modifiers
// behind relics, omens and toggled hook states. Readers ask mul(key) / sum(key) / flag(key)
// with the canonical keys below; each value is cached per key and rebuilt only after a push or
// a pop. Run-only: director.start() clears it and nothing here is ever persisted.

// The canonical keys and the operation each one is read with (F9.1). Every key has a source in
// RELICS or OMENS, and every data effect names one of these (tests/rules.test.mjs).
export const RULE_KEYS = Object.freeze({
  // player (P4)
  moveSpeed: "mul",
  maxHp: "add",
  dashCharges: "add",
  damageTaken: "mul",
  playerDamage: "mul",
  projectileDamage: "mul",
  extraProjectiles: "add",
  spread: "mul",
  bossDamage: "mul",
  xpMult: "mul",
  burnImmune: "flag",
  slowImmune: "flag",
  eliteBurstSafe: "flag",
  // heals (P6)
  killHealMult: "mul",
  stageHeal: "add",
  surgeHeal: "mul",
  // enemies (P3, P6)
  enemySpeed: "mul",
  enemyContact: "mul",
  enemyShotSpeed: "mul",
  spawnInterval: "mul",
  liveCap: "add",
  keeperLiveCap: "add",
  surgeExtra: "add",
  eliteChance: "mul",
  // drops (P5)
  dropChance: "mul",
  dropLifetime: "mul",
  boonDuration: "mul",
  // scoring (P9)
  scoreMult: "add",
  chainTierBonus: "add",
  chainBreakOnWard: "flag",
  // view (P8, P7)
  fogMult: "mul",
  darkBars: "flag",
});

const OPS = new Set(["mul", "add", "flag"]);
const validEffect = (f) => !!f && typeof f.key === "string" && OPS.has(f.op) && (f.op === "flag" || Number.isFinite(f.value));
const toEffect = (f) => Object.freeze({ key: f.key, op: f.op, value: f.op === "flag" ? f.value !== false : f.value });

export function createRules(ctx) {
  const sources = new Map(); // id -> frozen source, in push order
  const muls = new Map();
  const sums = new Map();
  const flags = new Map();

  function changed() {
    muls.clear();
    sums.clear();
    flags.clear();
    ctx.bus?.emit?.("rules", { list: list() });
  }

  // push({ id: "relic:witch_glass", kind: "relic" | "omen" | "state", label, icon,
  // effects: [{ key, op: "mul" | "add" | "flag", value }] }) replaces a source with the same id.
  function push(source) {
    if (!source || typeof source.id !== "string" || !source.id) return false;
    const effects = Array.isArray(source.effects) ? source.effects.filter(validEffect).map(toEffect) : [];
    sources.delete(source.id);
    sources.set(
      source.id,
      Object.freeze({
        id: source.id,
        kind: source.kind ?? "state",
        label: source.label ?? source.id,
        icon: source.icon ?? null,
        effects: Object.freeze(effects),
      }),
    );
    changed();
    return true;
  }

  function pop(id) {
    if (!sources.delete(id)) return false;
    changed();
    return true;
  }

  // Product of every "mul" effect on `key` (1 with none).
  function mul(key) {
    if (!sources.size) return 1;
    let value = muls.get(key);
    if (value === undefined) {
      value = 1;
      for (const s of sources.values()) for (const f of s.effects) if (f.key === key && f.op === "mul") value *= f.value;
      muls.set(key, value);
    }
    return value;
  }

  // Sum of every "add" effect on `key` (0 with none).
  function sum(key) {
    if (!sources.size) return 0;
    let value = sums.get(key);
    if (value === undefined) {
      value = 0;
      for (const s of sources.values()) for (const f of s.effects) if (f.key === key && f.op === "add") value += f.value;
      sums.set(key, value);
    }
    return value;
  }

  // True when any source sets the flag.
  function flag(key) {
    if (!sources.size) return false;
    let value = flags.get(key);
    if (value === undefined) {
      value = false;
      for (const s of sources.values()) for (const f of s.effects) if (f.key === key && f.op === "flag" && f.value) value = true;
      flags.set(key, value);
    }
    return value;
  }

  // [{ id, kind, label, icon }] for the HUD, the pause summary and the report. Toggled hook
  // states (kind "state") are listed only when asked for by kind.
  function list(kind) {
    const out = [];
    for (const s of sources.values()) if (kind ? s.kind === kind : s.kind !== "state") out.push({ id: s.id, kind: s.kind, label: s.label, icon: s.icon });
    return out;
  }

  // Run start: every source goes with the old run. Listeners reset on "runStart", so no
  // "rules" event is sent for the old run.
  function clear() {
    sources.clear();
    muls.clear();
    sums.clear();
    flags.clear();
  }

  return {
    push,
    pop,
    has: (id) => sources.has(id),
    mul,
    sum,
    flag,
    list,
    clear,
  };
}
