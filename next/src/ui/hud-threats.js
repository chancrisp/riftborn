// Threat cues around the screen (IMPROVEMENTS F16.3, F16.4, F17): off-screen threat arrows in
// #threatEdge, the damage-direction wedges of the #hurtRing canvas, and the sound pips the
// "icons" caption mode draws on that same ring. Created by hud.js; every DOM and canvas write is
// diffed, and nothing is allocated per step (candidate rows, wedges and pips are reused).
import { PALETTES, validPalette } from "../data/palettes.js";
import { threatTargetsPlayer } from "./radar.js";

export const ARROW = Object.freeze({ pool: 6, inset: 28, edge: 0.12, bar: 22, urgent: 0.3, blinkHz: 4 });
// Tie order at equal remaining time (F16.3), highest first.
export const CLASS_ORDER = Object.freeze(["charge", "aim", "artillery", "ground", "salvo", "boss"]);
const RANK = Object.freeze(Object.fromEntries(CLASS_ORDER.map((cls, i) => [cls, i])));

const DEG = Math.PI / 180;
export const WEDGE = Object.freeze({
  life: 1,
  step: 0.25, // opacity steps 1 / 0.75 / 0.5 / 0.25
  span: 40 * DEG,
  merge: 30 * DEG,
  max: 4,
  flash: 0.25, // a sourceless hit lights the whole ring this long
  flashAlpha: 0.5,
  pipLife: 1,
  pips: 6,
  buffer: 120,
  desktop: Object.freeze([44, 52]),
  phone: Object.freeze([36, 43]),
  notch: 3,
});
const HURT = "#d85d57";
const WARD = "#d3d7ba";
const OUTLINE = "#3a0d10";
const PIP_EDGE = "#111318";
const TAU = Math.PI * 2;

// Class icons inside the arrows (5 × 5, dark on the class colour): lane = double chevron,
// aim = dot, artillery = x, ground = ring, salvo = a ring of shots, boss = skull.
const ARROW_ICONS = Object.freeze({
  charge: [".....", "#..#.", ".#..#", "#..#.", "....."],
  aim: [".....", ".###.", ".###.", ".###.", "....."],
  artillery: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  ground: [".###.", "#...#", "#...#", "#...#", ".###."],
  salvo: ["#.#.#", ".....", "#...#", ".....", "#.#.#"],
  boss: [".###.", "#####", "#.#.#", "#####", ".#.#."],
});
const iconMarkup = new Map();
function arrowIcon(cls) {
  let svg = iconMarkup.get(cls);
  if (svg === undefined) {
    const rows = ARROW_ICONS[cls] ?? ARROW_ICONS.ground;
    let rects = "";
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === "#") rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    });
    svg = `<svg viewBox="0 0 5 5" width="5" height="5" shape-rendering="crispEdges" fill="${PIP_EDGE}" aria-hidden="true">${rects}</svg>`;
    iconMarkup.set(cls, svg);
  }
  return svg;
}

// ---- pure helpers -------------------------------------------------------------------------------

// Where an off-screen arrow sits: on the screen rectangle inset by `inset` px, along the ray from
// the screen centre toward the projected point (ndcX right, ndcY up, -1..1). Behind the camera a
// projection is meaningless, so the caller passes the compass bearing as a unit direction on the
// same axes with behind = true, and it is used as is. out = { x, y, angle } in screen px, angle
// in radians with y down and 0 pointing right (the arrow's rotation).
export function edgeAnchor(ndcX, ndcY, behind, inset, w, h, out = {}) {
  let dx = behind ? ndcX : ndcX * (w / 2);
  let dy = behind ? -ndcY : -ndcY * (h / 2);
  if (!dx && !dy) dy = 1;
  const hx = Math.max(0, w / 2 - inset);
  const hy = Math.max(0, h / 2 - inset);
  const t = Math.min(dx ? hx / Math.abs(dx) : Infinity, dy ? hy / Math.abs(dy) : Infinity);
  out.x = w / 2 + dx * t;
  out.y = h / 2 + dy * t;
  out.angle = Math.atan2(dy, dx);
  return out;
}

// Screen angle of a damage source around the player, 0 = up and clockwise positive, from the
// compass formula (robust behind the camera): F16.4.
export function wedgeAngle(player, src, camPos) {
  const dx = src.x - player.x;
  const dz = src.z - player.z;
  const vy = Math.atan2(camPos.x - player.x, camPos.z - player.z);
  const right = Math.cos(vy) * dx - Math.sin(vy) * dz;
  const up = -(Math.sin(vy) * dx + Math.cos(vy) * dz);
  return Math.atan2(right, up);
}

export const angleGap = (a, b) => {
  const d = Math.abs(a - b) % TAU;
  return d > Math.PI ? TAU - d : d;
};

// Stepped wedge opacity by age: 1, 0.75, 0.5, 0.25, then gone.
export const wedgeAlpha = (age) => (age >= WEDGE.life || age < 0 ? 0 : 1 - WEDGE.step * Math.floor(age / WEDGE.step));

// Adds a hit at `angle` to the wedge records [{ angle, age, absorbed }] (reused in place): within
// ±30° of a live wedge it refreshes the nearest one instead of stacking; otherwise it takes an
// expired record, a new one while fewer than `max` exist, or the oldest. Returns the record.
export function mergeWedge(wedges, angle, absorbed = false, max = WEDGE.max) {
  let hit = null;
  let best = WEDGE.merge + 1e-9;
  for (const w of wedges) {
    if (w.age >= WEDGE.life) continue;
    const gap = angleGap(w.angle, angle);
    if (gap <= best) {
      best = gap;
      hit = w;
    }
  }
  if (!hit) for (const w of wedges) if (w.age >= WEDGE.life) (hit ??= w);
  if (!hit && wedges.length < max) wedges.push((hit = { angle, age: WEDGE.life, absorbed }));
  if (!hit) for (const w of wedges) if (!hit || w.age > hit.age) hit = w;
  hit.angle = angle;
  hit.age = 0;
  hit.absorbed = !!absorbed;
  return hit;
}

// Orders arrow candidates in place over [0, n): remaining time ascending, ties by class.
export function sortThreats(list, n) {
  for (let i = 1; i < n; i++) {
    const c = list[i];
    let j = i - 1;
    while (j >= 0 && threatAfter(list[j], c)) {
      list[j + 1] = list[j];
      j--;
    }
    list[j + 1] = c;
  }
  return list;
}
const threatAfter = (a, b) => a.remaining > b.remaining || (a.remaining === b.remaining && (RANK[a.cls] ?? 9) > (RANK[b.cls] ?? 9));

// ---- canvas helpers -----------------------------------------------------------------------------

const rgbCache = new Map();
function rgbOf(hex) {
  let rgb = rgbCache.get(hex);
  if (!rgb) {
    const n = parseInt(String(hex).slice(1, 7), 16) || 0;
    rgb = Object.freeze([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
    rgbCache.set(hex, rgb);
  }
  return rgb;
}

// The buffer pixels around one ring size: data index, radius and angle (0 = up, clockwise).
function bandOf([inner, outer]) {
  const size = WEDGE.buffer;
  const c = size / 2;
  const idx = [];
  const rad = [];
  const ang = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const r = Math.hypot(dx, dy);
      if (r < inner - 1.5 || r > outer + WEDGE.notch + 1.5) continue;
      idx.push((y * size + x) * 4);
      rad.push(r);
      ang.push(Math.atan2(dx, -dy));
    }
  return { inner, outer, idx: Int32Array.from(idx), rad: Float32Array.from(rad), ang: Float32Array.from(ang) };
}

function put(data, i, rgb, alpha) {
  data[i] = rgb[0];
  data[i + 1] = rgb[1];
  data[i + 2] = rgb[2];
  data[i + 3] = alpha;
}

// A 40° annular sector with a 1-px outline and a 3-px outward notch at its centre.
function paintWedge(data, band, angle, rgb, alpha) {
  const half = WEDGE.span / 2;
  const outline = rgbOf(OUTLINE);
  const { inner, outer, idx, rad, ang } = band;
  for (let i = 0; i < idx.length; i++) {
    const r = rad[i];
    const gap = angleGap(ang[i], angle);
    const arc = gap * r;
    if ((r >= inner && r <= outer && gap <= half) || (r > outer && r <= outer + WEDGE.notch && arc <= 1.5)) put(data, idx[i], rgb, alpha);
    else if ((r >= inner - 1 && r <= outer + 1 && gap <= half + 1 / r) || (r > outer && r <= outer + WEDGE.notch + 1 && arc <= 2.5)) put(data, idx[i], outline, alpha);
  }
}

function paintRing(data, band, rgb, alpha) {
  for (let i = 0; i < band.idx.length; i++) if (band.rad[i] >= band.inner && band.rad[i] <= band.outer) put(data, band.idx[i], rgb, alpha);
}

// A 3 × 3 pip in the class colour with a 1-px dark edge, `radius` px from the centre.
function paintPip(data, angle, radius, rgb) {
  const size = WEDGE.buffer;
  const cx = Math.round(size / 2 + Math.sin(angle) * radius);
  const cy = Math.round(size / 2 - Math.cos(angle) * radius);
  const edge = rgbOf(PIP_EDGE);
  for (let y = -2; y <= 2; y++)
    for (let x = -2; x <= 2; x++) {
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      put(data, (py * size + px) * 4, Math.abs(x) === 2 || Math.abs(y) === 2 ? edge : rgb, 255);
    }
}

// ---- the widgets --------------------------------------------------------------------------------

export function createThreats(ctx, { groundAt = () => 0 } = {}) {
  const doc = globalThis.document;
  const screen = { x: 0, y: 0, visible: false };
  const anchor = { x: 0, y: 0, angle: 0 };
  const cam = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ok: false };
  const phone = globalThis.matchMedia?.("(max-width: 700px)") ?? null;

  // #threatEdge: a pool of arrows.
  const edge = doc.createElement("div");
  edge.id = "threatEdge";
  edge.classList.add("hidden");
  edge.setAttribute("aria-hidden", "true");
  const arrows = [];
  for (let i = 0; i < ARROW.pool; i++) arrows.push(makeArrow(edge));
  doc.body?.append?.(edge);
  const candidates = [];
  const skull = { cls: "boss", remaining: Infinity, eta: 0, ndcX: 0, ndcY: 0, behind: false, skull: true };
  let edgeShown = false;

  // #hurtRing: a 120 × 120 buffer shown at 240 × 240, pixelated.
  const ring = doc.createElement("canvas");
  ring.id = "hurtRing";
  ring.classList.add("hidden");
  ring.setAttribute("aria-hidden", "true");
  ring.width = ring.height = WEDGE.buffer;
  doc.body?.append?.(ring);
  const g = ring.getContext?.("2d") ?? null;
  const image = g?.createImageData?.(WEDGE.buffer, WEDGE.buffer) ?? null;
  const bands = new Map(); // "desktop" | "phone" -> band pixels, built on first use
  const wedges = [];
  const pips = [];
  let flash = 0;
  let ringShown = false;
  let ringLeft = NaN;
  let ringTop = NaN;
  let dirty = true;
  let drawnKey = -1;

  function makeArrow(parent) {
    const el = doc.createElement("i");
    el.className = "threat-arrow";
    el.style.display = "none";
    const chev = doc.createElement("span");
    chev.className = "chev";
    const ico = doc.createElement("span");
    ico.className = "ico";
    const fuse = doc.createElement("span");
    fuse.className = "fuse";
    const fill = doc.createElement("i");
    fuse.append(fill);
    el.append(chev, ico, fuse);
    parent.append(el);
    return { el, chev, ico, fuse, fill, shown: false, left: NaN, top: NaN, deg: NaN, cls: "", color: "", bar: -2, off: false, urgent: false };
  }

  const palette = () => PALETTES[validPalette(ctx.prefs?.palette)];
  const reduced = () => ctx.prefs?.flashes === false;

  // Camera position and forward axis (for the behind test and the wedge bearing).
  function readCamera() {
    const e = ctx.gfx?.camera?.matrixWorld?.elements;
    cam.ok = !!e;
    if (!e) return;
    cam.x = e[12];
    cam.y = e[13];
    cam.z = e[14];
    cam.fx = -e[8];
    cam.fy = -e[9];
    cam.fz = -e[10];
  }

  // Fills out.ndcX/ndcY/behind for a world point and returns true when it wants an arrow:
  // behind the camera, off screen, or within 6% of the screen edge.
  function locate(x, z, p, out) {
    const y = groundAt(x, z) + 1;
    const behind = cam.ok && (x - cam.x) * cam.fx + (y - cam.y) * cam.fy + (z - cam.z) * cam.fz <= 0.05;
    if (behind) {
      const a = compassBearing(x - p.x, z - p.z, p);
      out.ndcX = Math.cos(a);
      out.ndcY = -Math.sin(a);
      out.behind = true;
      return true;
    }
    ctx.cam.project(x, y, z, screen);
    const w = globalThis.innerWidth || 1;
    const h = globalThis.innerHeight || 1;
    const ndcX = (screen.x / w) * 2 - 1;
    const ndcY = 1 - (screen.y / h) * 2;
    if (Math.abs(ndcX) < 1 - ARROW.edge && Math.abs(ndcY) < 1 - ARROW.edge) return false;
    out.ndcX = ndcX;
    out.ndcY = ndcY;
    out.behind = false;
    return true;
  }

  // Screen angle (y down, 0 = right) of a world offset from the player, as the portal compass.
  function compassBearing(dx, dz, p) {
    const yaw = cam.ok ? Math.atan2(cam.x - p.x, cam.z - p.z) : ctx.cam?.yaw || 0;
    return Math.atan2(Math.sin(yaw) * dx + Math.cos(yaw) * dz, Math.cos(yaw) * dx - Math.sin(yaw) * dz);
  }

  function candidate(i) {
    return candidates[i] ?? (candidates[i] = { cls: "", remaining: 0, eta: 0, ndcX: 0, ndcY: 0, behind: false, skull: false });
  }

  function updateArrows(run, p, t) {
    let n = 0;
    const rows = ctx.tele?.active?.();
    if (rows && ctx.cam?.project) {
      for (const row of rows) {
        if (!(row.cls in RANK) || !(row.remaining > 0) || !Number.isFinite(row.x) || !Number.isFinite(row.z)) continue;
        if (!threatTargetsPlayer(row, p)) continue;
        const c = candidate(n);
        if (!locate(row.x, row.z, p, c)) continue;
        c.cls = row.cls;
        c.remaining = row.remaining;
        c.eta = row.eta > 0 ? row.eta : row.remaining;
        c.skull = false;
        n++;
      }
    }
    sortThreats(candidates, n);
    let used = 0;
    // The persistent skull: a live keeper or boss off screen, in the boss colour, no bar.
    const boss = ctx.bosses?.current?.();
    if (boss && boss.hp > 0 && !boss.dead && ctx.cam?.project && locate(boss.x, boss.z, p, skull)) showArrow(arrows[used++], skull, t);
    for (let i = 0; i < n && used < ARROW.pool; i++) showArrow(arrows[used++], candidates[i], t);
    for (; used < ARROW.pool; used++) hideArrow(arrows[used]);
  }

  function showArrow(a, c, t) {
    const w = globalThis.innerWidth || 1;
    const h = globalThis.innerHeight || 1;
    edgeAnchor(c.ndcX, c.ndcY, c.behind, ARROW.inset, w, h, anchor);
    const left = Math.round(anchor.x);
    const top = Math.round(anchor.y);
    const deg = Math.round(anchor.angle / DEG);
    if (!a.shown) {
      a.shown = true;
      a.el.style.display = "";
    }
    if (left !== a.left) a.el.style.left = (a.left = left) + "px";
    if (top !== a.top) a.el.style.top = (a.top = top) + "px";
    if (deg !== a.deg) a.chev.style.transform = `rotate(${(a.deg = deg)}deg)`;
    if (c.cls !== a.cls) a.ico.innerHTML = arrowIcon((a.cls = c.cls));
    const color = palette()[c.cls] ?? palette().ground;
    if (color !== a.color) a.el.style.color = a.color = color;
    const bar = c.skull ? -1 : Math.round(Math.min(1, Math.max(0, c.remaining / c.eta)) * ARROW.bar);
    if (bar !== a.bar) {
      if (bar < 0 || a.bar < 0) a.fuse.style.display = bar < 0 ? "none" : "";
      if (bar >= 0) a.fill.style.width = bar + "px";
      a.bar = bar;
    }
    // The last 0.3 s: a 4 Hz blink, or a thicker border under Reduce flashes.
    const urgent = !c.skull && c.remaining <= ARROW.urgent;
    const calm = reduced();
    const off = urgent && !calm && Math.floor(t * ARROW.blinkHz * 2) % 2 === 1;
    if (off !== a.off) a.el.classList.toggle("off", (a.off = off));
    const thick = urgent && calm;
    if (thick !== a.urgent) a.el.classList.toggle("urgent", (a.urgent = thick));
  }

  function hideArrow(a) {
    if (!a.shown) return;
    a.shown = false;
    a.el.style.display = "none";
  }

  function showEdge(on) {
    if (on === edgeShown) return;
    edgeShown = on;
    edge.classList.toggle("hidden", !on);
    if (!on) for (const a of arrows) hideArrow(a);
  }

  // ---- the hurt ring ----

  function onHit({ amount = 0, source, absorbed = 0 } = {}) {
    const run = ctx.run;
    const p = run?.player;
    if (!p || run.demo || ctx.prefs?.hurtRing === false) return;
    if (source && Number.isFinite(source.x) && Number.isFinite(source.z)) {
      const eye = ctx.gfx?.camera?.position;
      const camPos = eye ?? { x: p.x, z: p.z + 1 };
      mergeWedge(wedges, wedgeAngle(p, source, camPos), typeof absorbed === "number" ? absorbed >= amount && amount > 0 : !!absorbed);
    } else flash = WEDGE.flash;
    dirty = true;
  }

  // A caption pip (icons mode) at a screen angle (0 = up, clockwise) in a class colour.
  function pip(angle, color) {
    let slot = null;
    for (const q of pips) if (q.age >= WEDGE.pipLife) (slot ??= q);
    if (!slot && pips.length < WEDGE.pips) pips.push((slot = { angle, age: WEDGE.pipLife, color }));
    if (!slot) for (const q of pips) if (!slot || q.age > slot.age) slot = q;
    slot.angle = angle;
    slot.age = 0;
    slot.color = color;
    dirty = true;
  }

  function age(dt) {
    if (!(dt > 0)) return;
    for (const w of wedges) if (w.age < WEDGE.life) w.age += dt;
    for (const q of pips) if (q.age < WEDGE.pipLife) q.age += dt;
    if (flash > 0) flash = Math.max(0, flash - dt);
  }

  // A key that changes whenever the ring's picture would: each wedge's opacity step, the flash
  // and each pip being live.
  function pictureKey(small) {
    let key = small ? 1 : 0;
    for (let i = 0; i < wedges.length; i++) key = key * 5 + (wedges[i].age < WEDGE.life ? 1 + Math.floor(wedges[i].age / WEDGE.step) : 0);
    key = key * 2 + (flash > 0 ? 1 : 0);
    for (let i = 0; i < pips.length; i++) key = key * 2 + (pips[i].age < WEDGE.pipLife ? 1 : 0);
    return key;
  }

  function live() {
    if (flash > 0) return true;
    for (let i = 0; i < wedges.length; i++) if (wedges[i].age < WEDGE.life) return true;
    for (let i = 0; i < pips.length; i++) if (pips[i].age < WEDGE.pipLife) return true;
    return false;
  }

  function drawRing() {
    const small = !!phone?.matches;
    const key = pictureKey(small);
    if (!dirty && key === drawnKey) return;
    dirty = false;
    drawnKey = key;
    if (!image || !g) return;
    const layout = small ? "phone" : "desktop";
    let band = bands.get(layout);
    if (!band) bands.set(layout, (band = bandOf(WEDGE[layout])));
    const data = image.data;
    data.fill(0);
    if (flash > 0) paintRing(data, band, rgbOf(HURT), Math.round(255 * WEDGE.flashAlpha));
    for (const w of wedges) {
      const alpha = wedgeAlpha(w.age);
      if (alpha > 0) paintWedge(data, band, w.angle, rgbOf(w.absorbed ? WARD : HURT), Math.round(255 * alpha));
    }
    for (const q of pips) if (q.age < WEDGE.pipLife) paintPip(data, q.angle, band.inner - 6, rgbOf(q.color));
    g.putImageData(image, 0, 0);
  }

  function showRing(on) {
    if (on === ringShown) return;
    ringShown = on;
    ring.classList.toggle("hidden", !on);
  }

  function placeRing(p) {
    if (!ctx.cam?.project) return;
    ctx.cam.project(p.x, groundAt(p.x, p.z) + 1.2, p.z, screen);
    const left = Math.round(screen.x);
    const top = Math.round(screen.y);
    if (left !== ringLeft) ring.style.left = (ringLeft = left) + "px";
    if (top !== ringTop) ring.style.top = (ringTop = top) + "px";
  }

  // Every step. `inPlay`: a live run in play (no sequence, card or demo); dt > 0 only on played
  // steps, which alone age wedges, pips and arrows' blink clock.
  function update(dt, inPlay) {
    const run = ctx.run;
    const p = run?.player;
    age(dt);
    readCamera();
    const arrowsOn = inPlay && !!p && ctx.prefs?.threatArrows !== false;
    showEdge(arrowsOn);
    if (arrowsOn) updateArrows(run, p, run.elapsed ?? 0);
    const ringOn = inPlay && !!p && live();
    showRing(ringOn);
    if (!ringOn) return;
    placeRing(p);
    drawRing();
  }

  function clear() {
    for (const w of wedges) w.age = WEDGE.life;
    for (const q of pips) q.age = WEDGE.pipLife;
    flash = 0;
    dirty = true;
    showRing(false);
    showEdge(false);
    ringLeft = ringTop = NaN;
  }

  // Layout preview for the overlap check: nothing here sits in a §3.13 slot.
  return { update, onHit, pip, clear, compassBearing, edge, ring };
}
