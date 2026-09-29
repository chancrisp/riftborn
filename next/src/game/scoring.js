// Rift Chain and Rift Score (ctx.scoring, IMPROVEMENTS F11): the chain, feats, the banked
// multiplier M, overtime and the per-stage snapshots, all in run.rift (null under ORIGINAL,
// in the tutorial and in the demo). The base score (run.score) is never touched.
//
// Everything is driven by bus events (kills, hits, bosses, trials, props) and measured on
// run.elapsed, which advances only in play simulation steps: cards, sequences, pause and
// hit-stop freeze the chain timer and every window. Each entry point first brings the state up
// to the current elapsed (sync), so a rule always sees the clock of its own event; tick() lets
// the director do the same once per step, so a chain ends on the step its window runs out.
import { CHAIN, FEATS, FEAT_RULES, OVERTIME, STATUE_POINTS, TIERS, overtimeFactor, points, riftMultiplier, tierOf } from "../data/scoring.js";
import { KEEPERS } from "../data/keepers.js";
import { WEAPONS } from "../data/weapons.js";

const LANCER = WEAPONS.findIndex((w) => w.label === "LANCER");
const TIMELINE_STEP = 10; // seconds of elapsed between Rift Score samples
const EPS = 1e-6;
// The keeper feats pay with the M taken at keeper spawn (run.keeper.mSnapshot); BAITED and
// INTERRUPTED always belong to the Maw and the Warden.
const KEEPER_FEATS = new Set(["unscathed", "baited", "interrupted"]);
const FEAT_KEEPER = Object.freeze({ baited: "ironmaw", interrupted: "warden" });
const CHAIN_RING = Object.freeze({ kind: "runner", count: 60, radius: 10 });

const isElite = (e) => Array.isArray(e?.elite) && e.elite.length > 0;
const isWarden = (e) => e?.boss === "warden" || e?.kind === "warden";
// Keepers, bosses, elites and trial rosters pay in full in overtime; the ambient trickle,
// surges and summons fade (F11).
const fadesInOvertime = (e) => !(e.keeper || e.boss || e.miniboss || isElite(e) || e.trialElite || e.trialId);
// HP actually lost by a "playerHit" (Bone Ward absorption excluded).
const hpLost = ({ amount = 0, absorbed = 0 } = {}) => (typeof absorbed === "number" ? amount - absorbed > 0 : !absorbed && amount > 0);

function createRift() {
  return {
    score: 0,
    killPart: 0,
    chainPart: 0,
    featPart: 0,
    chain: { count: 0, timer: 0, window: CHAIN.window, tier: 0, best: 0 },
    feats: {},
    phasedThisStage: 0,
    overtime: null, // { start, grace } after the goal, the portal, the dais or a keeper spawn
    timeline: [], // rift score at every TIMELINE_STEP seconds of elapsed
    stage: 0, // the stage the snapshots below belong to
    fading: false, // past the overtime grace: the chain line reads RIFT UNSTABLE
  };
}

// Per-run bookkeeping that never leaves this module.
function trackers() {
  return {
    synced: 0, // run.elapsed at the last sync
    nextSample: TIMELINE_STEP,
    stageM: 1, // M at stage entry (UNTOUCHED)
    stageClean: true, // no HP lost and no drain this stage
    untouchedPaid: new Set(),
    massacre: null, // { start, kills }
    skewers: new Map(), // shot id -> { kills, at }
    gasp: null, // { at, kills } after a real hit left the player at <= 15%
    gaspPaid: false,
    phasedAt: -Infinity,
    trialStart: null,
    fights: new Map(), // keeper kind -> { m, untouched } (fallback when run.keeper is absent)
  };
}

export function createScoring(ctx) {
  const bus = ctx.bus;
  let t = trackers();

  const liveRift = () => ctx.run?.rift ?? null;

  // M = max(0.1, 1 + (ledger scoreMult + 10 × statues) / 100); 1 under ORIGINAL.
  function multiplier() {
    const run = ctx.run;
    if (!run || run.original) return 1;
    return riftMultiplier((ctx.rules?.sum?.("scoreMult") ?? 0) + STATUE_POINTS * (run.statueCount || 0));
  }

  const total = (r) => (r.score = r.killPart + r.chainPart + r.featPart);
  const pastGrace = (run, r) => !!r.overtime && run.elapsed - r.overtime.start > r.overtime.grace;

  // ---- clock ------------------------------------------------------------------------------

  function sync() {
    const r = liveRift();
    if (!r) return null;
    const run = ctx.run,
      now = run.elapsed,
      dt = now - t.synced;
    if (dt > 0) {
      t.synced = now;
      decay(run, r, dt);
    }
    closeMassacre(now);
    settleSkewers(run, now);
    while (now >= t.nextSample) {
      r.timeline.push(r.score);
      t.nextSample += TIMELINE_STEP;
    }
    r.fading = pastGrace(run, r);
    return r;
  }

  function decay(run, r, dt) {
    const c = r.chain;
    if (c.count <= 0) return;
    c.timer -= dt;
    if (c.timer <= 0) breakChain(run, r, "end");
  }

  // The chain ENDS when its window runs out and is SEVERED by a hit; either way the count and
  // tier reset and the LAST GASP count (one chain) starts over.
  function breakChain(run, r, event) {
    const c = r.chain;
    if (c.count <= 0) return;
    const count = c.count,
      tier = c.tier;
    c.count = c.tier = c.timer = 0;
    if (t.gasp) t.gasp.kills = 0;
    const breaks = run.stats?.chainBreaks;
    if (breaks) breaks[event === "end" ? "ended" : "severed"] += 1;
    bus.emit("chain", { event, count, tier });
  }

  // ---- feats ------------------------------------------------------------------------------

  // The M a feat pays with: stage entry for UNTOUCHED, keeper spawn for the keeper feats, else
  // the live M.
  function featM(id, kind) {
    if (id === "untouched") return t.stageM;
    if (!KEEPER_FEATS.has(id)) return multiplier();
    kind ??= FEAT_KEEPER[id] ?? null;
    const keeper = ctx.run.keeper;
    const live = keeper && (!kind || keeper.id === kind) ? keeper : null;
    return live?.mSnapshot ?? t.fights.get(kind)?.m ?? multiplier();
  }

  // Pays a feat into featPart (never past the overtime grace for PHASED). Returns the bonus.
  function grant(id, args = {}, kind = null) {
    const run = ctx.run,
      r = run?.rift,
      feat = FEATS[id];
    if (!r || !feat || (id === "phased" && pastGrace(run, r))) return 0;
    const raw = feat.bonus(args);
    if (!(raw > 0)) return 0;
    const bonus = points(raw * featM(id, kind));
    r.featPart += bonus;
    total(r);
    r.feats[id] = (r.feats[id] || 0) + 1;
    bus.emit("feat", { id, bonus, cue: feat.cue });
    return bonus;
  }

  function award(id, args) {
    return sync() ? grant(id, args) : 0;
  }

  // MASSACRE: >= 4 kills within 0.3 s of the first, paid when that window closes.
  function closeMassacre(now) {
    const m = t.massacre;
    if (!m || now - m.start < FEAT_RULES.massacre.window - EPS) return;
    t.massacre = null;
    if (m.kills >= FEAT_RULES.massacre.kills) grant("massacre", { kills: m.kills });
  }

  function countMassacre(now) {
    t.massacre ??= { start: now, kills: 0 };
    t.massacre.kills += 1;
  }

  // SKEWER: one generation-0 Lancer shot (source.shot) kills >= 3. A shot pierces over several
  // steps, so its tally settles once the shot is spent and a step has passed.
  function countSkewer(source, now) {
    if (source.weapon !== LANCER || (source.generation ?? 0) !== 0 || source.shot == null) return;
    const s = t.skewers.get(source.shot);
    if (s) {
      s.kills += 1;
      s.at = now;
    } else t.skewers.set(source.shot, { kills: 1, at: now });
  }

  function settleSkewers(run, now) {
    if (!t.skewers.size) return;
    for (const [id, s] of t.skewers) {
      if (now <= s.at || shotLive(run, id)) continue;
      t.skewers.delete(id);
      if (s.kills >= FEAT_RULES.skewer.kills) grant("skewer", { kills: s.kills });
    }
  }

  function shotLive(run, id) {
    const shots = run.shots;
    if (!shots) return false;
    for (let i = 0; i < shots.length; i++) if (shots[i].id === id && shots[i].life > 0 && !shots[i].retired) return true;
    return false;
  }

  // LAST GASP: 5 kills in one chain at <= 15% integrity, that state reached by a real hit in
  // the last 10 s (never by drain). Once per stage.
  function countGasp(run, now) {
    const g = t.gasp,
      p = run.player,
      rule = FEAT_RULES.lastgasp;
    if (!g || t.gaspPaid || !p) return;
    if (now - g.at > rule.recent || !(p.hp <= rule.integrity * p.max)) {
      t.gasp = null;
      return;
    }
    g.kills += 1;
    if (g.kills < rule.kills) return;
    t.gaspPaid = true;
    t.gasp = null;
    grant("lastgasp");
  }

  // UNTOUCHED: the stage ended (portal entry, or the Warden's kill on stage 5) with no HP lost
  // and no drain.
  function untouched(stage) {
    if (!t.stageClean || t.untouchedPaid.has(stage)) return;
    t.untouchedPaid.add(stage);
    grant("untouched", { stage });
  }

  // ---- kills ------------------------------------------------------------------------------

  // On "enemyKilled", after director.onKill. Kills of the player's own bursts and environment
  // kills the player did not trigger (lava, cinders, fissures, rockfall) never feed the chain.
  function onKill({ e, source } = {}) {
    const r = sync(),
      run = ctx.run;
    if (!r || !e || e.fixed || (run.over && !run.victory)) return;
    source ??= {};
    const now = run.elapsed;
    if (isElite(e)) grant("riftbane"); // every rift-touched body, whoever felled it (F8)
    if (isWarden(e)) untouched(run.stage);
    countSkewer(source, now);
    if (source.kind === "self" || (source.environment && !source.player)) return;
    const f = r.overtime && fadesInOvertime(e) ? overtimeFactor(now - r.overtime.start, r.overtime.grace) : 1;
    if (f <= 0) return; // nothing paid, and the chain neither grows nor refreshes
    payKill(run, r, e.def?.score || 0, f);
    countMassacre(now);
    countGasp(run, now);
  }

  // The tier multiplier is the one held BEFORE this kill counts; M is this moment's (banked).
  function payKill(run, r, base, f) {
    const c = r.chain,
      m = multiplier(),
      tier = c.tier,
      tierMult = TIERS[tier].mult + (tier >= 1 ? (ctx.rules?.sum?.("chainTierBonus") ?? 0) : 0),
      plain = points(base * m * f),
      gained = points(base * tierMult * m * f);
    r.killPart += plain;
    r.chainPart += gained - plain;
    total(r);
    c.count += 1;
    c.timer = c.window;
    c.best = Math.max(c.best, c.count);
    if (run.stats) run.stats.chainBest = c.best;
    const next = tierOf(c.count);
    if (next <= tier) return;
    c.tier = next;
    bus.emit("chain", { event: "tier", tier: next, count: c.count });
  }

  // ---- hits -------------------------------------------------------------------------------

  // Real HP loss severs the chain (any hit with the chainBreakOnWard ledger flag, even one
  // the ward absorbed), clears the stage's and every live fight's untouched state, and arms
  // LAST GASP when it leaves the player at <= 15%.
  function onPlayerHit(payload = {}) {
    const r = sync(),
      run = ctx.run;
    if (!r) return;
    const lost = hpLost(payload);
    if (lost) spoil();
    if (lost || ctx.rules?.flag?.("chainBreakOnWard")) breakChain(run, r, "sever");
    const p = run.player;
    if (lost && p && p.hp > 0 && p.hp <= FEAT_RULES.lastgasp.integrity * p.max && !t.gaspPaid) t.gasp = { at: run.elapsed, kills: 0 };
  }

  function spoil() {
    t.stageClean = false;
    for (const fight of t.fights.values()) fight.untouched = false;
  }

  // PHASED: a dash's invulnerability took a hit. At most one per 0.5 s and ten per stage;
  // Tithe Hammer blasts (dashing into a prop on purpose) never count.
  function onPhased(payload = {}) {
    const r = sync(),
      run = ctx.run,
      rule = FEAT_RULES.phased;
    if (!r || payload.tithe || payload.source?.tithe) return;
    if (r.phasedThisStage >= rule.perStage || run.elapsed - t.phasedAt < rule.gap - EPS || pastGrace(run, r)) return;
    t.phasedAt = run.elapsed;
    r.phasedThisStage += 1;
    grant("phased");
  }

  // ---- keepers, trials, props -------------------------------------------------------------

  // Keepers (Wave-1 Maw and Warden included): spawn starts the 90 s grace and snapshots M;
  // an Iron Maw stagger (a charge baited into cover or a wall) is BAITED; a keeper felled
  // without real HP loss since its spawn is UNSCATHED.
  function onBoss({ kind, event } = {}) {
    const r = sync(),
      run = ctx.run;
    if (!r || !KEEPERS[kind]) return;
    if (event === "spawn") {
      t.fights.set(kind, { m: multiplier(), untouched: true });
      startOvertime(r, "keeper");
    } else if (event === "stagger" && kind === "ironmaw") grant("baited", {}, kind);
    else if (event === "defeat") {
      const fight = run.keeper?.id === kind ? run.keeper : t.fights.get(kind);
      if (fight?.untouched === true) grant("unscathed", {}, kind);
      t.fights.delete(kind);
    }
  }

  function onTrial({ state } = {}) {
    const r = sync();
    if (!r) return;
    if (state === "active") t.trialStart = ctx.run.elapsed;
    else if (state === "complete" && t.trialStart !== null && ctx.run.elapsed - t.trialStart <= FEAT_RULES.swift.seconds + EPS) grant("swift");
    if (state !== "active") t.trialStart = null;
  }

  function onProp({ event, kills = 0 } = {}) {
    if (event === "blast" && kills >= FEAT_RULES.detonation.kills && sync()) grant("detonation", { kills });
  }

  // ---- overtime and stages ----------------------------------------------------------------

  function startOvertime(r, kind) {
    const grace = OVERTIME.grace[kind];
    if (grace > 0) r.overtime = { start: ctx.run.elapsed, grace };
  }

  // "portal": the goal is met, the portal opens or the dais wakes (45 s); "keeper": a keeper
  // spawns (90 s). Each call replaces the last; stage entry clears it.
  function overtime(kind) {
    const r = sync();
    if (r) startOvertime(r, kind);
  }

  // Stage entry (idempotent per stage): pays UNTOUCHED for the stage the portal ended, then
  // takes the new stage's snapshots. A live chain gets the arrival rest on top of its window.
  function stageEnter() {
    const r = sync(),
      run = ctx.run;
    if (!r || r.stage === run.stage) return;
    if (r.stage > 0 && r.stage < run.stage) untouched(r.stage);
    r.stage = run.stage;
    r.overtime = null;
    r.fading = false;
    r.phasedThisStage = 0;
    t.stageM = multiplier();
    t.stageClean = true;
    t.gaspPaid = false;
    t.gasp = null;
    if (r.chain.count > 0) r.chain.timer = r.chain.window + CHAIN.stageGrace;
  }

  // Every run starts here: KEEPERS runs outside the demo and the tutorial keep a Rift Score.
  function begin(run) {
    t = trackers();
    if (!run || run.original || run.demo || run.kind === "tutorial") return;
    run.rift = createRift();
    t.synced = run.elapsed;
    if (run.stats) {
      run.stats.chainBest = 0;
      run.stats.chainBreaks = { severed: 0, ended: 0 };
      run.stats.feats = run.rift.feats;
    }
  }

  // Practice: a 60-runner ring at 10 m (mortal; the panel's Mortal toggle restores the dev
  // invulnerability).
  function registerScenarios({ register } = {}) {
    register?.("chain", (c, params, h) => h.spawnRing(CHAIN_RING.kind, CHAIN_RING.count, CHAIN_RING.radius), { stage: 1, mortal: true });
  }

  bus.on("runStart", (p) => begin(p?.run ?? ctx.run));
  bus.on("stageEnter", () => stageEnter());
  bus.on("enemyKilled", onKill);
  bus.on("playerHit", onPlayerHit);
  bus.on("playerDrain", () => sync() && spoil());
  bus.on("phased", onPhased);
  bus.on("boss", onBoss);
  bus.on("trial", onTrial);
  bus.on("prop", onProp);
  bus.on("portalOpen", () => overtime("portal"));
  bus.on("dais", (p) => p?.event === "awake" && overtime("portal"));
  bus.on("practice", registerScenarios);

  return {
    // state() -> run.rift, synced to the current step, or null.
    state: sync,
    multiplier,
    // award(featId, args) -> the bonus paid. BAITED, UNSCATHED, UNTOUCHED, MASSACRE, SKEWER,
    // DETONATION, SWIFT, RIFTBANE, PHASED and LAST GASP are detected here from bus events;
    // callers award only INTERRUPTED (both Warden nodes broken before the deadline).
    award,
    overtime,
    stageEnter,
    // tick(): once per simulation step, after combat (the chain ends on its own step).
    tick: sync,
    reset() {
      t = trackers();
    },
  };
}
