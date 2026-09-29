// Rift Relics (ctx.relics, IMPROVEMENTS F9): run-only passives granted by keeper spoils, elite
// caches and the trial Reliquary. State lives on the run (run.relics = [{ id, via, t, stage }],
// run.relicState = per-relic scratch the HUD reads); every stat effect is the Rules Ledger source
// "relic:{id}", and the hooks below implement the rest. KEEPERS real and practice runs only:
// never ORIGINAL, the attract demo or the tutorial.
import { RELICS, RARITY_WEIGHTS, RELIC_TUNING as T } from "../data/relics.js";
import { weightedPick } from "../core/rng.js";
import { segmentHit } from "../core/util.js";
import { bossLike } from "./logic/combat.js";

const HAVOC = 4;
const PLAYER_RADIUS = 0.45;
const CHEST_HEIGHT = 1.2;
const LUNG_SOURCE = Object.freeze({ weapon: -1, kind: "phase", relic: true });
const EMBER_SOURCE = Object.freeze({ id: "Embers", label: "Ember Reliquary" });
const STILLWATER = "state:stillwater";

const relicOf = (id) => (Object.hasOwn(RELICS, id) ? RELICS[id] : null);
const weaponOf = (source) => (Number.isInteger(source?.weapon) ? source.weapon : -1);

// Offer weights for the stage (F9.2: cursed relics grow likelier from stage 4).
export const rarityWeights = (stage) => (stage >= RARITY_WEIGHTS.lateStage ? RARITY_WEIGHTS.late : RARITY_WEIGHTS.base);

// Up to n distinct relic ids from `pool` (relic rows), weighted by rarity, drawn from `rng`.
// There is no forced common.
export function pickRelics(rng, pool, n, stage) {
  const weights = rarityWeights(stage);
  const left = [...pool];
  const picked = [];
  while (picked.length < n && left.length) {
    const row = weightedPick(
      rng,
      left.map((def) => [def, weights[def.rarity] ?? 0]),
    );
    picked.push(row.id);
    left.splice(left.indexOf(row), 1);
  }
  return picked;
}

// The change a relic makes to max integrity (Leaden Heart +30, Glutton's Maw -20).
export const maxHpDelta = (def) => def.effects.reduce((sum, f) => (f.key === "maxHp" && f.op === "add" ? sum + f.value : sum), 0);

// Relics that may be offered to a player with `max` integrity: not owned, no max cut that would
// leave under 50, and no Black Candle while the Omen of Blood is active (F9.3).
export function offerPool(owned, max, bloodOmen) {
  return Object.values(RELICS).filter((def) => {
    if (owned.has(def.id) || (bloodOmen && def.id === "black_candle")) return false;
    const delta = maxHpDelta(def);
    return delta >= 0 || max + delta >= T.offerFloor;
  });
}

// Phase Lung's refund for one enemy struck mid-dash (F9.2): 0.3 s, at most 0.6 s per dash; none
// at full charges, from a keeper, or from an enemy that refunded within the last 3 s.
export function lungRefund(given, { full = false, keeper = false, since = Infinity } = {}) {
  if (full || keeper || since < T.lung.lockout) return 0;
  return Math.max(0, Math.min(T.lung.refund, T.lung.cap - given));
}

// Crown of Thorns' bleed per second: 3% of max integrity, at least 2.
export const thornsRate = (max) => Math.max(T.thorns.min, T.thorns.share * max);

export function createRelics(ctx) {
  const ids = new Set(); // owned ids of the bound run, mirrors run.relics
  const lung = { struck: new Set(), given: 0, last: new Map() }; // this dash; enemy id -> last refund time
  const hammered = new Set(); // props this dash has already set off
  const still = { x: 0, z: 0, time: 0, seeded: false };
  const embers = []; // live Ember Reliquary zones, oldest first
  const panel = { box: null, buttons: new Map() };
  let bound = null;
  let tickAt = NaN;

  const allowed = (run) => !!run && !run.original && !run.demo && !run.tutorial;
  const ground = (x, z) => ctx.world?.height?.(x, z) ?? 0;
  const hittable = (e) => !!e && !e.dead && e.hp > 0 && !e.fixed && !e.shade && (ctx.enemies?.isHittable?.(e) ?? !e.untargetable);

  // The run the relic state belongs to. A new run starts empty, with every hook reset.
  function state() {
    const run = ctx.run;
    if (!run) return null;
    if (run !== bound) {
      bound = run;
      run.relics ??= [];
      run.relicState ??= {};
      ids.clear();
      for (const r of run.relics) ids.add(r.id);
      resetHooks();
    }
    return run;
  }

  function resetHooks() {
    lung.struck.clear();
    lung.given = 0;
    lung.last.clear();
    hammered.clear();
    still.time = 0;
    still.seeded = false;
    embers.length = 0;
    tickAt = NaN;
  }

  const has = (id) => !!state() && ids.has(id);

  // grant(id, via): the ledger source "relic:{id}", bus "relic" { id, via }, a toast and the
  // relic sound. Refused for an owned or unknown relic and outside KEEPERS play.
  function grant(id, via = "reward") {
    const run = state();
    const def = relicOf(id);
    if (!def || !allowed(run) || ids.has(id)) return false;
    run.relics.push({ id, via, t: run.elapsed ?? 0, stage: run.stage });
    ids.add(id);
    if (id === "ferryman_coin") run.relicState.ferryman = "ready";
    if (id === "reaper_thread") run.relicState.reaper = 0;
    ctx.rules?.push?.({ id: `relic:${id}`, kind: "relic", label: def.name, icon: id, effects: def.effects });
    ctx.bus.emit("relic", { id, via });
    ctx.hud?.toast?.(`RELIC · ${def.name.toUpperCase()}`, { priority: 1 });
    ctx.audio?.fx?.("relic");
    syncPanel();
    return true;
  }

  // offer(n, via) -> up to n distinct relic ids on the "relics" stream; the caller fills the rest.
  function offer(n = 3) {
    const run = state();
    if (!allowed(run) || !(n > 0)) return [];
    const pool = offerPool(ids, run.player?.max ?? 0, !!ctx.rules?.has?.("omen:blood"));
    return pickRelics(run.stream("relics"), pool, n, run.stage);
  }

  // Ferryman's Coin: true (once per run) when lethal damage should leave the hero at 1.
  function cheatDeath() {
    const run = state();
    if (!run || !ids.has("ferryman_coin") || run.relicState.ferryman === "spent") return false;
    run.relicState.ferryman = "spent";
    const p = run.player;
    ctx.hud?.toast?.("THE FERRYMAN TAKES HIS COIN", { priority: 2 });
    if (p) ctx.fx?.ring?.(p.x, p.z, T.ferryman.color, T.ferryman.ring, 0.5);
    ctx.audio?.fx?.("relic", 1, { rate: 0.5 });
    return true;
  }

  // ---- dash sweeps (player.walk, every dash step) -------------------------------------------

  function onDashMove(a, b) {
    const run = state();
    if (!allowed(run) || !a || !b) return;
    if (ids.has("phase_lung")) lungSweep(run, a, b);
    if (ids.has("tithe_hammer")) hammerSweep(a, b);
  }

  // Phase Lung: every enemy the dash passes through takes 40 once per dash and gives back dash
  // recharge (lungRefund).
  function lungSweep(run, a, b) {
    const p = run.player;
    const list = run.enemies;
    const now = run.elapsed ?? 0;
    for (let i = 0, n = list.length; i < n; i++) {
      const e = list[i];
      if (!hittable(e) || lung.struck.has(e.id)) continue;
      if (!segmentHit(a.x, a.z, b.x, b.z, e.x, e.z, (e.def?.radius ?? 0.5) + PLAYER_RADIUS)) continue;
      lung.struck.add(e.id);
      const refund = lungRefund(lung.given, {
        full: p.dashCharges >= (ctx.player?.dashMax?.() ?? p.dashCharges),
        keeper: !!(e.keeper || e.boss || e.miniboss),
        since: now - (lung.last.get(e.id) ?? -Infinity),
      });
      ctx.combat?.hurtEnemy?.(e, T.lung.damage, false, LUNG_SOURCE);
      if (refund <= 0) continue;
      lung.given += refund;
      lung.last.set(e.id, now);
      p.dashCD -= refund;
    }
  }

  // Tithe Hammer: a live prop the dash crosses goes off at once; the dash phases the blast.
  function hammerSweep(a, b) {
    const volumes = ctx.hazards?.hitVolumes?.();
    if (!volumes?.length) return;
    for (let i = 0, n = volumes.length; i < n; i++) {
      const v = volumes[i];
      if (!v?.o || hammered.has(v.o.id) || !segmentHit(a.x, a.z, b.x, b.z, v.x, v.z, v.r + PLAYER_RADIUS)) continue;
      hammered.add(v.o.id);
      ctx.hazards.detonate?.(v.o, { player: true, fuse: 0, hammer: true });
    }
  }

  // ---- damage hooks -------------------------------------------------------------------------

  // Citadel Frost: 0.7 while a frost from a hit lasts (read by enemies.slowMul).
  function slowOf(e) {
    return ids.has("citadel_frost") && e?.frostUntil > (ctx.run?.elapsed ?? 0) ? T.frost.slow : 1;
  }

  // Silt Boots: player damage x1.2 on slowed monsters (pipeline step 4).
  function hitMul(e, source) {
    if (!ids.has("silt_boots") || weaponOf(source) < 0) return 1;
    return (ctx.enemies?.slowMul?.(e) ?? 1) < 1 ? T.silt.damage : 1;
  }

  // Ember Reliquary: a Havoc blast (never a relic burst) leaves burning ground; at most 6 live.
  function onBlast(x, z, source) {
    if (!has("ember_reliquary") || source?.relic || weaponOf(source) !== HAVOC) return;
    for (let i = embers.length - 1; i >= 0; i--) if (embers[i].dead) embers.splice(i, 1);
    while (embers.length >= T.ember.live) ctx.combat?.removeZone?.(embers.shift());
    const zone = ctx.combat?.zone?.(x, z, T.ember.radius, {
      life: T.ember.life,
      tick: T.ember.tick,
      monsterDamage: T.ember.damage,
      friendly: true,
      weapon: HAVOC,
      relic: true,
      owner: "relic",
      visual: "embers",
      source: EMBER_SOURCE,
    });
    if (zone) embers.push(zone);
  }

  // Citadel Frost and Witch Glass react to every hit.
  function onEnemyHit({ e, critical, source, preExec } = {}) {
    const run = state();
    if (!e || !run?.relics.length) return;
    if (ids.has("citadel_frost") && e.hp > 0 && e.hp < T.frost.below * e.max && !bossLike(e)) e.frostUntil = (run.elapsed ?? 0) + T.frost.seconds;
    if (ids.has("witch_glass") && critical && source?.relic !== true && preExec > 0)
      ctx.combat?.explode?.(e.x, e.z, T.glass.radius, Math.min(e.max, T.glass.share * preExec), false, ground(e.x, e.z) + CHEST_HEIGHT, {
        weapon: weaponOf(source),
        relic: true,
        noCrit: true,
        noMods: true,
        ring: T.glass.color,
      });
  }

  // Reaper's Thread: every 40th kill that is not itself a nova kill releases a bone nova.
  function onEnemyKilled({ source } = {}) {
    const run = state();
    if (!run || !ids.has("reaper_thread") || source?.nova) return;
    const count = (run.relicState.reaper ?? 0) + 1;
    run.relicState.reaper = count % T.reaper.every;
    const p = run.player;
    if (count < T.reaper.every || !p) return;
    ctx.combat?.explode?.(p.x, p.z, T.reaper.radius, T.reaper.damage, false, ground(p.x, p.z) + CHEST_HEIGHT, {
      weapon: -1,
      relic: true,
      nova: true,
      noCrit: true,
      noMods: true,
      ring: T.reaper.color,
    });
    ctx.audio?.fx?.("explosion", 0.6, p);
  }

  // Quarry Bell: every Rift Surge grants RAPID FIRE (Red Hourglass stretches it).
  function onSurge() {
    const run = state();
    if (!run?.boons || !ids.has("quarry_bell")) return;
    run.boons.rapid = Math.max(run.boons.rapid || 0, T.quarryBell.rapid * (ctx.rules?.mul?.("boonDuration") ?? 1));
  }

  function onLevelUp() {
    if (has("grave_dirt")) ctx.player?.heal?.(T.graveDirt.heal, "relic");
  }

  // A new dash: Phase Lung and Tithe Hammer sweep afresh, and Stillwater's stillness breaks.
  function onDash() {
    const run = state();
    if (!run?.relics.length) return;
    lung.struck.clear();
    lung.given = 0;
    hammered.clear();
    still.time = 0;
    setStill(run, false);
  }

  // ---- per step (player.update drives it) ---------------------------------------------------

  // Stillwater Idol and Crown of Thorns. Idempotent per simulation step.
  function tick(dt) {
    const run = state();
    if (!run?.relics.length || !allowed(run) || !(dt > 0)) return;
    const now = run.elapsed ?? 0;
    if (now === tickAt) return;
    tickAt = now;
    const p = run.player;
    if (!p || p.hp <= 0) return;
    if (ids.has("stillwater_idol")) stillness(run, p, dt);
    if (ids.has("crown_thorns")) thorns(run, p, dt);
  }

  // Still means under 0.2 m/s and not dashing; 0.6 s of it raises +30% damage until the hero
  // moves or dashes.
  function stillness(run, p, dt) {
    const speed = still.seeded ? Math.hypot(p.x - still.x, p.z - still.z) / dt : 0;
    still.x = p.x;
    still.z = p.z;
    still.seeded = true;
    if (speed < T.still.speed && !(p.dashing > 0)) {
      still.time += dt;
      if (still.time >= T.still.after - 1e-9) setStill(run, true);
    } else {
      still.time = 0;
      setStill(run, false);
    }
  }

  function setStill(run, on) {
    if (!!run.relicState.stillwater === on) return;
    run.relicState.stillwater = on;
    if (on)
      ctx.rules?.push?.({
        id: STILLWATER,
        kind: "state",
        label: RELICS.stillwater_idol.name,
        icon: "stillwater_idol",
        effects: [{ key: "playerDamage", op: "mul", value: T.still.damage }],
      });
    else ctx.rules?.pop?.(STILLWATER);
  }

  // Any hostile within 4 m bleeds the hero (never below 1, never a hit) and stops kill heals and
  // regeneration (player.heal reads relicState.thornsDraining).
  function thorns(run, p, dt) {
    let near = false;
    const list = run.enemies;
    for (let i = 0; i < list.length && !near; i++) {
      const e = list[i];
      near = hittable(e) && Math.hypot(e.x - p.x, e.z - p.z) < T.thorns.reach;
    }
    run.relicState.thornsDraining = near;
    if (near) ctx.player?.drain?.(thornsRate(p.max) * dt);
  }

  // Run start: every hook forgets the old run (its relics stay on it for the report).
  function clear() {
    bound = null;
    ids.clear();
    resetHooks();
  }

  // ---- practice: ?practice=relics (stage 2 plus the GRANT panel) ----------------------------

  function buildPanel() {
    const doc = globalThis.document;
    const root = doc?.querySelector?.("#devTools");
    if (!root || panel.box) return;
    panel.box = doc.createElement("details");
    panel.box.id = "devRelics";
    panel.box.open = true;
    const summary = doc.createElement("summary");
    summary.textContent = "RELICS · GRANT";
    panel.box.append(summary);
    for (const def of Object.values(RELICS)) {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = def.name;
      button.title = `${def.rarity.toUpperCase()} · ${def.text}`;
      button.addEventListener("click", () => grant(def.id, "practice"));
      panel.buttons.set(def.id, button);
      panel.box.append(button);
    }
    root.append(panel.box);
  }

  // The panel shows in the relics scenario, with owned relics greyed out.
  function syncPanel() {
    if (!panel.box) return;
    panel.box.hidden = ctx.run?.scenario !== "relics";
    for (const [id, button] of panel.buttons) button.disabled = ids.has(id);
  }

  ctx.bus.on("dash", onDash);
  ctx.bus.on("surge", onSurge);
  ctx.bus.on("levelUp", onLevelUp);
  ctx.bus.on("enemyHit", onEnemyHit);
  ctx.bus.on("enemyKilled", onEnemyKilled);
  ctx.bus.on("runStart", () => {
    state();
    syncPanel();
  });
  ctx.bus.on("practice", ({ register } = {}) =>
    register?.(
      "relics",
      () => {
        buildPanel();
        syncPanel();
      },
      { stage: 2 },
    ),
  );

  return {
    has,
    // owned() -> [{ id, via, t, stage }] in grant order.
    owned: () => [...(state()?.relics ?? [])],
    grant,
    offer,
    cheatDeath,
    onDashMove,
    slowOf,
    hitMul,
    onBlast,
    tick,
    clear,
  };
}
