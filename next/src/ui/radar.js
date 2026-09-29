// Rift Radar (IMPROVEMENTS F16.1): a camera-up, Soliton-style radar in <canvas id="radar">,
// created by hud.js. It is limited by fog and by what the player has seen: ordinary hostiles
// show within 14 m, or beyond it only if they were on screen in the last 3 s (the rest add rim
// static); statues and the landmark appear once looked at. Keepers, bosses, the portal and the
// dais are always shown and pinned to the rim when out of range. Redrawn at 20 Hz on play steps
// with fillRect, so it freezes with the game; hidden outside runs, in sequences and the demo.
import { PALETTES, ENEMY_CLASS, TRIAL_MARK, validPalette } from "../data/palettes.js";
import { AFFIXES } from "../data/affixes.js";
import { POWERUPS } from "../data/progression.js";
import { CHALLENGE } from "../data/enemies.js";

export const RADAR = Object.freeze({
  size: 56, // drawing buffer (phones: 36), shown at twice the size
  phoneSize: 36,
  near: 14, // ordinary hostiles and powerups always show inside this
  propRange: 12,
  seenFor: 3, // seconds a hostile stays on the radar after leaving the screen
  darkScale: 0.6,
  darkCap: 18,
  redrawEvery: 3, // play steps: 20 Hz
  lookEvery: 12, // play steps: the 5 Hz "on screen" test
  sweepPeriod: 2,
  sweepSteps: 16,
  sweepGlow: 0.25,
  heightTick: 2,
});

const FACE = "#10141e";
const FACE_ALPHA = 0.88;
const BEZEL_LIGHT = "#8e9180";
const BEZEL_DARK = "#111318";
const RING = "#2a3040";
const SWEEP = "#35536a";
const PLAYER = "#a2fff1";
const HEAVY = "#ec9a54";
const BURROWED = "#5a4450";
const SHADE = "#d9d2b0";
const ANCHOR = "#b887bc";
const NODE = "#e1ae74";
const PORTAL = "#b974ff";
const PORTAL_LOCKED = "#4a3a60";
const DAIS = "#ba80ef";
const STATUE = "#bc565a";
const STATUE_USED = "#51474a";
const LANDMARK = "#d4bc78";
const LANDMARK_CLAIMED = "#6a5e3c";
const BELL = "#d2cba6";
const CACHE = "#d4bc78";
const PROP = "#8e9180";
const PROP_SPENT = "#44463e";
const STATIC = "#56607a";
const ATTACK = "#ff5a4f";
const HEAVY_KINDS = new Set(["brute", "splitter", "broodmother"]);
const CORNER = 0.22; // octagon corner cut, as a fraction of the size

// Glyphs as row strings, centred on the blip.
const bitmap = (...rows) => {
  const out = [];
  const h = rows.length,
    w = rows[0].length;
  rows.forEach((row, y) => [...row].forEach((c, x) => c === "#" && out.push(x - Math.floor(w / 2), y - Math.floor(h / 2))));
  return Object.freeze({ offsets: Int8Array.from(out), w, h });
};
const rotate = (rows) => rows[0].split("").map((_, x) => rows.map((row) => row[row.length - 1 - x]).join(""));

const ARROW_N = [".#.", "###", "#.#"];
const ARROW_NE = ["###", ".##", "#.#"];
function arrows() {
  const out = [];
  let n = ARROW_N,
    ne = ARROW_NE;
  for (let q = 0; q < 4; q++) {
    out.push(bitmap(...n), bitmap(...ne));
    n = rotate(n);
    ne = rotate(ne);
  }
  // rotate() turns counter-clockwise (N, NE -> W, NW -> S, SW -> E, SE); list them clockwise.
  return [out[0], out[1], out[6], out[7], out[4], out[5], out[2], out[3]];
}

export const GLYPHS = Object.freeze({
  dot: bitmap("#"),
  ranged: bitmap("###", "#.#", "###"),
  heavy: bitmap("###", "###", "###"),
  worm: bitmap("##", "##"),
  burrow: bitmap("##"),
  chargeUp: bitmap(".#.", "###"),
  chargeDown: bitmap("###", ".#."),
  chargeLeft: bitmap(".#", "##", ".#"),
  chargeRight: bitmap("#.", "##", "#."),
  skull: bitmap(".###.", "#####", "#.#.#", "#####", ".#.#."),
  shade: bitmap("###", "#.#", "#.#"),
  diamond: bitmap(".#.", "#.#", ".#."),
  rift: bitmap(".###.", "#...#", "#.#.#", "#...#", ".###."),
  crown: bitmap("#.#.#", "#.#.#", "#####", "#...#", "#####"),
  statue: bitmap("###", "#.#", ".#."),
  question: bitmap("##.", "..#", ".#.", "...", ".#."),
  bell: bitmap(".#.", "###", "#.#"),
  cross: bitmap("#.#", ".#.", "#.#"),
  cache: bitmap("##", "##"),
  arrows: Object.freeze(arrows()),
});

// ---- pure helpers -------------------------------------------------------------------------------

// Range R in metres: the preference, cut to half the fog's far distance, and under the Omen of
// Darkness to 60% of that and at most 18 m.
export function radarRange(preferred, fogFar, dark = false) {
  const pref = Number(preferred) > 0 ? Number(preferred) : 30;
  let range = Number.isFinite(fogFar) && fogFar > 0 ? Math.min(pref, fogFar * 0.5) : pref;
  if (dark) range = Math.min(range * RADAR.darkScale, RADAR.darkCap);
  return range;
}

// prefs.radar -> "full" | "threats" | "off": auto is Full under KEEPERS, Threats under ORIGINAL.
export function radarMode(pref, original) {
  if (pref === "full" || pref === "threats" || pref === "off") return pref;
  return original ? "threats" : "full";
}

// World offset -> radar pixel, camera-up (the basis movement uses): screen right is
// (cos yaw, -sin yaw), screen down (toward the camera) is (sin yaw, cos yaw).
export function radarPoint(dx, dz, camYaw, range, size, out = {}) {
  const half = size / 2,
    scale = (half - 3) / range,
    c = Math.cos(camYaw),
    s = Math.sin(camYaw);
  out.x = half + (c * dx - s * dz) * scale;
  out.y = half + (s * dx + c * dz) * scale;
  out.inRange = Math.hypot(dx, dz) <= range;
  return out;
}

// Moves an out-of-range point onto the rim (inside the octagon's corner cuts).
export function pinToRim(point, size) {
  const half = size / 2,
    rim = half - 4,
    dx = point.x - half,
    dy = point.y - half,
    d = Math.hypot(dx, dy);
  if (d > rim && d > 0) {
    point.x = half + (dx / d) * rim;
    point.y = half + (dy / d) * rim;
  }
  return point;
}

// Full-mode rule for an ordinary hostile: "blip", "static" (an unseen speck on the rim) or
// "hidden". seenT is the last sim time it was on screen (undefined: never).
export function blipVisibility({ dist, seenT, now, range, dark = false, fogNear = Infinity, anyRange = false }) {
  if (anyRange) return "blip";
  if (dark && dist > fogNear) return "hidden";
  if (dist > range) return "hidden";
  if (dist <= RADAR.near) return "blip";
  if (Number.isFinite(seenT) && now - seenT <= RADAR.seenFor) return "blip";
  return dark ? "hidden" : "static";
}

// Distance from (x, z) to a world-space polyline [x0, z0, x1, z1, ...].
export function distanceToPath(path, x, z) {
  let best = Infinity;
  for (let i = 2; i < path.length; i += 2) {
    const ax = path[i - 2],
      az = path[i - 1],
      dx = path[i] - ax,
      dz = path[i + 1] - az,
      l = dx * dx + dz * dz,
      t = l ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  if (path.length === 2) best = Math.hypot(path[0] - x, path[1] - z);
  return best;
}

// Whether a live telegraph (a tele.active() row) threatens the player: a charge lane passing
// within 3 m, an aim line reaching the player, or any other footprint within 8 m. A caller's
// meta.targetsPlayer === true always counts.
export function threatTargetsPlayer(row, player) {
  if (!row || !player) return false;
  if (row.targetsPlayer === true) return true;
  if (row.path && row.cls === "charge") return distanceToPath(row.path, player.x, player.z) < 3;
  if (row.path && row.cls === "aim") return distanceToPath(row.path, player.x, player.z) < 1.5;
  if (row.path) return distanceToPath(row.path, player.x, player.z) < 8;
  return Math.hypot(row.x - player.x, row.z - player.z) - (row.radius || 0) < 8;
}

const isBoss = (e) => !!(e.keeper || e.boss || e.miniboss);

// ---- the radar ----------------------------------------------------------------------------------

export function createRadar(ctx) {
  const doc = globalThis.document;
  const canvas = doc?.createElement?.("canvas") ?? null;
  if (canvas) {
    canvas.id = "radar";
    canvas.className = "ui-scaled hidden";
    canvas.setAttribute("aria-hidden", "true");
    canvas.width = canvas.height = RADAR.size;
    doc.body?.append?.(canvas);
  }
  const g = canvas?.getContext?.("2d") ?? null;
  const phone = globalThis.matchMedia?.("(max-width: 700px)") ?? null;
  const frames = new Map(); // size -> pre-drawn face, bezel and range rings
  const seen = new WeakSet(); // statues, the landmark and the bell looked at this stage
  const point = { x: 0, y: 0, inRange: false };
  const style = { glyph: GLYPHS.dot, color: STATIC };
  const screen = { x: 0, y: 0, visible: false };
  const brighter = new Map();
  let shown = false;
  let steps = 0;
  let size = RADAR.size;
  let frameTick = 0;

  const groundAt = (x, z) => {
    const h = ctx.world?.height?.(x, z);
    return Number.isFinite(h) ? h : 0;
  };
  const now = () => ctx.run?.elapsed ?? 0;
  const reduced = () => ctx.prefs?.flashes === false;
  const palette = () => PALETTES[validPalette(ctx.prefs?.palette)];

  function visibleNow(run) {
    if (!run || run.demo || !run.player || ctx.mode === "sequence" || ctx.cinematic || ctx.mode === "menu" || ctx.mode === "dead") return false;
    if (run.tutorial) return run.tutorial.step === "rift";
    return radarMode(ctx.prefs?.radar, run.original) !== "off";
  }

  function show(on) {
    if (on === shown || !canvas) return;
    shown = on;
    canvas.classList.toggle("hidden", !on);
  }

  // Called every step by the HUD; dt > 0 only on play steps, which alone advance the radar.
  function update(dt = 0) {
    const run = ctx.run;
    const visible = visibleNow(run);
    show(visible);
    if (!visible || !(dt > 0)) return;
    steps++;
    if (steps % RADAR.lookEvery === 0) look(run);
    if (steps % RADAR.redrawEvery === 0) draw(run);
  }

  const onScreen = (x, y, z) => ctx.cam.project(x, y, z, screen).visible;

  // The 5 Hz "on screen" test behind the seen rules.
  function look(run) {
    if (!ctx.cam?.project) return;
    const t = now();
    for (const e of run.enemies) if (e.hp > 0 && !e.dead && onScreen(e.x, groundAt(e.x, e.z) + 1, e.z)) e.seenT = t;
    for (const statue of ctx.world?.statues?.list ?? []) if (!seen.has(statue) && onScreen(statue.x, groundAt(statue.x, statue.z) + 1.5, statue.z)) seen.add(statue);
    const landmark = ctx.world?.landmark;
    if (landmark && !seen.has(landmark) && onScreen(landmark.x, groundAt(landmark.x, landmark.z) + 1.5, landmark.z)) seen.add(landmark);
    const bell = ctx.world?.shrineBell;
    if (bell && !seen.has(bell) && onScreen(bell.x, groundAt(bell.x, bell.z) + 1.5, bell.z)) seen.add(bell);
  }

  // ---- drawing ----

  function frameFor(n) {
    let frame = frames.get(n);
    if (frame) return frame;
    frame = doc?.createElement?.("canvas") ?? null;
    if (!frame) return null;
    frame.width = frame.height = n;
    const f = frame.getContext("2d");
    if (f) drawFrame(f, n);
    frames.set(n, frame);
    return frame;
  }

  // Octagon face at 88%, a 2 px bevel (light top and left, dark bottom and right) and range
  // rings at a third and two thirds of the radius.
  function drawFrame(f, n) {
    const cut = Math.round(n * CORNER);
    for (let y = 0; y < n; y++) {
      const inset = Math.max(0, cut - y, cut - (n - 1 - y)),
        w = n - 2 * inset;
      f.globalAlpha = FACE_ALPHA;
      f.fillStyle = FACE;
      f.fillRect(inset, y, w, 1);
      f.globalAlpha = 1;
      if (y < 2 || y >= n - 2) {
        f.fillStyle = y < 2 ? BEZEL_LIGHT : BEZEL_DARK;
        f.fillRect(inset, y, w, 1);
      } else {
        f.fillStyle = BEZEL_LIGHT;
        f.fillRect(inset, y, 2, 1);
        f.fillStyle = BEZEL_DARK;
        f.fillRect(inset + w - 2, y, 2, 1);
      }
    }
    f.fillStyle = RING;
    const half = n / 2,
      rim = half - 3;
    for (const fraction of [1 / 3, 2 / 3]) {
      const r = rim * fraction,
        steps = Math.ceil(r * 8);
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        f.fillRect(Math.floor(half + Math.sin(a) * r), Math.floor(half + Math.cos(a) * r), 1, 1);
      }
    }
  }

  function lighten(color) {
    let out = brighter.get(color);
    if (!out) {
      const n = Number.parseInt(color.slice(1), 16);
      const ch = (shift) => Math.min(255, Math.round(((n >> shift) & 255) * 1.3));
      out = "#" + [16, 8, 0].map((shift) => ch(shift).toString(16).padStart(2, "0")).join("");
      brighter.set(color, out);
    }
    return out;
  }

  // Plots a glyph at the projected point, 30% brighter when the sweep just passed it.
  function blip(glyph, color, t) {
    plot(glyph, point.x, point.y, swept(point.x, point.y, t) ? lighten(color) : color);
  }

  function plot(glyph, x, y, color) {
    g.fillStyle = color;
    const o = glyph.offsets,
      px = Math.round(x),
      py = Math.round(y);
    for (let i = 0; i < o.length; i += 2) g.fillRect(px + o[i], py + o[i + 1], 1, 1);
  }

  // 1-px ring around a glyph (trial marks, elites).
  function ring(glyph, x, y, color) {
    g.fillStyle = color;
    const px = Math.round(x),
      py = Math.round(y),
      left = px - Math.floor(glyph.w / 2) - 1,
      top = py - Math.floor(glyph.h / 2) - 1,
      w = glyph.w + 2,
      h = glyph.h + 2;
    g.fillRect(left, top, w, 1);
    g.fillRect(left, top + h - 1, w, 1);
    g.fillRect(left, top + 1, 1, h - 2);
    g.fillRect(left + w - 1, top + 1, 1, h - 2);
  }

  function line(x0, y0, x1, y1, color) {
    g.fillStyle = color;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= steps; i++) g.fillRect(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), 1, 1);
  }

  // Sweep: a 1-px line turning once per 2 s in 16 steps; blips it just passed glow 30% brighter.
  function sweepIndex(t) {
    return Math.floor((t / RADAR.sweepPeriod) * RADAR.sweepSteps) % RADAR.sweepSteps;
  }

  function swept(x, y, t) {
    if (reduced()) return false;
    const half = size / 2,
      a = Math.atan2(x - half, half - y),
      index = Math.floor((((a / (Math.PI * 2)) % 1) + 1) % 1 * RADAR.sweepSteps),
      current = sweepIndex(t),
      back = Math.round((RADAR.sweepGlow / RADAR.sweepPeriod) * RADAR.sweepSteps);
    return (current - index + RADAR.sweepSteps) % RADAR.sweepSteps < back;
  }

  function project(run, x, z, yaw, range) {
    const p = run.player;
    return radarPoint(x - p.x, z - p.z, yaw, range, size, point);
  }

  function viewYaw(p) {
    const eye = ctx.gfx?.camera?.position;
    return eye && (eye.x !== p.x || eye.z !== p.z) ? Math.atan2(eye.x - p.x, eye.z - p.z) : (ctx.cam?.yaw ?? 0);
  }

  function draw(run) {
    if (!g || !canvas) return;
    size = phone?.matches ? RADAR.phoneSize : RADAR.size;
    if (canvas.width !== size) canvas.width = canvas.height = size;
    frameTick++;
    const p = run.player,
      t = now(),
      yaw = viewYaw(p),
      dark = !!ctx.rules?.flag?.("darkBars"),
      fog = ctx.gfx?.scene?.fog,
      range = radarRange(ctx.prefs?.radarRange, fog?.far, dark),
      full = radarMode(ctx.prefs?.radar, run.original) === "full",
      colors = palette();
    g.clearRect(0, 0, size, size);
    const frame = frameFor(size);
    if (frame) g.drawImage(frame, 0, 0);
    if (full) drawStatic(run, t, range, dark, fog);
    drawAttacks(run, yaw, range, colors);
    if (full) {
      drawPlaces(run, yaw, range, t);
      drawItems(run, yaw, range, t);
      drawHostiles(run, yaw, range, t, dark, fog, colors);
    }
    drawBosses(run, yaw, range, t, colors);
    drawExits(run, yaw, range);
    drawPlayer(p, yaw);
    if (!reduced()) drawSweep(t);
  }

  // One dim speck on the rim per unseen hostile in range, with no direction (cosmetic random).
  function drawStatic(run, t, range, dark, fog) {
    if (dark) return;
    const p = run.player,
      half = size / 2,
      rim = half - 4;
    g.fillStyle = STATIC;
    for (const e of run.enemies) {
      if (!(e.hp > 0) || e.dead || e.fixed || isBoss(e)) continue;
      const dist = Math.hypot(e.x - p.x, e.z - p.z);
      const state = blipVisibility({ dist, seenT: e.seenT, now: t, range, dark, fogNear: fog?.near ?? Infinity, anyRange: eliteAnyRange(e) });
      if (state !== "static") continue;
      const a = Math.random() * Math.PI * 2,
        r = rim - Math.random() * 2;
      g.fillRect(Math.round(half + Math.sin(a) * r), Math.round(half + Math.cos(a) * r), 1, 1);
    }
  }

  // Live attack marks: a red line from a lane's or aim line's source toward the player, and an
  // x in the class colour at every other live footprint in range.
  function drawAttacks(run, yaw, range, colors) {
    const rows = ctx.tele?.active?.();
    if (!rows?.length) return;
    const p = run.player,
      half = size / 2;
    for (const row of rows) {
      const aimed = (row.cls === "charge" || row.cls === "aim") && row.path;
      if (aimed) {
        if (!threatTargetsPlayer(row, p)) continue;
        project(run, row.x, row.z, yaw, range);
        pinToRim(point, size);
        line(point.x, point.y, half, half, ATTACK);
      } else if (Math.hypot(row.x - p.x, row.z - p.z) <= range) {
        project(run, row.x, row.z, yaw, range);
        plot(GLYPHS.cross, point.x, point.y, colors[row.cls] ?? colors.ground);
      }
    }
  }

  function drawPlaces(run, yaw, range, t) {
    for (const statue of ctx.world?.statues?.list ?? []) {
      if (!seen.has(statue)) continue;
      project(run, statue.x, statue.z, yaw, range);
      if (!point.inRange) continue;
      blip(GLYPHS.statue, statue.trial ? TRIAL_MARK : statue.used ? STATUE_USED : STATUE, t);
    }
    const landmark = ctx.world?.landmark;
    if (landmark && seen.has(landmark)) {
      project(run, landmark.x, landmark.z, yaw, range);
      if (point.inRange) blip(GLYPHS.question, landmark.claimed ? LANDMARK_CLAIMED : LANDMARK, t);
    }
    const bell = ctx.world?.shrineBell;
    if (bell && run.stage === 1 && bell.state === "awake" && seen.has(bell)) {
      project(run, bell.x, bell.z, yaw, range);
      if (point.inRange) blip(GLYPHS.bell, BELL, t);
    }
    for (const o of run.objects ?? []) {
      if (o.dead || !(o.hp > 0) || (o.kind !== "anchor" && o.kind !== "node")) continue;
      project(run, o.x, o.z, yaw, range);
      if (!point.inRange) continue;
      blip(GLYPHS.diamond, o.kind === "node" ? NODE : ANCHOR, t);
      if (o.kind === "node") deadlineBar(point.x, point.y);
    }
  }

  // The Warden's node event: a 1-px bar under the diamond, the time left before the deadline.
  function deadlineBar(x, y) {
    const charge = ctx.bosses?.nodeCharge;
    if (!Number.isFinite(charge?.remaining)) return;
    const w = Math.max(1, Math.round((5 * charge.remaining) / CHALLENGE.nodeDeadline));
    g.fillStyle = NODE;
    g.fillRect(Math.round(x) - 2, Math.round(y) + 3, w, 1);
  }

  function drawItems(run, yaw, range, t) {
    const p = run.player,
      blink = !reduced() && Math.floor(t * 8) % 2 === 1;
    for (const pu of run.powerups ?? []) {
      if (pu.dead || Math.hypot(pu.x - p.x, pu.z - p.z) > RADAR.near) continue;
      if (blink && pu.life < 3) continue;
      project(run, pu.x, pu.z, yaw, range);
      blip(GLYPHS.dot, POWERUPS[pu.kind]?.color ?? CACHE, t);
    }
    for (const cache of run.caches ?? []) {
      if (cache.dead || blink) continue;
      project(run, cache.x, cache.z, yaw, range);
      if (point.inRange) blip(GLYPHS.cache, CACHE, t);
    }
    for (const o of ctx.hazards?.props?.() ?? []) {
      if (o.dead || Math.hypot(o.x - p.x, o.z - p.z) > RADAR.propRange) continue;
      project(run, o.x, o.z, yaw, range);
      blip(GLYPHS.dot, o.prop?.state === "spent" ? PROP_SPENT : PROP, t);
    }
  }

  const eliteAnyRange = (e) => Array.isArray(e.elite) && e.elite.length > 0 && !!ctx.relics?.has?.("hunters_mark");

  // A hostile's glyph and colour, written into the shared `style` (no per-blip allocation).
  function hostileStyle(e, yaw, colors) {
    const kind = e.kind,
      cls = ENEMY_CLASS[kind];
    if (HEAVY_KINDS.has(kind)) return setStyle(GLYPHS.heavy, HEAVY);
    if (kind === "ashworm") return e.untargetable ? setStyle(GLYPHS.burrow, BURROWED) : setStyle(GLYPHS.worm, colors.ground);
    if (cls === "charge") {
      const fx = Math.sin(e.yaw ?? 0),
        fz = Math.cos(e.yaw ?? 0),
        right = Math.cos(yaw) * fx - Math.sin(yaw) * fz,
        down = Math.sin(yaw) * fx + Math.cos(yaw) * fz;
      const glyph = Math.abs(right) > Math.abs(down) ? (right > 0 ? GLYPHS.chargeRight : GLYPHS.chargeLeft) : down > 0 ? GLYPHS.chargeDown : GLYPHS.chargeUp;
      return setStyle(glyph, colors.charge);
    }
    if (cls === "salvo" || cls === "aim" || cls === "artillery") return setStyle(GLYPHS.ranged, colors[cls]);
    return setStyle(GLYPHS.dot, colors.melee);
  }

  function setStyle(glyph, color) {
    style.glyph = glyph;
    style.color = color;
    return style;
  }

  function drawHostiles(run, yaw, range, t, dark, fog, colors) {
    const p = run.player,
      floor = groundAt(p.x, p.z);
    for (const e of run.enemies) {
      if (!(e.hp > 0) || e.dead || e.fixed || isBoss(e)) continue;
      const dist = Math.hypot(e.x - p.x, e.z - p.z);
      const anyRange = eliteAnyRange(e);
      if (blipVisibility({ dist, seenT: e.seenT, now: t, range, dark, fogNear: fog?.near ?? Infinity, anyRange }) !== "blip") continue;
      project(run, e.x, e.z, yaw, range);
      if (!point.inRange) pinToRim(point, size);
      const { glyph, color } = hostileStyle(e, yaw, colors);
      blip(glyph, color, t);
      const affix = Array.isArray(e.elite) ? AFFIXES[e.elite[0]] : null;
      if (affix) ring(glyph, point.x, point.y, affix.color);
      else if (e.trialId) ring(glyph, point.x, point.y, TRIAL_MARK);
      const rise = groundAt(e.x, e.z) + (e.y || 0) - floor;
      if (Math.abs(rise) >= RADAR.heightTick) {
        g.fillStyle = color;
        const edge = Math.ceil(glyph.h / 2) + (affix || e.trialId ? 1 : 0);
        g.fillRect(Math.round(point.x), Math.round(point.y) + (rise > 0 ? -edge - 1 : edge + 1), 1, 1);
      }
    }
  }

  // Keepers, Iron Maw and the Warden: a 5x5 skull blinking at 2 Hz (steady with Reduce
  // flashes), pinned to the rim when out of range; a Warden shade (F6) as a hollow skull.
  function drawBosses(run, yaw, range, t, colors) {
    const shade = ctx.bosses?.shade?.();
    if (shade && Number.isFinite(shade.x)) {
      project(run, shade.x, shade.z, yaw, range);
      pinToRim(point, size);
      plot(GLYPHS.shade, point.x, point.y, SHADE);
    }
    const on = reduced() || Math.floor(t * 4) % 2 === 0;
    if (!on) return;
    for (const e of run.enemies) {
      if (!(e.hp > 0) || e.dead || !isBoss(e)) continue;
      project(run, e.x, e.z, yaw, range);
      pinToRim(point, size);
      plot(GLYPHS.skull, point.x, point.y, colors.boss);
    }
  }

  // The portal (a pulsing rift glyph when open, dim when locked; a 3-px rim wedge when an open
  // portal is out of range) and, on the last stage, the Crown Dais once awake.
  function drawExits(run, yaw, range) {
    const world = ctx.world;
    const last = run.stage >= 5;
    if (last) {
      if (!run.dais?.awake) return;
      const dais = world?.dais ?? world?.portal;
      if (!dais) return;
      project(run, dais.x, dais.z, yaw, range);
      pinToRim(point, size);
      plot(GLYPHS.crown, point.x, point.y, DAIS);
      return;
    }
    const portal = world?.portal;
    if (!portal) return;
    const open = !!(run.portalActive || portal.active);
    project(run, portal.x, portal.z, yaw, range);
    if (open && !point.inRange) {
      pinToRim(point, size);
      wedge(point.x, point.y);
      return;
    }
    pinToRim(point, size);
    const pulse = open && !reduced() && frameTick % 2 === 1;
    plot(GLYPHS.rift, point.x, point.y, open ? (pulse ? lighten(PORTAL) : PORTAL) : PORTAL_LOCKED);
  }

  // A 3-px wedge on the rim pointing out toward the open portal.
  function wedge(x, y) {
    const half = size / 2,
      dx = x - half,
      dy = y - half,
      d = Math.hypot(dx, dy) || 1,
      ux = dx / d,
      uy = dy / d;
    g.fillStyle = PORTAL;
    for (let k = 0; k < 3; k++) {
      const w = 2 - k;
      for (let s = -w; s <= w; s++) g.fillRect(Math.round(x - ux * (2 - k) - uy * s), Math.round(y - uy * (2 - k) + ux * s), 1, 1);
    }
  }

  // The player: a 3x3 arrow at the centre pointing along the aim, camera-relative.
  function drawPlayer(p, yaw) {
    const aim = p.aim ?? 0,
      fx = Math.sin(aim),
      fz = Math.cos(aim),
      right = Math.cos(yaw) * fx - Math.sin(yaw) * fz,
      up = -(Math.sin(yaw) * fx + Math.cos(yaw) * fz),
      octant = (Math.round((Math.atan2(right, up) / (Math.PI * 2)) * 8) + 8) % 8;
    plot(GLYPHS.arrows[octant], size / 2, size / 2, PLAYER);
  }

  function drawSweep(t) {
    const half = size / 2,
      a = (sweepIndex(t) / RADAR.sweepSteps) * Math.PI * 2,
      rim = half - 4;
    line(half, half, half + Math.sin(a) * rim, half - Math.cos(a) * rim, SWEEP);
  }

  // Stage change or a new run: nothing is seen yet, and the radar waits for its next redraw.
  function clear() {
    steps = 0;
    show(false);
    g?.clearRect?.(0, 0, size, size);
  }

  return { update, clear, element: canvas };
}
