// Boot, wiring and the frame loop. Systems never import each other's factories: they
// talk through `ctx` (see docs/ARCHITECTURE.md §3) and the event bus.
import * as THREE from "three";
// Model registrations (keepers, creatures, props) must run before the first createMonster.
import "./render/models-keepers.js";
import "./render/models-creatures.js";
import "./render/models-props.js";
import { createBus } from "./core/bus.js";
import { SimulationClock, FramePacer } from "./core/clock.js";
import { loadPreferences, savePreferences } from "./input/preferences.js";
import { loadAtlas } from "./render/materials.js";
import { createRenderer } from "./render/renderer.js";
import { createCamera } from "./render/camera.js";
import { createWeather } from "./render/weather.js";
import { createFx } from "./render/fx.js";
import { createTelegraphs } from "./render/telegraphs.js";
import { createWorld } from "./world/world.js";
import { createAudio } from "./audio/audio.js";
import { createInput } from "./input/input.js";
import { createProfile } from "./meta/profile.js";
import { createScores } from "./meta/scores.js";
import { createHud } from "./ui/hud.js";
import { createMenus } from "./ui/menus.js";
import { createJournal } from "./ui/journal.js";
import { createLeaderboard } from "./ui/leaderboard.js";
import { createRules } from "./game/rules.js";
import { createTransition } from "./game/transition.js";
import { createRelics } from "./game/relics.js";
import { createAssist } from "./game/assist.js";
import { createPlayer } from "./game/player.js";
import { createCombat } from "./game/combat.js";
import { createMods } from "./game/mods.js";
import { createEnemies } from "./game/enemies.js";
import { createElites } from "./game/elites.js";
import { createBosses } from "./game/bosses.js";
import { createHazards } from "./game/hazards.js";
import { createEncounters } from "./game/encounters.js";
import { createProgression } from "./game/progression.js";
import { createScoring } from "./game/scoring.js";
import { createOmens } from "./game/omens.js";
import { createDirector } from "./game/director.js";
import { createTutorial } from "./game/tutorial.js";
import { createDemo } from "./game/demo.js";
import { createPractice } from "./game/practice.js";

const query = new URLSearchParams(location.search);
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
// Some hosts (a claude.ai page) pass only a bare #anchor, never the query string.
const hashScenario = /^#practice-([a-z0-9]+)$/i.exec(location.hash)?.[1]?.toLowerCase() ?? null;
const scenario = query.get("practice") || hashScenario || (loopback ? query.get("scenario") : null);

const ctx = {
  THREE,
  canvas: document.querySelector("#game"),
  bus: createBus(),
  prefs: loadPreferences(),
  savePrefs() {
    savePreferences(ctx.prefs);
  },
  env: {
    mobile: matchMedia("(pointer:coarse)").matches,
    touch: matchMedia("(pointer:coarse)").matches || navigator.maxTouchPoints > 0,
    reduced: matchMedia("(prefers-reduced-motion:reduce)").matches,
    debug: { practice: !!scenario, scenario, seed: Number(query.get("seed")) || null, params: Object.fromEntries(query) },
  },
  time: { real: 0, sim: 0 },
  mode: "menu",
  overlay: null,
  cinematic: null,
  run: null,
  menuDeath: false,
};

// Creation order (IMPROVEMENTS §3.0.1): rendering first (others add meshes), then world, IO,
// meta, the Rules Ledger, UI, then gameplay. No factory may call into a system created after
// it during construction.
const FACTORIES = [
  ["gfx", createRenderer],
  ["cam", createCamera],
  ["weather", createWeather],
  ["fx", createFx],
  ["tele", createTelegraphs],
  ["world", createWorld],
  ["audio", createAudio],
  ["input", createInput],
  ["profile", createProfile],
  ["scores", createScores],
  ["rules", createRules],
  ["hud", createHud],
  ["menus", createMenus],
  ["journal", createJournal],
  ["leaderboard", createLeaderboard],
  ["transition", createTransition],
  ["relics", createRelics],
  ["assist", createAssist],
  ["player", createPlayer],
  ["combat", createCombat],
  ["mods", createMods],
  ["enemies", createEnemies],
  ["elites", createElites],
  ["bosses", createBosses],
  ["hazards", createHazards],
  ["encounters", createEncounters],
  ["progression", createProgression],
  ["scoring", createScoring],
  ["omens", createOmens],
  ["director", createDirector],
  ["tutorial", createTutorial],
  ["demo", createDemo],
  ["practice", createPractice],
];

const clock = new SimulationClock();
const pacer = new FramePacer();
let last = performance.now();
let slowFrames = 0,
  fastFrames = 0;
let errorBudget = 20;

function report(where, err) {
  if (errorBudget-- > 0) console.error(`[riftborn] ${where} failed`, err);
}

function step(dt) {
  ctx.time.sim += dt;
  try {
    return ctx.director.step(dt) !== false;
  } catch (err) {
    report("step", err);
    return true;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000;
  last = now;
  ctx.time.real += Math.max(0, Math.min(raw, 0.25));
  try {
    ctx.input.poll(now);
  } catch (err) {
    report("input", err);
  }
  clock.advance(raw, !document.hidden, step);
  if (pacer.ready(now, Number(ctx.prefs.fpsCap) || 0)) {
    try {
      ctx.fx.frame(raw);
      ctx.gfx.render();
    } catch (err) {
      report("render", err);
    }
  }
  // Adaptive quality with hysteresis: sustained slow frames step the internal resolution
  // down one notch; a long run of fast frames lets it recover.
  if (raw > 0.045) {
    slowFrames++;
    fastFrames = 0;
  } else {
    slowFrames = Math.max(0, slowFrames - 1);
    fastFrames = raw < 0.02 ? fastFrames + 1 : 0;
  }
  if (slowFrames > 100) {
    slowFrames = 0;
    ctx.gfx.reduceQuality?.();
  } else if (fastFrames > 1800) {
    fastFrames = 0;
    ctx.gfx.restoreQuality?.();
  }
}

async function boot() {
  const note = document.querySelector("#loadNote");
  try {
    await Promise.race([loadAtlas(), new Promise((r) => setTimeout(r, 6000))]);
    for (const [key, factory] of FACTORIES) ctx[key] = factory(ctx);
    addEventListener("resize", () => ctx.gfx.resize());
    if (ctx.env.debug.practice) window.__riftborn = ctx;
    window.gameReady = true;
    ctx.menus.setReady();
    if (ctx.env.debug.practice) ctx.practice.start(scenario);
    else ctx.director.toMenu();
    requestAnimationFrame((t) => {
      last = t;
      frame(t);
    });
  } catch (err) {
    console.error("[riftborn] boot failed", err);
    if (note) note.textContent = "The 3D game could not load. Enable WebGL / hardware acceleration and reload.";
  }
}

boot();
