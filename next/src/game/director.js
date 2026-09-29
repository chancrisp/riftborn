// Game flow: global modes, the run lifecycle, stage progression, the ambient spawner and
// Rift Surges, keeper gates and the Crown Dais, campaign sequences, mosaic transitions, pause,
// and the run-end beat. step(dt) is THE fixed-step dispatcher (spec flow.md §3.1); the in-run
// simulation order is ARCHITECTURE.md §6.
//
// Rulesets (IMPROVEMENTS F1.1): every Wave-2 gameplay rule below checks run.original and keeps
// the Wave-1 code path when it is set, so the ORIGINAL simulation stays bit-identical.
import { STAGES, SEQUENCES, FLOW, stageDef, versionOf } from "../data/stages.js";
import { RUN_MODES, MAX_HOSTILES } from "../data/enemies.js";
import { keeperDef } from "../data/keepers.js";
import { createBuild, createBoons } from "../data/progression.js";
import { boardOf } from "../meta/boards.js";
import { mulberry32, randomSeed, createStreams, seedCode } from "../core/rng.js";
import { clamp, smoothstep } from "../core/util.js";
import { collapseModel } from "../render/models.js";
import { RewardQueue } from "./progression.js";
import { keeperFor, hostileCap, stageHealAmount, scaledDt, assistKinds, markAssists, daisDue, featList } from "./logic/flow.js";

export { keeperFor, hostileCap, stageHealAmount, scaledDt, assistKinds, markAssists, daisDue, featList };

const LAST_STAGE = STAGES.length;
const NAME_LIMIT = 16;
const RULESETS = Object.freeze(["keepers", "original"]);
const QUARRY_CAP = 8; // live hostiles (Iron Maw included) while the Maw fight is on
const QUARRY_INTERVAL = 4;
const SURGE_MAX = 6;
const PORTAL_SPARKS = 90;
const STAGE_BURST = Object.freeze({ color: "#d3a0ff", count: 40, speed: 5 });
const DEMO_RING = 8;
const DEMO_RADIUS = 14;
const DEMO_PLAYER = Object.freeze({ damage: 1.6, rate: 1.25, regen: 3, hp: 160, max: 160 });
const TUTORIAL_PLAYER = Object.freeze({ regen: 20 });
const ARRIVAL_GRACE = 2; // invulnerability on stage entry
const SEQUENCE_GRACE = 1; // minimum invulnerability after any cinematic
const RESUME_GRACE = 0.5; // Wave-1: invulnerability after unpausing
const ENTRANCE_HOLD = 2; // Wave-1: level-up cards wait this long after a boss entrance
// Wave-1 death beat: the world slows to a crawl, the hero crumbles, the camera leans in and
// the picture drains to red and dark before the results appear.
const DEATH_BEAT = 1.2;
const DEATH_SLOW = 0.25;
const DEATH_COLLAPSE = 0.7;
const DEATH_FADE = 0.75;
const DEATH_PUSH = 0.18; // share of the camera distance closed during the beat
const ERROR_REPORTS = 3;
// Wave-2 spawn options (enemies.spawn): ambient spawns may roll elites; surges are marked too.
const AMBIENT = Object.freeze({ ambient: true });
const SURGE = Object.freeze({ ambient: true, surge: true });

// Old-run teardown in dependency order: reward screens, mod effects and boss state before
// the actors and projectiles they reference, then the pooled visuals. Run-only Wave-2 state
// (relics, the Rules Ledger, the Rift Score, hazard props) never outlives its run.
const RUN_RESET = [
  ["progression", "clear"],
  ["mods", "clear"],
  ["bosses", "clear"],
  ["encounters", "clearStage"],
  ["hazards", "clear"],
  ["combat", "clear"],
  ["enemies", "clear"],
  ["relics", "clear"],
  ["rules", "clear"],
  ["scoring", "reset"],
  ["fx", "clear"],
  ["tele", "clear"],
];
const STAGE_RESET = [
  ["hazards", "clear"],
  ["enemies", "clear"],
  ["elites", "stageReset"],
  ["combat", "clear"],
  ["fx", "clear"],
  ["tele", "clear"],
];

// Spawn rhythm for one stage: a 3 s rest on arrival, then 26 s of spawning and a 6 s lull
// per 32 s cycle. An active encounter (trial, keeper fight) skips the lull, never the rest.
export class EncounterPacing {
  constructor() {
    this.age = 0;
    this.rest = 3;
  }
  tick(dt) {
    this.age += dt;
    this.rest = Math.max(0, this.rest - dt);
  }
  recover(seconds) {
    this.rest = Math.max(this.rest, seconds);
  }
  allowSpawns(encounter = false) {
    return this.rest <= 0 && (encounter || this.age % 32 < 26);
  }
}

// One campaign cinematic (ctx.cinematic). The simulation is frozen while it runs; only its
// own clock advances, capped per tick so a stall cannot skip it.
export class CampaignSequence {
  constructor(kind, stage = 1) {
    const def = SEQUENCES[kind] || SEQUENCES.stage;
    const place = kind === "stage" ? stageDef(stage) : null;
    this.kind = kind;
    this.age = 0;
    this.paused = false;
    this.finished = false;
    this.duration = def.duration;
    this.cue = def.cue;
    this.title = place ? place.name : def.title;
    this.text = place ? place.story : def.text;
    this.skipLabel = kind === "victory" ? "VIEW RESULTS" : "SKIP";
    this.actor = null;
    this.done = null;
    this.scale = null;
  }
  get progress() {
    return Math.min(1, this.age / this.duration);
  }
  tick(dt) {
    if (this.finished || this.paused) return false;
    this.age += clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
    return this.age >= this.duration ? this.skip() : false;
  }
  skip() {
    if (this.finished) return false;
    this.finished = true;
    return true;
  }
}

// Run ids name leaderboard rows. randomUUID needs a secure context; getRandomValues does not.
function newRunId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const isWarden = (e) => e?.boss === "warden" || e?.kind === "warden";
// The Rift Score, its overtime and its stage snapshots run in KEEPERS runs outside the demo.
const riftRun = (run) => !run.original && !run.demo;

export function createDirector(ctx) {
  const doc = globalThis.document;
  const body = doc?.body ?? null;
  const failures = new Map(); // label -> reports so far
  const grade = { death: 0, deathFade: 0 };
  let beat = null; // { t, summary, distance } while the run-end death beat plays
  let results = null; // { summary } of a finished run whose results open on the next menu step
  // The flow change the mosaic covers ({ kind, midpoint, after, ran, next }), one queued
  // request of another kind, and a focus loss that arrived meanwhile (F20).
  let transit = null;
  let queued = null;
  let blurred = false;

  // ---- plumbing -------------------------------------------------------------------------

  function report(label, err) {
    const count = failures.get(label) || 0;
    failures.set(label, count + 1);
    if (count < ERROR_REPORTS) console.error(`[director] ${label} failed`, err);
  }

  // Runs one phase of a step; a failing system must not freeze the camera, HUD or menus.
  function guard(label, fn, arg) {
    try {
      fn(arg);
    } catch (err) {
      report(label, err);
    }
  }

  function resetSystems(list) {
    for (const [system, method] of list) {
      const target = ctx[system];
      if (typeof target?.[method] !== "function") continue;
      try {
        target[method]();
      } catch (err) {
        report(`${system}.${method}`, err);
      }
    }
  }

  const toast = (text) => ctx.hud?.toast?.(text);
  const sfx = (name) => ctx.audio?.fx?.(name);
  const ground = (x, z) => ctx.world?.height?.(x, z) ?? 0;
  const heal = (amount, reason) => ctx.player?.heal?.(amount, reason);
  const hostiles = () => ctx.enemies?.live?.() ?? 0;
  const trialActive = (run) => run.trial?.state === "active";
  // Rules Ledger reads (F9.1); neutral when no source applies.
  const ledgerSum = (key) => ctx.rules?.sum?.(key) ?? 0;
  const ledgerMul = (key) => ctx.rules?.mul?.(key) ?? 1;
  // Game speed (F18.5): a run's fixed speed (practice &assist=1) or the preference.
  const speedOf = (run) => run?.speed ?? (Number(ctx.prefs?.gameSpeed) || 100);
  const gameDt = (dt) => scaledDt(dt, speedOf(ctx.run));

  // While a transition covers the screen, a requested mode waits for its end (F20).
  function setMode(mode) {
    if (transit && mode !== "transition") {
      transit.next = mode;
      return;
    }
    const prev = ctx.mode;
    if (prev === mode) return;
    ctx.mode = mode;
    ctx.bus.emit("modeChange", { mode, prev });
  }

  function setBodyClass(name, on) {
    body?.classList.toggle(name, on);
  }

  function setHeroVisible(visible) {
    const hero = ctx.player?.hero;
    if (hero?.g) hero.g.visible = visible;
  }

  function difficultyScale() {
    return 1 + (ctx.run?.difficultyBonus || 0) / 100;
  }

  function spawnHpFactor() {
    const run = ctx.run;
    if (!run) return 1;
    return (1 + (run.stage - 1) * 0.22 + Math.min(run.wave - 1, 20) * 0.05) * difficultyScale();
  }

  // KEEPERS curse scaling (IMPROVEMENTS §1.4): the curse bonus splits into HP (spawn HP, keeper
  // HP, spawn interval), speed (+20% at most) and damage (+75% at most) terms, so stacked curses
  // never make monsters that cannot be kited or hits that one-shot. ORIGINAL reads
  // difficultyScale() everywhere instead.
  const hpScale = () => difficultyScale();
  const speedScale = () => 1 + Math.min(0.2, (ctx.run?.difficultyBonus || 0) / 250);
  const damageScale = () => 1 + Math.min(0.75, (ctx.run?.difficultyBonus || 0) / 100);

  // Every reward key goes through here (dash-trait, quarry, keeper:{id}, cache:{stage}:{i},
  // xp:{level}, trial keys), so a later depth prefix touches no call site.
  const rewardKey = (base) => base;

  // Journal milestones ("quarry", "keeper:{id}", ...), recorded by the profile's listener.
  function milestone(key) {
    ctx.bus.emit("milestone", { key });
  }

  // The ruleset of a new run (IMPROVEMENTS F1.1): the tutorial is always ORIGINAL; an explicit
  // choice (practice, tests) wins next; the attract demo is KEEPERS; a campaign run follows
  // the device preference.
  function rulesetFor({ demo, tutorial, ruleset }) {
    if (tutorial) return "original";
    if (RULESETS.includes(ruleset)) return ruleset;
    if (demo) return "keepers";
    return RULESETS.includes(ctx.prefs?.ruleset) ? ctx.prefs.ruleset : "keepers";
  }

  // Run randomness (IMPROVEMENTS F14.1). KEEPERS gives every named stream its own generator,
  // with run.rng the "spawn" stream. ORIGINAL keeps the Wave-1 single generator: every stream
  // name and run.rand resolve to run.rng at call time, so each draw keeps its Wave-1 order.
  function bindStreams(run) {
    if (run.original) {
      run.rng = mulberry32(run.seed);
      run.stream = () => run.rng;
    } else {
      run.stream = createStreams(run.seed);
      run.rng = run.stream("spawn");
    }
    run.rand = (a = 0, b = 1) => a + run.rng() * (b - a);
  }

  // The in-run simulation may keep going only while its run is current, unfinished and in
  // play (the attract demo runs in "menu" until it finishes), with no panel open.
  function live(run) {
    if (ctx.run !== run || run.over || ctx.overlay) return false;
    return ctx.mode === "play" || (run.demo && !ctx.demo?.finished);
  }

  // ---- mosaic transitions (F20) -----------------------------------------------------------

  // Covers a flow change with ctx.transition. The director holds mode "transition" from OUT
  // until IN ends: no simulation, no portal check and no player input, only the view and the
  // HUD. midpoint() swaps the world under the covered screen; a mode it asks for applies when
  // the transition ends, then after() runs (the stage or opening sequence, so a title card never
  // reveals under the mosaic). A same-kind request while one runs is dropped and another kind
  // waits (one at most). A transition that fails or ends early still runs its midpoint first,
  // so it never blocks the flow.
  function transitionTo(kind, midpoint, after = null) {
    if (transit) {
      if (transit.kind !== kind && !queued) queued = { kind, midpoint, after };
      return;
    }
    const t = { kind, midpoint, after, ran: false, next: ctx.mode };
    setMode("transition");
    transit = t;
    try {
      Promise.resolve(ctx.transition?.run?.(kind, () => runMidpoint(t))).catch((err) => report("transition", err));
    } catch (err) {
      report("transition", err);
    }
    if (!ctx.transition?.active?.()) settleTransition();
  }

  function runMidpoint(t) {
    if (t.ran) return;
    t.ran = true;
    guard(`transition ${t.kind}`, t.midpoint);
  }

  function settleTransition() {
    const t = transit;
    if (!t) return;
    runMidpoint(t);
    transit = null;
    setMode(t.next);
    if (t.after) guard(`transition ${t.kind}`, t.after);
    if (blurred) {
      blurred = false;
      onBlur();
    }
    const next = queued;
    queued = null;
    if (next) transitionTo(next.kind, next.midpoint, next.after);
  }

  // ---- run lifecycle --------------------------------------------------------------------

  function createRun({ kind, stage, seed, name, scenario, ruleset, speed, board }) {
    const tutorial = kind === "tutorial";
    const death = !tutorial && ctx.menuDeath;
    const run = {
      // Real runs carry an id (leaderboard rows); so does a practice run that writes the local
      // copy of the board it would have reached (&board=local, F15).
      id: (kind === "real" && !ctx.env?.debug?.practice) || board === "local" ? newRunId() : null,
      kind,
      demo: kind === "demo",
      practice: kind === "practice",
      scenario,
      mortal: false, // a practice scenario without its invulnerability override (practice.js)
      ruleset,
      original: ruleset === "original",
      tutorial: null,
      death,
      tuning: death ? RUN_MODES.death : RUN_MODES.normal,
      name,
      seed,
      seedCode: seedCode(seed), // "RIFT-MMDD-XXXX" for the pause stats and the results (F14.1)
      rng: null,
      rand: null,
      stream: null,
      speed: Number.isFinite(speed) ? speed : null, // a fixed game speed for this run (F18.5)
      board: board === "local" ? "local" : null,
      nextId: 1,
      stage,
      stageKills: 0,
      stageGoal: tutorial ? FLOW.TUTORIAL_GOAL : stageDef(stage).goal,
      stageTime: 0,
      elapsed: 0,
      wave: 1,
      score: 0,
      kills: 0,
      spawnTimer: FLOW.FIRST_SPAWN,
      pacing: new EncounterPacing(),
      entranceHold: 0,
      portalActive: false,
      bossSpawned: false,
      victory: false,
      over: false,
      // The keeper gate of this stage: "dormant" | "waiting" | "active" | "defeated" | "rewarded"
      // (IMPROVEMENTS F1.3). quarryState is its Wave-1 name (Iron Maw), kept as an alias.
      keeperState: "dormant",
      get quarryState() {
        return this.keeperState;
      },
      set quarryState(state) {
        this.keeperState = state;
      },
      keeper: null, // the live keeper fight record (F1.3)
      dais: null, // stage 5 under KEEPERS: { awake, t } once the goal wakes the Crown Dais (F6)
      difficultyBonus: 0,
      statueCount: 0,
      trialCount: 0,
      trial: null,
      player: null,
      weapon: 0,
      fireTimer: 0,
      build: createBuild(),
      boons: createBoons(),
      rewards: new RewardQueue(),
      activeReward: null,
      enemies: [],
      objects: [],
      shots: [],
      hazards: [],
      gems: [],
      powerups: [],
      stats: {
        damage: [0, 0, 0, 0, 0],
        kills: [0, 0, 0, 0, 0],
        killsByKind: {},
        dashes: 0,
        damageTaken: 0,
        shots: 0,
        lethal: null,
        stageTimes: [],
        curses: 0,
        trials: 0,
      },
      // Scratch per-run flags. keepersBroken lists keeper ids in defeat order and keeperTimes
      // the seconds each fight took (F1.3); the assist flags are sticky for the run (F18.5).
      flags: { keepersBroken: [], keeperTimes: {}, assisted: false, assistKinds: [], assistSpeed: 100 },
    };
    bindStreams(run);
    return run;
  }

  // The mode badge (F1.1): {MODE} · {RULESET} · {ASSIST}. A practice scenario sets its own
  // MODE text (modeBadge); the ASSIST segment is drawn in the assist blue (F18.5).
  let badgeMode = null;
  function writeModeBadge(run, modeText = badgeMode) {
    const badge = doc?.querySelector("#modeBadge");
    if (!badge || !run) return;
    const mode = ctx.menuDeath ? "DEATH" : "NORMAL";
    const segments = [];
    const first = modeText ?? (run.practice && !run.scenario ? `PRACTICE · ${mode} · NO SCORE` : ctx.menuDeath ? "DEATH MODE" : "");
    if (first) segments.push(first);
    if (run.original && run.kind !== "tutorial" && !run.demo) segments.push("ORIGINAL RULES");
    let assist = "";
    if (run.flags?.assisted) {
      const speed = Number(run.flags.assistSpeed);
      assist = speed > 0 && speed < 100 ? `ASSIST · ${speed}% SPEED` : "ASSIST";
    }
    const text = segments.join(" · ");
    if (!assist) {
      badge.textContent = text;
      return;
    }
    const span = doc.createElement("span");
    span.style.color = "#9fcbff";
    span.textContent = assist;
    badge.replaceChildren(text ? `${text} · ` : "", span);
  }

  // World (the renderer and weather follow its "stageBuilt"), hero placement and HUD for the
  // run's current stage.
  function buildStage(run) {
    ctx.world?.build?.(run.stage, run.seed, { tutorial: !!run.tutorial, original: run.original });
    ctx.player?.place?.(0, 0);
    ctx.weather?.clear?.();
    ctx.hud?.clear?.();
  }

  // Stage entry for the Rift Score (snapshots, chain carry-over, overtime reset), then the bus.
  function announceStage(run) {
    if (riftRun(run)) ctx.scoring?.stageEnter?.();
    ctx.bus.emit("stageEnter", { stage: run.stage });
  }

  function spawnDemoRing() {
    for (let i = 0; i < DEMO_RING; i++) {
      const a = (i * Math.PI) / 4;
      ctx.enemies?.spawn?.(null, { x: Math.sin(a) * DEMO_RADIUS, z: Math.cos(a) * DEMO_RADIUS });
    }
  }

  // Every run (real, practice, tutorial, scenario and each attract-demo restart) starts here.
  // opts: { demo, tutorial, practice, scenario, name, stage (demo/scenario), seed, opening,
  // ruleset ("keepers" | "original"; see rulesetFor), speed (a fixed game speed), board
  // ("local") }. A run begun from the menu opens under the mosaic (F20) and returns null while
  // the transition still covers its build; the demo and developer scenarios start at once and
  // return their run.
  function start(opts = {}) {
    const opening = opts.opening ?? true;
    if (opts.demo || opts.scenario) {
      const run = launch(opts);
      openRun(run, opening);
      return run;
    }
    let run = null;
    transitionTo(
      "start",
      () => (run = launch(opts)),
      () => openRun(run, opening),
    );
    return run;
  }

  function launch({ demo = false, tutorial = false, practice = false, scenario = null, name = "", stage = 1, seed = null, ruleset = null, speed = null, board = null } = {}) {
    endDeathBeat();
    resetSequence();
    resetSystems(RUN_RESET);
    ctx.input?.clear?.();
    results = null;
    const kind = demo ? "demo" : tutorial ? "tutorial" : practice || scenario ? "practice" : "real";
    const run = createRun({
      kind,
      stage: demo || scenario ? clamp(Math.round(stage) || 1, 1, LAST_STAGE) : 1,
      seed: Number.isFinite(seed) ? seed >>> 0 : randomSeed(),
      name: demo ? "CPU" : String(name || "").trim().slice(0, NAME_LIMIT) || "Player",
      scenario: scenario || null,
      ruleset: rulesetFor({ demo, tutorial, ruleset }),
      speed,
      board,
    });
    ctx.run = run;
    run.player = ctx.player?.fresh?.(demo ? DEMO_PLAYER : tutorial ? TUTORIAL_PLAYER : {}) ?? null;
    if (tutorial) ctx.tutorial?.begin?.();
    ctx.demo?.reset?.();
    setBodyClass("tutorial-active", tutorial);
    badgeMode = null;
    writeModeBadge(run);
    setMode(demo ? "menu" : "play");
    buildStage(run);
    // The camera snaps onto the hero and the renderer clears the death grade on "runStart".
    ctx.bus.emit("runStart", { run });
    announceStage(run);
    setHeroVisible(true);
    ctx.player?.equip?.(0);
    trackAssists(run);
    if (demo) {
      spawnDemoRing();
      return run;
    }
    ctx.menus?.hideMenu?.();
    ctx.menus?.hideChoice?.();
    ctx.menus?.hidePause?.();
    setBodyClass("in-run", true);
    setBodyClass("menu-open", false);
    ctx.audio?.start?.();
    if (!tutorial) toast(`STAGE ${run.stage} · ${stageDef(run.stage).name}`);
    return run;
  }

  // The opening sequence, once the run is on screen (after the start transition, if any).
  function openRun(run, opening) {
    if (!run || ctx.run !== run || run.demo) return;
    if (opening && !run.tutorial) beginSequence("opening");
    ctx.hud?.update?.();
  }

  // The attract demo behind the main menu (boot, or abandoning whatever run is live).
  function toMenu() {
    leaveRunScreen();
    ctx.menus?.showMenu?.();
    return start({ demo: true, stage: ctx.demo?.stage ?? 1 });
  }

  // Leaves the in-run screen for the menu: HUD rows, pause card and run body classes.
  function leaveRunScreen() {
    ctx.input?.clear?.();
    setBodyClass("in-run", false);
    setBodyClass("tutorial-active", false);
    setBodyClass("menu-open", true);
    ctx.menus?.hidePause?.();
    ctx.hud?.clear?.();
    ctx.hud?.tutorial?.(null);
  }

  // Tutorial exit: back to the menu under the mosaic, the attract demo resuming on its
  // current stage.
  function returnToMenu(summary) {
    transitionTo("menu", () => {
      endDeathBeat();
      resetSequence();
      setMode("menu");
      leaveRunScreen();
      ctx.menus?.showMenu?.(summary);
      start({ demo: true, stage: ctx.demo?.stage ?? 1 });
    });
  }

  // The results card's data (F19.3): the Wave-1 fields, then the ruleset, the seed code, the
  // keepers broken, relics, omens, the Rift Score parts, the banked multiplier and the assist
  // flags. Cause and hint are snapshots taken now, never read back later.
  function captureSummary(run, outcome, meta) {
    const rift = ctx.scoring?.state?.() ?? null;
    return {
      outcome,
      stage: run.stage,
      score: run.score,
      kills: run.kills,
      seconds: run.elapsed,
      practice: run.practice && !run.scenario,
      damage: [...run.stats.damage],
      statues: run.statueCount,
      trials: run.trialCount,
      modifier: 100 + run.difficultyBonus,
      build: ctx.progression?.buildText?.(false) ?? "",
      cause: meta.cause,
      hint: meta.hint,
      mastery: meta.newly || [],
      earned: meta.earned || [],
      comparisons: [],
      personalBest: false,
      ruleset: run.ruleset,
      seedCode: run.seedCode,
      keepers: [...run.flags.keepersBroken],
      relics: (ctx.relics?.owned?.() ?? []).map((relic) => relic.id),
      omens: [...(ctx.omens?.active?.() ?? [])],
      rift: rift && {
        score: rift.score,
        killPart: rift.killPart,
        chainPart: rift.chainPart,
        featPart: rift.featPart,
        chainBest: rift.chain?.best ?? 0,
        feats: { ...rift.feats },
      },
      multiplier: ctx.scoring?.multiplier?.() ?? 1,
      assisted: run.flags.assisted ? { kinds: [...run.flags.assistKinds], speed: run.flags.assistSpeed } : null,
      boards: [],
    };
  }

  // Payload v1 (worker boards and the Wave-1 `scores` collection): the original field set.
  function originalRecord(run, outcome, playedAt) {
    return {
      id: run.id,
      name: run.name,
      score: run.score,
      kills: run.kills,
      wave: run.wave,
      seconds: Math.floor(run.elapsed),
      stage: run.stage,
      played_at: playedAt,
      death_mode: run.death,
      statue_count: run.statueCount,
      statue_modifier: 100 + run.difficultyBonus,
      outcome,
      gameplay_version: versionOf(run),
    };
  }

  // Payload v2 (RIFT and ASSISTED boards, F15): immutable, one new id per board record.
  function boardRecord(run, board, outcome, summary, playedAt) {
    const rift = summary.rift;
    return {
      id: newRunId(),
      board,
      run_id: run.id,
      name: run.name,
      title: ctx.profile?.cosmetics?.title ?? null,
      ruleset: run.ruleset,
      score: run.score,
      rift_score: rift?.score ?? 0,
      kills: run.kills,
      wave: run.wave,
      seconds: Math.floor(run.elapsed),
      stage: run.stage,
      played_at: playedAt,
      death_mode: run.death,
      statue_count: run.statueCount,
      statue_modifier: 100 + run.difficultyBonus,
      omens: [...summary.omens],
      relics: [...summary.relics],
      keepers: [...summary.keepers],
      chain_best: rift?.chainBest ?? 0,
      feats: featList(rift?.feats),
      seed_code: run.seedCode,
      ...(run.flags.assisted ? { speed: run.flags.assistSpeed } : {}),
      outcome,
      gameplay_version: versionOf(run),
      schema: 2,
    };
  }

  // Runs of at least a second go to the boards scores.route picks (F15): none for practice
  // (unless &board=local), the demo and the tutorial. The comparison is taken before the first
  // record joins the run history.
  function submitScore(run, outcome, summary) {
    if (!run.id || run.elapsed < 1) return;
    const boards = ctx.scores?.route?.(run) ?? [];
    const playedAt = Date.now();
    const records = boards.map((board) => (boardOf(board)?.backend === "worker" ? originalRecord(run, outcome, playedAt) : boardRecord(run, board, outcome, summary, playedAt)));
    summary.boards = [...boards];
    if (!records.length) return;
    summary.comparisons = ctx.profile?.compare?.(records[0]) || [];
    summary.personalBest = summary.comparisons.includes("PERSONAL BEST");
    for (const record of records)
      try {
        Promise.resolve(ctx.scores?.submit?.(record)).catch((err) => report("scores.submit", err));
      } catch (err) {
        report("scores.submit", err);
      }
  }

  // Death, END RUN, or the victory sequence's end. The demo and the tutorial route away.
  // Encounter objects, Warden nodes, mods and the build cue clear themselves on "runEnd".
  function finishRun(defeated = false) {
    const run = ctx.run;
    if (!run || run.over) return;
    if (run.demo) {
      ctx.demo?.finish?.();
      return;
    }
    if (run.tutorial) {
      ctx.tutorial?.finish?.(false);
      return;
    }
    if (ctx.mode !== "play" && ctx.mode !== "pause") return;
    run.over = true;
    const outcome = run.victory ? "victory" : defeated ? "defeat" : "ended";
    const meta = ctx.profile?.completeRun?.({ id: run.id, outcome, lethal: run.stats.lethal, statues: run.statueCount }) || {};
    const summary = captureSummary(run, outcome, meta);
    ctx.encounters?.abandonTrial?.();
    ctx.input?.clear?.();
    setMode("dead");
    ctx.hud?.update?.(); // the status block stays on screen through the death beat
    submitScore(run, outcome, summary);
    ctx.bus.emit("runEnd", { run, outcome: outcome === "ended" ? "quit" : outcome, summary });
    if (outcome === "defeat") beginDeathBeat(summary);
    else results = { summary };
  }

  function presentResults(summary, heroVisible) {
    setHeroVisible(heroVisible);
    leaveRunScreen();
    ctx.menus?.showMenu?.(summary);
  }

  // Victory and END RUN: the results open on the next menu step, under the mosaic, with the
  // attract demo restarted behind them.
  function showResults() {
    const { summary } = results;
    results = null;
    transitionTo("menu", () => {
      presentResults(summary, true);
      ctx.demo?.restart?.();
    });
  }

  // The fallen hero stays on screen to crumble, even if the lethal hit caught it mid-blink.
  function beginDeathBeat(summary) {
    beat = { t: 0, summary, distance: ctx.env?.reduced ? 0 : (ctx.cam?.distance ?? 0) };
    setHeroVisible(true);
  }

  // The beat's own clock is real time; the world's slow-mo composes with the game speed.
  function tickDeathBeat(dt) {
    beat.t += dt;
    const t = beat.t;
    effects(gameDt(dt) * DEATH_SLOW);
    collapseModel(ctx.player?.hero, t / DEATH_COLLAPSE);
    grade.death = smoothstep(0, 0.35, t);
    grade.deathFade = DEATH_FADE * smoothstep(0.45, DEATH_BEAT, t);
    ctx.gfx?.setGrade?.(grade);
    if (beat.distance > 0 && ctx.cam) ctx.cam.distance = beat.distance * (1 - DEATH_PUSH * smoothstep(0, DEATH_BEAT, t));
    if (t < DEATH_BEAT) return;
    // The red fade covers the fallen hero; the results and the demo are in place under it.
    const { summary } = beat;
    transitionTo("death", () => {
      endDeathBeat();
      presentResults(summary, false);
      ctx.demo?.restart?.();
    });
  }

  // Stands the hero back up; the grade and the camera reset themselves on the next "runStart".
  function endDeathBeat() {
    if (!beat) return;
    beat = null;
    collapseModel(ctx.player?.hero, 0);
  }

  // ---- stage progression ----------------------------------------------------------------

  // Called on every kill once the stage goal is met, so it must be idempotent. ORIGINAL keeps
  // the Wave-1 gates (Iron Maw on stage 2, the Warden at once on stage 5). KEEPERS gates stages
  // 2-4 behind their keeper and wakes the Crown Dais on stage 5 (F1.3, F6); the demo and the
  // tutorial skip keepers, and the demo still summons the Warden at once.
  function activatePortal() {
    const run = ctx.run;
    if (!run || run.over) return;
    const scripted = !run.demo && !run.tutorial;
    if (run.stage === 1 && scripted) ctx.progression?.queue?.(rewardKey("dash-trait"), "dash");
    if (run.original) {
      if (run.stage === 2 && scripted && run.quarryState !== "rewarded") {
        if (run.quarryState === "dormant" || run.quarryState === "waiting") ctx.bosses?.startQuarry?.();
        return;
      }
      if (run.stage >= LAST_STAGE) {
        ctx.bosses?.summonWarden?.();
        return;
      }
    } else {
      const keeper = scripted ? keeperFor(run.stage) : null;
      if (keeper && run.keeperState !== "rewarded") {
        if (run.keeperState === "dormant" || run.keeperState === "waiting") ctx.bosses?.startKeeper?.(keeper);
        return;
      }
      if (run.stage >= LAST_STAGE) {
        if (run.demo) ctx.bosses?.summonWarden?.();
        else wakeDais(run);
        return;
      }
    }
    if (run.portalActive) return;
    openPortal(run, scripted);
  }

  function openPortal(run, scripted) {
    run.portalActive = true;
    const portal = ctx.world?.portal;
    portal?.setActive?.(true);
    toast(run.tutorial ? "TRAINING RIFT OPEN" : `RIFT PORTAL OPEN · ${stageDef(run.stage).name}`);
    if (portal) for (let i = 0; i < PORTAL_SPARKS; i++) ctx.fx?.burst?.(portal.x, 0.8 + Math.random() * 5.2, portal.z, "#b974ff", 1, 3);
    sfx("level");
    ctx.bus.emit("portalOpen", { stage: run.stage });
    if (riftRun(run)) ctx.scoring?.overtime?.("portal");
    // The Meadows' optional keeper: its shrine bell wakes as the rift opens (F2).
    if (!run.original && run.stage === 1 && scripted) ctx.world?.shrineBell?.wake?.();
    ctx.hud?.update?.();
  }

  // Stage 5 under KEEPERS (F6): the goal wakes the Crown Dais; the Warden descends once the
  // player climbs it or the crown grows impatient (updateDais).
  function wakeDais(run) {
    if (run.dais) return;
    run.dais = { awake: true, t: 0 };
    ctx.world?.dais?.setAwake?.(true);
    ctx.bosses?.awaitDais?.();
    ctx.scoring?.overtime?.("portal");
    ctx.bus.emit("dais", { event: "awake" });
    ctx.hud?.update?.();
  }

  // Play steps only: rewards, cards and sequences hold the 45 s fallback.
  function updateDais(run, dt) {
    if (!run.dais?.awake || run.bossSpawned) return;
    run.dais.t += dt;
    if (!daisDue(run.dais.t, run.player, ctx.world?.dais ?? ctx.world?.portal)) return;
    if (!ctx.bosses?.summonWarden?.()) return;
    ctx.scoring?.overtime?.("keeper");
    ctx.bus.emit("dais", { event: "summon" });
  }

  function atPortal(run) {
    const portal = ctx.world?.portal;
    const p = run.player;
    return run.portalActive && !!portal && !!p && Math.hypot(p.x - portal.x, p.z - portal.z) < FLOW.PORTAL_RADIUS;
  }

  // Rift entry: shards are banked, ground pickups lost, the next stage built under the mosaic,
  // then the stage sequence. Refused while a reward is open or queued. Returns true when the
  // run is leaving the current stage.
  function enterStage() {
    const run = ctx.run;
    if (!run || run.over || !run.portalActive || run.activeReward || ctx.progression?.pending) return false;
    if (run.tutorial) {
      leaveStage();
      ctx.tutorial?.finish?.(true);
      return true;
    }
    if (run.stage >= LAST_STAGE) return false;
    transitionTo(
      "portal",
      () => {
        leaveStage();
        advanceStage(run);
      },
      () => ctx.run === run && !run.over && beginSequence("stage"),
    );
    return true;
  }

  // What the old stage leaves behind: mod effects, the trial, boss state.
  function leaveStage() {
    ctx.mods?.clear?.();
    ctx.encounters?.abandonTrial?.();
    ctx.bosses?.clear?.();
  }

  function advanceStage(run) {
    ctx.encounters?.collectAllGems?.();
    ctx.encounters?.clearStage?.();
    ctx.input?.clear?.();
    if (run.player) run.player.inv = ARRIVAL_GRACE;
    run.stats.stageTimes.push(run.stageTime);
    run.stageTime = 0;
    run.stage += 1;
    run.stageKills = 0;
    run.stageGoal = stageDef(run.stage).goal;
    run.portalActive = false;
    run.dais = null;
    sfx("portal");
    resetSystems(STAGE_RESET);
    buildStage(run);
    const healed = stageHealAmount(FLOW.STAGE_HEAL, run.original ? 0 : ledgerSum("stageHeal"));
    heal(healed, "stage");
    run.pacing = new EncounterPacing();
    announceStage(run);
    toast(`STAGE ${run.stage} · ${stageDef(run.stage).name} · SHARDS COLLECTED${healed > 0 ? ` · +${healed} HEALTH` : ""}`);
    sfx("level");
    ctx.fx?.burst?.(0, 1, 0, STAGE_BURST.color, STAGE_BURST.count, STAGE_BURST.speed);
    ctx.hud?.update?.();
  }

  // Score, stats and stage accounting for a kill (combat calls this after drops and trial
  // bookkeeping). The Warden's kill is scored, then ends the run instead of feeding the portal.
  function onKill(e, source) {
    const run = ctx.run;
    if (!run || run.over || !e || e.fixed) return;
    run.score += e.def?.score || 0;
    run.kills += 1;
    run.stageKills += 1;
    recordKill(run.stats, e, source);
    ctx.tutorial?.event?.("kill", e);
    if (isWarden(e)) {
      victory(run, e);
      return;
    }
    if (run.kills % FLOW.KILL_HEAL_EVERY === 0) heal(FLOW.KILL_HEAL * (run.original ? 1 : ledgerMul("killHealMult")), "kill");
    if (run.stageKills >= run.stageGoal) activatePortal();
  }

  // Per-weapon kills credit the originating slot (mods and echoes carry it); the Iron Maw is
  // counted as its own kind, not as the charger it is built from.
  function recordKill(stats, e, source) {
    const slot = source?.weapon ?? source?.sourceWeapon;
    if (Number.isInteger(slot) && slot >= 0 && slot < stats.kills.length) stats.kills[slot] += 1;
    const kind = e.boss === "ironmaw" || e.miniboss ? "ironmaw" : e.kind;
    stats.killsByKind[kind] = (stats.killsByKind[kind] || 0) + 1;
  }

  // The Warden fell: play the victory sequence, then the results. Without a sequence (the
  // attract demo, automated tests) the Warden leaves and the run ends at once.
  function victory(run, warden) {
    run.victory = true;
    if (beginSequence("victory", warden, () => finishRun(false))) return;
    ctx.enemies?.remove?.(warden);
    finishRun(false);
  }

  // ---- spawning -------------------------------------------------------------------------

  function spawnAmbient(run, dt) {
    run.spawnTimer -= dt;
    if (run.tutorial || run.bossSpawned || run.spawnTimer > 0) return;
    if (run.original) spawnOriginal(run);
    else spawnKeepers(run);
  }

  // Wave 1: a slower trickle under a cap of 8 while Iron Maw fights.
  function spawnOriginal(run) {
    const quarry = run.quarryState === "active";
    if (!run.pacing.allowSpawns(quarry || trialActive(run))) return;
    if (hostiles() >= (quarry ? QUARRY_CAP : MAX_HOSTILES)) return;
    ctx.enemies?.spawn?.();
    run.spawnTimer = (quarry ? QUARRY_INTERVAL : Math.max(0.3, 1.5 - 0.12 * run.wave)) / difficultyScale();
  }

  // KEEPERS (F1.3, §1.4): a keeper fight trickles at its own cadence under its own cap (the
  // keeper and its summons count), ignoring the lull; otherwise the Wave-1 cadence under the
  // ledger's clamped cap. Every ambient spawn may roll an elite (enemies decide).
  function spawnKeepers(run) {
    const keeper = run.keeperState === "active" ? keeperDef(run.keeper?.id ?? stageDef(run.stage).keeper) : null;
    if (!run.pacing.allowSpawns(!!keeper || trialActive(run))) return;
    const cap = keeper ? keeper.liveCap + ledgerSum("keeperLiveCap") : hostileCap(ledgerSum("liveCap"));
    if (hostiles() >= cap) return;
    ctx.enemies?.spawn?.(null, null, AMBIENT);
    const interval = keeper ? keeper.trickle : Math.max(0.3, 1.5 - 0.12 * run.wave);
    run.spawnTimer = (interval / hpScale()) * ledgerMul("spawnInterval");
  }

  // Waves follow total run time. A surge blocked by a rest, lull, boss or keeper fight is
  // skipped, not deferred.
  function riftSurge(run) {
    const wave = 1 + Math.floor(run.elapsed / FLOW.WAVE_LENGTH);
    if (run.tutorial || wave <= run.wave) return;
    run.wave = wave;
    if (run.bossSpawned || run.keeperState === "active" || !run.pacing.allowSpawns(trialActive(run))) return;
    toast("RIFT SURGE · STAY MOVING");
    sfx("level");
    if (run.original) {
      heal(FLOW.SURGE_HEAL, "surge");
      for (let i = 0; i < Math.min(wave, SURGE_MAX) && hostiles() < MAX_HOSTILES; i++) ctx.enemies?.spawn?.();
      return;
    }
    heal(FLOW.SURGE_HEAL * ledgerMul("surgeHeal"), "surge");
    const cap = hostileCap(ledgerSum("liveCap"));
    const planned = Math.min(wave, SURGE_MAX) + ledgerSum("surgeExtra");
    let count = 0;
    for (let i = 0; i < planned && hostiles() < cap; i++) if (ctx.enemies?.spawn?.(null, null, SURGE)) count++;
    ctx.bus.emit("surge", { wave, count });
  }

  // ---- the fixed step -------------------------------------------------------------------

  // One in-run simulation step (spec flow.md §7, ARCHITECTURE §6). Also driven by the
  // attract demo's sub-steps.
  function simulate(dt) {
    const run = ctx.run;
    if (!run || !live(run)) return;
    if (run.scenario && !run.mortal && run.player) run.player.inv = 2; // developer scenarios never die unless mortal
    run.elapsed += dt;
    run.stageTime += dt;
    run.entranceHold = Math.max(0, run.entranceHold - dt);
    run.pacing.tick(dt);
    ctx.mods?.tick?.(dt); // dash traits and cue timers, before the hero moves
    ctx.player?.update?.(dt);
    ctx.combat?.updateFiring?.(dt);
    if (run.tutorial) ctx.tutorial?.update?.(dt); // the toll step's bell (F2)
    if (atPortal(run) && enterStage()) return;
    spawnAmbient(run, dt);
    riftSurge(run);
    if (run.dais) updateDais(run, dt);
    ctx.enemies?.update?.(dt);
    if (!live(run)) return;
    ctx.combat?.update?.(dt);
    ctx.enemies?.sweep?.();
    if (!live(run)) return;
    ctx.combat?.updateHazards?.(dt);
    if (!live(run)) return;
    ctx.encounters?.update?.(dt);
    ctx.progression?.update?.();
    ctx.audio?.update?.(dt);
  }

  // Simulation-time visuals that keep animating in sequences: particles, rings, the portal.
  function effects(dt) {
    ctx.fx?.update?.(dt);
    ctx.world?.portal?.update?.(dt, ctx.run?.elapsed ?? 0);
  }

  function skullStep(dt) {
    ctx.menus?.updateSkull?.(dt);
  }

  function menuStep(dt) {
    if (beat) tickDeathBeat(dt);
    else if (results) showResults();
    else ctx.demo?.update?.(dt);
  }

  function sequenceStep(dt) {
    updateSequence(dt);
    effects(dt);
  }

  // Hit-stop skips whole simulation steps; the camera and HUD keep running. dt is already
  // scaled by the game speed, so hit-stop composes with it.
  function playStep(dt) {
    if (ctx.fx?.tickHitstop?.(dt)) return;
    simulate(dt);
    if (ctx.mode === "play") effects(dt);
  }

  // The weather gates its own storm (Nightmare, play or demo, no overlay).
  function viewStep(dt) {
    ctx.cam?.update?.(dt);
    ctx.world?.statues?.face?.(ctx.gfx?.camera);
    ctx.weather?.update?.(dt);
  }

  function hudStep(dt) {
    ctx.hud?.combat?.(dt);
    if (ctx.mode === "play") ctx.hud?.update?.(dt);
  }

  // Returns false when the frame must stop stepping (paused, a card or a panel is open). A
  // transition whose timeline has finished ends here, before this step's mode work.
  function step(dt) {
    guard("skull", skullStep, dt);
    if (transit && !ctx.transition?.active?.()) guard("transition", settleTransition);
    const mode = ctx.mode;
    if (mode === "menu" || mode === "dead") guard("menu", menuStep, dt);
    else if (mode === "sequence") guard("sequence", sequenceStep, dt);
    else if (mode === "play" && !ctx.overlay) guard("play", playStep, gameDt(dt));
    guard("view", viewStep, dt);
    guard("hud", hudStep, dt);
    return ctx.mode !== "pause" && ctx.mode !== "upgrade" && !ctx.overlay;
  }

  // ---- assists (F18.5) --------------------------------------------------------------------

  // A run is marked ASSISTED for good the moment it leans on game speed below 100, auto-fire
  // "always" or aim assist "high"; bus "assisted" { kinds, speed } announces each change. The
  // attract demo ignores every assist.
  function trackAssists(run) {
    if (!run || run.demo || run.over) return;
    const speed = speedOf(run);
    if (markAssists(run.flags, assistKinds(ctx.prefs, speed), speed)) {
      writeModeBadge(run);
      ctx.bus.emit("assisted", { kinds: [...run.flags.assistKinds], speed: run.flags.assistSpeed });
    }
  }

  // ---- campaign sequences ---------------------------------------------------------------

  const testWithoutSequences = () => !!globalThis.__RIFTBORN_TEST__ && !globalThis.__RIFTBORN_TEST_SEQUENCES__;

  function prepareActor(seq, actor) {
    seq.actor = actor;
    actor.grace = 0;
    actor.state = "approach";
    actor.timer = 0;
    actor.cooldown = Math.max(actor.cooldown || 0, 1.5);
    const g = actor.model?.g;
    if (!g) return;
    seq.scale = { x: g.scale.x, y: g.scale.y, z: g.scale.z };
    g.visible = true;
    if (!g.parent) ctx.gfx?.layers?.actors?.add(g);
  }

  function showCaption(seq) {
    ctx.menus?.sequence?.({ title: seq.title, text: seq.text, skipLabel: seq.paused ? "CONTINUE" : seq.skipLabel });
  }

  // Refused in the demo, the tutorial, automated tests, after the run ended, or while
  // another sequence runs. Combat (shots, hazards) and mods (scars, pulls, the build cue)
  // clear themselves on the "sequence" event; a pending echo and the wake stay frozen.
  function beginSequence(kind, actor = null, done = null) {
    const run = ctx.run;
    if (!run || run.demo || run.tutorial || run.over || ctx.cinematic || testWithoutSequences()) return false;
    const seq = new CampaignSequence(kind, run.stage);
    seq.done = done;
    if (actor) prepareActor(seq, actor);
    ctx.enemies?.clearWarnings?.();
    ctx.input?.clear?.();
    ctx.cinematic = seq;
    setMode("sequence");
    ctx.menus?.hidePause?.();
    setBodyClass("menu-open", false);
    setBodyClass("in-sequence", true);
    showCaption(seq);
    sfx(seq.cue);
    ctx.bus.emit("sequence", { kind, active: true });
    return true;
  }

  function updateSequence(dt) {
    const seq = ctx.cinematic;
    if (!seq || doc?.hidden || seq.paused) return;
    const e = seq.actor;
    const g = e?.model?.g;
    if (g && !ctx.env?.reduced) animateActor(seq, e, g, dt);
    if (seq.tick(dt)) completeSequence();
  }

  // Maw rises out of the ground, the Warden descends, the dying Warden shrinks and spins.
  function animateActor(seq, e, g, dt) {
    const p = seq.progress;
    const floor = ground(e.x, e.z);
    if (seq.kind === "maw") g.position.y = floor - Math.max(0, 1 - p * 2) * 2;
    else if (seq.kind === "warden") g.position.y = floor + Math.max(0, 1 - p * 1.6) * 5;
    else if (seq.kind === "victory" && seq.scale) {
      const k = Math.max(0.02, 1 - p);
      g.scale.set(seq.scale.x * k, seq.scale.y * k, seq.scale.z * k);
      g.rotation.y += dt * 0.5;
      if (Math.random() < dt * 14) ctx.fx?.burst?.(e.x, 2, e.z, "#d4bc78", 3, 2);
    }
  }

  function completeSequence() {
    const seq = ctx.cinematic;
    const run = ctx.run;
    if (!seq) return;
    resetSequence();
    // A reward or decision still open under the cinematic (a keeper woken while a card screen
    // was up) keeps its screen; play resumes when it is chosen.
    setMode(run?.activeReward ? "upgrade" : "play");
    ctx.input?.clear?.();
    if (run?.player) run.player.inv = Math.max(run.player.inv, SEQUENCE_GRACE);
    if (run) {
      run.spawnTimer = Math.max(run.spawnTimer, 1);
      if (seq.kind === "stage" || seq.kind === "opening") run.pacing.recover(3);
      if (seq.kind === "maw" || seq.kind === "warden") run.entranceHold = ENTRANCE_HOLD;
    }
    seq.done?.();
    ctx.hud?.update?.();
  }

  // Restores the actor's height and scale; the victory actor leaves the scene with it.
  function resetSequence() {
    const seq = ctx.cinematic;
    if (!seq) return;
    const e = seq.actor;
    const g = e?.model?.g;
    if (g) {
      g.position.y = ground(e.x, e.z) + (e.y || 0);
      if (seq.scale) g.scale.set(seq.scale.x, seq.scale.y, seq.scale.z);
    }
    if (e && seq.kind === "victory") ctx.enemies?.remove?.(e);
    ctx.cinematic = null;
    ctx.menus?.sequence?.(null);
    setBodyClass("in-sequence", false);
    ctx.bus.emit("sequence", { kind: seq.kind, active: false });
  }

  function skipSequence() {
    if (ctx.cinematic?.skip()) completeSequence();
  }

  function setSequencePaused(paused) {
    const seq = ctx.cinematic;
    if (!seq || seq.paused === paused) return;
    seq.paused = paused;
    showCaption(seq);
  }

  // ---- pause ----------------------------------------------------------------------------

  // Pauses the cinematic or the run (header PAUSE, focus loss, opening a panel).
  function pause() {
    if (ctx.cinematic) {
      setSequencePaused(true);
      return;
    }
    const run = ctx.run;
    if (ctx.mode !== "play" || !run || run.over) return;
    ctx.input?.clear?.();
    setMode("pause");
    setBodyClass("menu-open", true);
    ctx.menus?.showPause?.();
  }

  function resume() {
    if (ctx.cinematic) {
      setSequencePaused(false);
      return;
    }
    if (ctx.mode !== "pause" || ctx.overlay) return;
    ctx.input?.clear?.();
    setMode("play");
    setBodyClass("menu-open", false);
    ctx.menus?.hidePause?.();
    const p = ctx.run?.player;
    if (p) p.inv = Math.max(p.inv, RESUME_GRACE);
  }

  // The pause binding / pad Start: toggles the cinematic or the run; closes an open panel
  // first. Reward cards cannot be paused, and a transition ignores it until IN ends.
  function togglePause() {
    if (transit) return;
    if (ctx.cinematic) setSequencePaused(!ctx.cinematic.paused);
    else if (ctx.overlay) ctx.menus?.closePanel?.();
    else if (ctx.mode === "play") pause();
    else if (ctx.mode === "pause") resume();
  }

  // Focus loss pauses (never toggles); it can arrive twice (blur, then hidden). During a
  // transition it waits for the transition's end.
  function onBlur() {
    if (transit) blurred = true;
    else if (ctx.cinematic) setSequencePaused(true);
    else if (ctx.mode === "play") pause();
  }

  // ---- Death Mode -----------------------------------------------------------------------

  // Menu-only toggle; the attract demo restarts on its next stage with the new tuning.
  function setDeathMode(on) {
    if (ctx.mode !== "menu" && ctx.mode !== "dead") return false;
    ctx.menuDeath = !!on;
    ctx.menus?.setDeathMode?.(ctx.menuDeath);
    ctx.demo?.finish?.();
    return true;
  }

  // "input:interact" belongs to encounters (ARCHITECTURE §5.16); binding it here too would
  // dispatch every interaction twice.
  ctx.bus.on("input:pause", togglePause);
  ctx.bus.on("input:blur", onBlur);
  // A settings change may lean on an assist mid-run (the pause menu confirms it first).
  ctx.bus.on("prefs", () => trackAssists(ctx.run));
  // Toggle fire never keeps shooting into a Castellan's vigil (F18.3): input returns true when
  // it released a latched toggle.
  ctx.bus.on("boss", ({ event } = {}) => {
    if (event === "vigil" && ctx.input?.releaseFireLatch?.()) toast("VIGIL · FIRE LOCK RELEASED");
  });

  return {
    step,
    setMode,
    start,
    toMenu,
    returnToMenu,
    pause,
    resume,
    togglePause,
    activatePortal,
    enterStage,
    beginSequence,
    skipSequence,
    finishRun,
    onKill,
    difficultyScale,
    spawnHpFactor,
    hpScale,
    speedScale,
    damageScale,
    rewardKey,
    milestone,
    setDeathMode,
    simulate,
    effects,
    // A practice scenario's MODE text for the badge (the ruleset and assist segments follow).
    modeBadge(text) {
      badgeMode = text ? String(text) : null;
      writeModeBadge(ctx.run);
    },
  };
}
