// Developer practice (?practice=<scenario>, or ?scenario= on localhost): a registry of seeded
// scenario runs that jump to a stage, keeper or reward screen (IMPROVEMENTS §3.0.3), plus the
// #devTools panel of shortcuts. Profile storage and score submission are already off for the
// whole page in this mode.
//
// Packages add scenarios from their own modules: every factory created before this one can
// listen for bus "practice" { register } (emitted once, in practice mode only) and call
//   register(name, setup, { stage = 1, mortal = false, original = false })
// where setup(ctx, params, h) runs synchronously after director.start() and the stage build,
// with the opening sequence skipped, before the first simulation step. ctx.practice.register
// does the same later on. Outside practice, registration is a no-op.
//
// Global parameters (§3.15): &stage=N, &original=1, &mortal=0|1, &assist=1 (the run plays at
// 80% game speed and is marked ASSISTED), &board=local (a finish writes the local copy of the
// board the run would have reached), &persist=1 (read by the profile, F19).
import { keeperDef } from "../data/keepers.js";

const DEFAULT_SEED = 7361;
const DEFAULT_SCENARIO = "campaign";
const DEV_HP = 1000;
const DEV_INVULNERABILITY = 10000;
const ASSIST_SPEED = 80;
const LETHAL = 1e8;
const OBJECTIVE_PASSES = 8;
const METRICS_MS = 1000;
const PASSES_PER_FRAME = 2; // renderer.render() calls per displayed frame (scene + post pass)

const isWarden = (e) => e.boss === "warden" || e.kind === "warden";
const isMaw = (e) => e.boss === "ironmaw" || e.miniboss === true;
// The entrance sequence of a live boss: a keeper's own, else the Wave-1 Maw or Warden one.
const entranceOf = (boss) => keeperDef(boss.keeper)?.sequence ?? (isMaw(boss) ? "maw" : "warden");

// URL parameters (&key=value) typed by key: numbers, booleans ("1"/"true" or "0"/"false"),
// strings for everything else (kind, palette, board, ...). Unparseable values are dropped.
const NUMBER_PARAMS = new Set(["stage", "hp", "n"]);
const BOOLEAN_PARAMS = new Set(["original", "mortal", "persist", "assist"]);
const RESERVED_PARAMS = new Set(["practice", "scenario", "seed", "v"]);

export function parseParams(raw = {}) {
  const params = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (RESERVED_PARAMS.has(key)) continue;
    const text = String(value).trim().toLowerCase();
    if (NUMBER_PARAMS.has(key)) {
      const n = Number(text);
      if (text !== "" && Number.isFinite(n)) params[key] = n;
    } else if (BOOLEAN_PARAMS.has(key)) {
      if (text === "1" || text === "true") params[key] = true;
      else if (text === "0" || text === "false") params[key] = false;
    } else params[key] = String(value);
  }
  return params;
}

// The Wave-1 scenarios. `opening` keeps the campaign's opening sequence (every other scenario
// skips it).
function registerWave1(register, h) {
  const beginTrial = () => h.trialNearPlayer();
  register("campaign", () => {}, { opening: true });
  register("mods", (ctx) => {
    const run = ctx.run;
    const p = run.player;
    run.build.mods = [0, 1, 2, 3, 4];
    p.extra = 2;
    p.pierce = 2;
    p.damage = 2;
    p.rate = 1.5;
  });
  register("rewards", (ctx) => {
    ctx.progression?.queue?.("dev-mod", "major");
    ctx.progression?.queue?.("dev-upgrade", "ordinary");
    ctx.progression?.queue?.("dev-dash", "dash");
    ctx.progression?.showNext?.();
  });
  register("quarry", () => h.goalMet(), { stage: 2 });
  register("caldera", beginTrial, { stage: 3 });
  register("citadel", beginTrial, { stage: 4 });
  register("warden", () => h.goalMet(), { stage: 5 });
  for (let stage = 1; stage <= 5; stage++) register(`stage${stage}`, () => {}, { stage });
}

export function createPractice(ctx) {
  const doc = globalThis.document;
  const el = {};
  const scenarios = new Map(); // name -> { setup, stage, mortal, original, opening }
  let params = {};
  let built = false;
  let metricsTimer = 0;
  let lastFrame = 0;
  let lastTime = 0;

  const active = () => !!ctx.env?.debug?.practice;
  const playing = () => ctx.mode === "play" && !!ctx.run;

  function hurt(target) {
    ctx.combat?.hurtEnemy?.(target, LETHAL);
  }

  const place = (x, z) => ctx.player?.place?.(x, z);

  // ---- scenario registry ----------------------------------------------------------------

  function register(name, setup, { stage = 1, mortal = false, original = false, opening = false } = {}) {
    if (!active() || typeof name !== "string" || !name || typeof setup !== "function") return false;
    scenarios.set(name, Object.freeze({ setup, stage, mortal, original, opening }));
    if (built) syncScenarioList();
    return true;
  }

  // Helpers handed to every setup. Each delegates to the API of the package named beside it,
  // so a helper starts working as soon as that API lands.
  const h = {
    // Kill goal met now; the portal (or the stage's keeper) follows as in play. [P6]
    goalMet() {
      const run = ctx.run;
      if (!run) return;
      run.stageKills = run.stageGoal;
      ctx.director?.activatePortal?.();
    },
    // One monster at an exact point, bypassing the 17–26 m ambient rule. [P3 enemies.spawn]
    spawnAt: (kind, x, z, opts = {}) => ctx.enemies?.spawn?.(kind, { x, z }, opts) ?? null,
    // n monsters on a ring of radius r around the player. [P3 enemies.spawn]
    spawnRing(kind, n, r) {
      const p = ctx.run?.player;
      if (!p) return [];
      const spawned = [];
      for (let i = 0; i < n; i++) {
        const a = (i * Math.PI * 2) / n;
        const e = h.spawnAt(kind, p.x + Math.sin(a) * r, p.z + Math.cos(a) * r);
        if (e) spawned.push(e);
      }
      return spawned;
    },
    // A keeper now, optionally at a fraction of its HP; an optional keeper (the Bellwether)
    // wakes only once the kill goal is met, so it counts as met. [P1 bosses.startKeeper, run.keeper]
    keeper(id, { hpFraction } = {}) {
      if (keeperDef(id)?.optional && ctx.run) ctx.run.stageKills = Math.max(ctx.run.stageKills, ctx.run.stageGoal);
      if (!ctx.bosses?.startKeeper?.(id)) return null;
      const e = ctx.run?.keeper?.e ?? null;
      if (e && hpFraction > 0) e.hp = e.max * Math.min(1, hpFraction);
      return e;
    },
    // Keepers already broken this run, in defeat order (the Warden's shades). [P1]
    breakKeepers(ids = []) {
      if (ctx.run) ctx.run.flags.keepersBroken = [...ids];
    },
    // A deterministic build: { level, upgrades, mods, relics }. [P4 progression.grantBuild]
    grantBuild: (build, streamName = "cards") => ctx.progression?.grantBuild?.(build, streamName) ?? false,
    // A curse or trial statue at a point. [P5 world.statues.place]
    placeStatue: (x, z, kind) => ctx.world?.statues?.place?.(x, z, kind) ?? null,
    // Scenario invulnerability off (true) or back on (false). [P6]
    mortal(on = true) {
      if (ctx.run?.scenario) ctx.run.mortal = !!on;
      if (el.mortal) el.mortal.checked = !!on;
    },
    // The stage's Skull Trial started, with the player beside its statue. [P6]
    trialNearPlayer() {
      const statue = ctx.world?.statues?.list?.[0];
      if (statue) ctx.encounters?.beginTrial?.(statue);
      const anchor = ctx.run?.trial?.statue ?? statue;
      const spot = anchor && ctx.world?.terrain?.safeNear?.(anchor.x + 3, anchor.z, 0.45);
      if (spot) place(spot.x, spot.z);
    },
  };

  // ---- scenarios ------------------------------------------------------------------------

  // Seeded (&seed=, default 7361), named "Developer", no scores. Invulnerable unless the
  // scenario is mortal (its default, &mortal=, or the panel toggle); the dev HP stays a buffer.
  function start(name = ctx.env?.debug?.scenario) {
    const scenario = scenarios.has(name) ? name : DEFAULT_SCENARIO;
    const def = scenarios.get(scenario);
    params = parseParams(ctx.env?.debug?.params);
    panel();
    if (el.scenario) el.scenario.value = scenario;
    globalThis.__riftborn = ctx;
    if (ctx.overlay) ctx.menus?.closePanel?.();
    ctx.director?.setMode?.("menu");
    ctx.director?.setDeathMode?.(!!el.death?.checked);
    const run = ctx.director?.start?.({
      scenario,
      stage: params.stage ?? def.stage,
      seed: Number(ctx.env?.debug?.seed) || DEFAULT_SEED,
      name: "Developer",
      opening: def.opening,
      ruleset: (params.original ?? def.original) ? "original" : "keepers",
      speed: params.assist ? ASSIST_SPEED : null,
      board: params.board === "local" ? "local" : null,
    });
    if (!run?.player) return null;
    run.player.hp = run.player.max = DEV_HP;
    h.mortal(params.mortal ?? def.mortal);
    if (!run.mortal) run.player.inv = DEV_INVULNERABILITY;
    def.setup(ctx, params, h);
    const mode = `PRACTICE · ${run.death ? "DEATH" : "NORMAL"} · NO SCORES`;
    if (ctx.director?.modeBadge) ctx.director.modeBadge(mode);
    else {
      const badge = doc?.querySelector("#modeBadge");
      if (badge) badge.textContent = mode;
    }
    ctx.hud?.update?.();
    return run;
  }

  // ---- tools ----------------------------------------------------------------------------

  function startTrial() {
    const statue = ctx.world?.statues?.list?.[0];
    if (playing() && ctx.run.trial?.state === "available" && statue) ctx.encounters?.beginTrial?.(statue);
  }

  // Finishes whatever gates progress: the trial roster, the current boss or keeper, or the
  // kill goal.
  function resolveObjective() {
    const run = ctx.run;
    if (!playing()) return;
    if (run.trial?.state === "active") {
      for (let n = 0; n < OBJECTIVE_PASSES && run.trial.state === "active"; n++)
        for (const e of [...run.enemies]) if (e.trialId === run.trial.id && e.hp > 0) hurt(e);
    } else {
      const boss = ctx.bosses?.current?.();
      if (boss) hurt(boss);
      else
        for (let n = 0; n < run.stageGoal && run.stageKills < run.stageGoal && ctx.mode === "play"; n++) {
          const e = ctx.enemies?.spawn?.("runner");
          if (!e) break;
          hurt(e);
        }
    }
    ctx.progression?.showNext?.();
  }

  function enterRift() {
    const portal = ctx.world?.portal;
    if (playing() && ctx.run.portalActive && portal) place(portal.x, portal.z);
  }

  // Warden to 40% and its node event due now.
  function wardenPhase() {
    const boss = ctx.run?.enemies.find((e) => isWarden(e) && e.hp > 0);
    if (!boss) return;
    boss.hp = boss.max * 0.4;
    boss.nodeCooldown = 0;
  }

  // Anchors and nodes: combat forwards fixed objects to encounters.hurtObject.
  function breakObjects() {
    for (const o of [...(ctx.run?.objects ?? [])]) if (o.hp > 0) hurt(o);
  }

  // Parks the player behind a tall cover, facing it, to check the cutaway.
  function cameraObstruction() {
    const cover = ctx.world?.covers?.find((c) => c.sy > 4 && Math.hypot(c.x, c.z) < 50);
    const spot = cover && ctx.world?.terrain?.safeNear?.(cover.x, cover.z - 4, 0.45);
    if (!spot || !ctx.cam) return;
    place(spot.x, spot.z);
    ctx.cam.yaw = Math.atan2(cover.x - spot.x, cover.z - spot.z);
  }

  // Deliberately outside the 16..36 wheel clamp.
  function toggleZoom() {
    if (ctx.cam) ctx.cam.distance = ctx.cam.distance < 25 ? 40 : 16;
  }

  function toggleCutaway(button) {
    const cutaway = ctx.cam?.cutaway;
    if (!cutaway) return;
    cutaway.active = !cutaway.active;
    button.textContent = cutaway.active ? "Disable cutaway" : "Enable cutaway";
  }

  function visitLandmark() {
    const landmark = ctx.world?.landmark;
    if (playing() && landmark?.approach) place(landmark.approach.x, landmark.approach.z);
  }

  // Freezes a boss entrance cinematic (starting one for the live boss or keeper if none is
  // running).
  function holdEntrance() {
    if (ctx.cinematic) {
      ctx.director?.pause?.();
      return;
    }
    const boss = ctx.bosses?.current?.();
    if (boss && ctx.director?.beginSequence?.(entranceOf(boss), boss)) ctx.director.pause?.();
  }

  // The HUD slot overlap check (§3.13) in the live page: the overlapping pairs go to the
  // console, the verdict to the metrics line.
  function checkHud() {
    const overlaps = ctx.hud?.checkLayout?.();
    if (!Array.isArray(overlaps)) return;
    if (overlaps.length) console.warn("[practice] HUD overlaps", overlaps);
    if (el.metrics) el.metrics.textContent = overlaps.length ? `HUD OVERLAPS · ${overlaps.length}` : "HUD OK";
  }

  const TOOLS = [
    ["devReset", "RESET SCENARIO", () => start(el.scenario?.value)],
    ["devTrial", "START TRIAL", startTrial],
    ["devObjective", "RESOLVE OBJECTIVE", resolveObjective],
    ["devPortal", "ENTER OPEN RIFT", enterRift],
    ["devPhase", "WARDEN PHASE 2", wardenPhase],
    ["devNodes", "BREAK ANCHORS / NODES", breakObjects],
    ["devCamera", "Camera obstruction", cameraObstruction],
    ["devZoom", "Toggle zoom", toggleZoom],
    ["devCutaway", "Disable cutaway", toggleCutaway],
    ["devLandmark", "VISIT LANDMARK", visitLandmark],
    ["devEntrance", "HOLD BOSS ENTRANCE", holdEntrance],
    ["devCosmetics", "PREVIEW COSMETICS", () => ctx.profile?.previewCosmetics?.()],
    ["devHud", "CHECK HUD", checkHud],
  ];

  // ---- panel ----------------------------------------------------------------------------

  function make(tag, props = {}, ...children) {
    const node = doc.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  function syncScenarioList() {
    el.scenario.replaceChildren(...[...scenarios.keys()].map((name) => make("option", { value: name, textContent: name })));
  }

  function buildPanel(root) {
    el.scenario = make("select", { id: "devScenario" });
    syncScenarioList();
    el.death = make("input", { id: "devDeath", type: "checkbox" });
    el.mortal = make("input", { id: "devMortal", type: "checkbox" });
    el.mortal.addEventListener("change", () => h.mortal(el.mortal.checked));
    const buttons = TOOLS.map(([id, label, action]) => {
      const button = make("button", { id, type: "button", textContent: label });
      button.addEventListener("click", () => {
        try {
          action(button);
        } catch (err) {
          console.error(`[practice] ${label} failed`, err);
        }
      });
      return button;
    });
    el.metrics = make("output", { id: "devMetrics" });
    root.replaceChildren(
      make(
        "details",
        {},
        make("summary", { textContent: "DEVELOPER PRACTICE" }),
        el.scenario,
        make("label", {}, el.death, "Death Mode"),
        make("label", {}, el.mortal, "Mortal"),
        ...buttons,
      ),
      el.metrics,
    );
  }

  // Builds (once) and shows #devTools; returns it.
  function panel() {
    const root = doc?.querySelector("#devTools");
    if (!root) return null;
    if (!built) {
      built = true;
      buildPanel(root);
      startMetrics();
    }
    root.classList.remove("hidden");
    return root;
  }

  // Once a second: rendered FPS, live shots, live mod effects (when the mods system reports
  // them) and the last frame's draw calls (the §1.4 budget readout).
  function startMetrics() {
    if (metricsTimer) return;
    lastTime = performance.now();
    lastFrame = ctx.gfx?.renderer?.info?.render?.frame ?? 0;
    metricsTimer = setInterval(writeMetrics, METRICS_MS);
  }

  function writeMetrics() {
    if (!el.metrics || doc?.hidden) return;
    const now = performance.now();
    const frame = ctx.gfx?.renderer?.info?.render?.frame ?? 0;
    const seconds = Math.max(1e-3, (now - lastTime) / 1000);
    const fps = Math.round((frame - lastFrame) / PASSES_PER_FRAME / seconds);
    lastTime = now;
    lastFrame = frame;
    const effects = ctx.mods?.counts?.();
    const modLine = effects ? `${effects.scars ?? 0} scars · ${effects.pulls ?? 0} pulls · ` : "";
    el.metrics.textContent = `${fps} rendered FPS · ${ctx.run?.shots?.length ?? 0} shots · ${modLine}DRAWS ${ctx.gfx?.drawCalls?.() ?? 0}`;
  }

  registerWave1(register, h);
  if (active()) ctx.bus.emit("practice", { register });

  return {
    get active() {
      return active();
    },
    start,
    panel,
    register,
    // The current scenario's typed URL parameters (parseParams).
    get params() {
      return params;
    },
    get scenarios() {
      return [...scenarios.keys()];
    },
  };
}
