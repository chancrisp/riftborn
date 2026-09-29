// Mosaic transitions (ctx.transition, IMPROVEMENTS F20): the PS1 mosaic swirl covers a scene
// change. OUT (0.45 s) grows the mosaic blocks 1 -> 24 px, the swirl, the colour crush and a
// fade in 15 fps steps; the midpoint callback (a stage build, the results) runs under a fully
// covered screen; IN (0.45 s) plays it back. Reduced motion or Reduce flashes use a plain
// 0.3 s fade to black each way instead, with the same mode and rules.
//
// The timeline runs on real time (ctx.time.real, advanced by main.js), so hit-stop and game
// speed never stretch it; the renderer ticks update() once per rendered frame. From OUT start
// to IN end the director is in mode "transition" (view and HUD only: no simulation, portal
// check or player input), body.in-transition hides the HUD, and bus "transition"
// { kind, phase: "out" | "mid" | "in" } marks each phase. run() returns a Promise that
// resolves true when this request completes (after IN), or false when it was dropped.
//
// Not re-entrant: a request of the kind already running or waiting is dropped; a different
// kind waits (at most one), and any request waits while a cinematic sequence plays.
import { clamp } from "../core/util.js";

export const TRANSITION_OUT = 0.45;
export const TRANSITION_IN = 0.45;
export const PLAIN_FADE = 0.3;
const STEP_FPS = 15;
const MOSAIC_MAX = 24;
const MAX_DT = 0.1; // a stalled frame advances at most this much, so OUT is never skipped
const DEFAULT_COLOR = "#1a0d2a";
const PLAIN_COLOR = "#000000";
// The results after a death fade to dried blood instead of the rift violet.
const KIND_COLORS = Object.freeze({ death: "#2a0608" });
const NEUTRAL = Object.freeze({ mosaic: 1, swirl: 0, crush: 0, fade: 0, fadeColor: PLAIN_COLOR });

// Coverage 0..1 at time t (seconds since OUT began; the midpoint sits at the end of OUT).
function coverage(t, plain) {
  if (plain) {
    if (t < PLAIN_FADE) return clamp(t / PLAIN_FADE, 0, 1);
    return t < PLAIN_FADE * 2 ? 1 - (t - PLAIN_FADE) / PLAIN_FADE : 0;
  }
  const stepped = (x) => Math.floor(x * STEP_FPS + 1e-9) / STEP_FPS;
  if (t < TRANSITION_OUT) return clamp(stepped(Math.max(0, t)) / TRANSITION_OUT, 0, 1);
  if (t < TRANSITION_OUT + TRANSITION_IN) return 1 - clamp(stepped(t - TRANSITION_OUT) / TRANSITION_IN, 0, 1);
  return 0;
}

// The post uniforms of a transition at time t: { mosaic (px), swirl, crush, fade (0..1),
// fadeColor }. mosaicUniforms(TRANSITION_OUT, kind) is the fully covered midpoint.
export function mosaicUniforms(t, kind, { plain = false } = {}, out = {}) {
  const p = coverage(t, plain);
  out.mosaic = plain ? 1 : 1 + Math.round((MOSAIC_MAX - 1) * p);
  out.swirl = plain ? 0 : p;
  out.crush = plain ? 0 : p;
  out.fade = p;
  out.fadeColor = plain ? PLAIN_COLOR : (KIND_COLORS[kind] ?? DEFAULT_COLOR);
  return out;
}

// Seconds of OUT and the whole timeline for a style.
const outTime = (plain) => (plain ? PLAIN_FADE : TRANSITION_OUT);
const totalTime = (plain) => (plain ? PLAIN_FADE * 2 : TRANSITION_OUT + TRANSITION_IN);

export function createTransition(ctx) {
  const uniforms = {};
  let current = null; // the running transition
  let queued = null; // at most one waiting request
  let broken = false; // the post uniforms failed once: plain fades from then on

  const now = () => ctx.time?.real ?? 0;
  const plainWanted = () => broken || !!ctx.env?.reduced || ctx.prefs?.flashes === false;
  const emit = (phase) => ctx.bus?.emit?.("transition", { kind: current.kind, phase });
  const setMode = (mode) => ctx.director?.setMode?.(mode);

  function setCovered(on) {
    globalThis.document?.body?.classList?.toggle("in-transition", on);
  }

  // Pushes this moment's uniforms to the renderer. A failure (a lost context, a shader that
  // did not compile) switches to the plain fade and never blocks the flow.
  function paint(t) {
    mosaicUniforms(t, current?.kind, { plain: current?.plain ?? true }, uniforms);
    try {
      ctx.gfx?.setMosaic?.(uniforms);
    } catch (err) {
      if (!broken) console.error("[transition] mosaic failed; using a plain fade", err);
      broken = true;
      if (current) current.plain = true;
    }
  }

  function warp(reverse) {
    try {
      ctx.audio?.fx?.("riftWarp", 1, { reverse });
    } catch {
      // Audio is optional; the transition never depends on it.
    }
  }

  function begin(request) {
    current = { ...request, t: 0, last: now(), plain: plainWanted(), phase: "out", covered: false, before: ctx.mode, after: null };
    setCovered(true);
    setMode("transition");
    warp(false);
    emit("out");
    paint(0);
  }

  // The covered moment: the caller swaps the world (the frame before was drawn fully covered,
  // so its hitch never shows). A mode the callback sets (a run start enters play) is kept for
  // the end of IN; the director stays in "transition" until then. IN starts after the hitch.
  function midpoint() {
    current.phase = "mid";
    try {
      current.midpoint?.();
    } catch (err) {
      console.error(`[transition] ${current.kind} midpoint failed`, err);
    }
    current.after = ctx.mode !== "transition" ? ctx.mode : current.before;
    setMode("transition");
    emit("mid");
    current.phase = "in";
    current.last = now();
    warp(true);
    emit("in");
  }

  function finish() {
    const done = current;
    current = null;
    try {
      ctx.gfx?.setMosaic?.(NEUTRAL);
    } catch {
      broken = true;
    }
    setCovered(false);
    setMode(done.after ?? done.before);
    done.resolve(true);
  }

  // Advances the running transition to the current real time (idempotent within a frame), or
  // starts a waiting one once no cinematic holds it back.
  function update() {
    if (!current) {
      if (!queued || ctx.cinematic) return;
      const next = queued;
      queued = null;
      begin(next);
    }
    const t = now();
    if (current.phase === "out") {
      if (current.covered) midpoint();
      else {
        current.t = Math.min(outTime(current.plain), current.t + clamp(t - current.last, 0, MAX_DT));
        current.covered = current.t >= outTime(current.plain);
        current.last = t;
      }
      paint(current.t);
      return;
    }
    current.t += clamp(t - current.last, 0, MAX_DT);
    current.last = t;
    if (current.t >= totalTime(current.plain)) finish();
    else paint(current.t);
  }

  function run(kind, midpointFn) {
    const name = String(kind || "transition");
    if (current?.kind === name || queued) return Promise.resolve(false);
    return new Promise((resolve) => {
      const request = { kind: name, midpoint: midpointFn, resolve };
      if (current || ctx.cinematic) queued = request;
      else begin(request);
    });
  }

  return {
    run,
    update,
    // True from OUT start to IN end.
    active: () => !!current,
    // "out" | "mid" | "in" while running, else null.
    get phase() {
      return current?.phase ?? null;
    },
    get kind() {
      return current?.kind ?? null;
    },
  };
}
