// Enhanced lighting (pref "lighting": "enhanced" | "classic"). Keeps the PS1 identity: every
// surface is still flat-shaded Lambert, drawn low-res and dithered by the post pass; this only
// feeds it richer light.
//   - Fake GI: a per-world bounce/fill light and a hemisphere ground tint taken from the stage
//     floor, plus baked vertex ambient occlusion (materials.retroEnhance switches it on).
//   - A fixed pool of point lights (the light count is part of every program key, so it never
//     changes and nothing recompiles) handed each frame to the brightest nearby sources:
//     transient kicks (muzzle, impacts, explosions, deaths) and live emitters (rockets, portal,
//     lava and glowing props, telegraphed keeper blasts winding up, pickups).
// Classic leaves every pool and fill light at intensity 0 and AO at 0: pixel-identical to before.
// Purely visual: reads the run, never writes it, and flicker uses its own hash (no RNG).
import * as THREE from "three";
import { retroEnhance } from "./materials.js";

export const LIGHT_POOL = 6;
const TRANSIENT_CAP = 24;
const STATIC_CAP = 96;
const CANDIDATE_CAP = 72;
const GEM_SCAN = 12;
const STATIC_REACH = 34; // static emitters farther than this from the focus are skipped
const FLICKER_FPS = 15; // flicker steps like the lava clock, PS1 style
const POOL_GAIN = 1.7; // point-light punch: enhanced should read at a glance, not on inspection
const AO_GAIN = 1.45; // baked AO depth (retroEnhance); classic stays 0

// Per-world fake GI on top of the classic rig: hemisphere ground (bounce tint on characters),
// a low coloured side fill (reads on walls and props from the top-down camera), the sky term
// tinted toward that bounce colour (`tint`, default 0.24), and small nudges to the key and rim.
const GI = Object.freeze({
  // Meadows: warm grass bounce.
  1: Object.freeze({ ground: "#6f9a32", hemi: 1.05, fill: "#e8c85a", fillI: 0.8, fillDir: [6, 3, 8], sunI: 1.4 }),
  // Quarry: dusty ochre haze bouncing off pale stone.
  2: Object.freeze({ ground: "#9a7a4e", hemi: 1.02, fill: "#e0a870", fillI: 0.75, fillDir: [-7, 3, 6], sunI: 1.28 }),
  // Caldera: lava under-glow.
  3: Object.freeze({ ground: "#c4401a", hemi: 0.95, fill: "#ff4a10", fillI: 1.55, fillDir: [2, 1.5, 6], tint: 0.34, accentI: 0.9 }),
  // Citadel: aurora cyan from the side and a cold teal bounce.
  4: Object.freeze({ ground: "#2f7894", hemi: 0.98, fill: "#58f2ff", fillI: 1.05, fillDir: [-12, 3, -6], tint: 0.3, rim: "#8affd4", rimI: 1.25 }),
  // Void Crown: violet bounce.
  5: Object.freeze({ ground: "#6a34a8", hemi: 0.95, fill: "#a458ff", fillI: 1.2, fillDir: [7, 3, -5], tint: 0.32, accentI: 0.55 }),
});
const NIGHTMARE_GI = Object.freeze({ ground: "#6e7f95", hemi: 1.1, fill: "#7d95b8", fillI: 0.35, fillDir: [0, 3, 8], tint: 0.12 });

const PORTAL_COLOR = new THREE.Color("#a27dff");
const HAZARD_COLOR = new THREE.Color("#ff5a2c");
const GEM_COLOR = new THREE.Color("#7ff0ff");
const ENEMY_ROUND = new THREE.Color("#ff6a5a");

// Stepped value noise in 0..1 from a time and a per-source phase (no RNG, no allocation).
function flicker(t, phase, fps = FLICKER_FPS) {
  const s = Math.floor(t * fps) / fps;
  return 0.5 + 0.3 * Math.sin(s * 11.3 + phase) + 0.2 * Math.sin(s * 23.7 + phase * 2.3);
}

export function createLighting(ctx, scene, { ambient, sun, rim, accent }) {
  const fill = new THREE.DirectionalLight("#ffffff", 0);
  const pool = [];
  for (let i = 0; i < LIGHT_POOL; i++) {
    const light = new THREE.PointLight("#ffffff", 0, 8, 2);
    pool.push(light);
  }
  scene.add(fill, fill.target, ...pool);

  // Transient kicks: x y z r g b intensity range decay.
  const TS = 9;
  const transient = new Float32Array(TRANSIENT_CAP * TS);
  let transients = 0;
  // Static emitters found at stage build: x y z r g b intensity range phase kind(0 glow, 1 lava).
  const SS = 10;
  const statics = new Float32Array(STATIC_CAP * SS);
  let staticCount = 0;
  // Per-frame candidates.
  const cand = new Float32Array(CANDIDATE_CAP * 8); // x y z r g b intensity range
  const score = new Float32Array(CANDIDATE_CAP);
  let candidates = 0;
  const focus = new THREE.Vector3();
  const _color = new THREE.Color();
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  let enabled = false;
  let cleared = true;

  function applyRig(stageId, nightmare, on) {
    enabled = !!on;
    retroEnhance.value = enabled ? AO_GAIN : 0;
    if (!enabled) {
      fill.intensity = 0;
      clearPool();
      return;
    }
    const gi = nightmare ? NIGHTMARE_GI : (GI[stageId] ?? GI[1]);
    ambient.groundColor.set(gi.ground);
    ambient.intensity = gi.hemi;
    ambient.color.lerp(_color.set(gi.fill), gi.tint ?? 0.24);
    if (gi.sunI) sun.intensity = gi.sunI;
    if (gi.rim) rim.color.set(gi.rim);
    if (gi.rimI) rim.intensity = gi.rimI;
    if (gi.accentI) accent.intensity = gi.accentI;
    fill.color.set(gi.fill);
    fill.intensity = gi.fillI;
    fill.userData.dir = gi.fillDir;
    placeFill();
  }

  function placeFill() {
    const dir = fill.userData.dir ?? [0, -1, 0];
    fill.position.set(focus.x + dir[0], focus.y + dir[1], focus.z + dir[2]);
    fill.target.position.copy(focus);
    fill.target.updateMatrixWorld();
  }

  function clearPool() {
    if (cleared) return;
    for (const light of pool) light.intensity = 0;
    transients = 0;
    cleared = true;
  }

  // A transient light kick; decays exponentially (decay per second).
  function kick(x, y, z, color, intensity, range = 8, decay = 12) {
    if (!enabled || !(intensity > 0)) return;
    let slot = transients;
    if (slot >= TRANSIENT_CAP) {
      // Replace the weakest.
      slot = 0;
      for (let i = 1; i < TRANSIENT_CAP; i++) if (transient[i * TS + 6] < transient[slot * TS + 6]) slot = i;
      if (transient[slot * TS + 6] > intensity) return;
    } else transients++;
    _color.set(color);
    const o = slot * TS;
    transient[o] = x;
    transient[o + 1] = y;
    transient[o + 2] = z;
    transient[o + 3] = _color.r;
    transient[o + 4] = _color.g;
    transient[o + 5] = _color.b;
    transient[o + 6] = intensity;
    transient[o + 7] = range;
    transient[o + 8] = decay;
  }

  // Glowing props (lava pools, crystals, braziers) become flickering light sources.
  function collectStatics(root) {
    staticCount = 0;
    root?.traverse?.((node) => {
      if (!node.isInstancedMesh || staticCount >= STATIC_CAP) return;
      const material = node.material;
      const lava = material?.userData?.retro?.anim === "lava";
      if (!material?.emissive || !(lava || material.emissiveIntensity >= 0.3)) return;
      const step = Math.max(1, Math.ceil(node.count / 24));
      for (let i = 0; i < node.count && staticCount < STATIC_CAP; i += step) {
        node.getMatrixAt(i, _m);
        _p.setFromMatrixPosition(_m).applyMatrix4(node.matrixWorld);
        const o = staticCount++ * SS;
        statics[o] = _p.x;
        statics[o + 1] = _p.y + (lava ? 0.9 : 0.6);
        statics[o + 2] = _p.z;
        statics[o + 3] = material.emissive.r;
        statics[o + 4] = material.emissive.g;
        statics[o + 5] = material.emissive.b;
        statics[o + 6] = lava ? 4.6 : 2.2 + material.emissiveIntensity * 2.6;
        statics[o + 7] = lava ? 9 : 6.5;
        statics[o + 8] = (_p.x * 12.9898 + _p.z * 78.233) % 6.283;
        statics[o + 9] = lava ? 1 : 0;
      }
    });
  }

  function push(x, y, z, r, g, b, intensity, range) {
    if (candidates >= CANDIDATE_CAP || !(intensity > 0.02)) return;
    const dx = x - focus.x,
      dz = z - focus.z,
      d2 = dx * dx + dz * dz,
      r2 = range * range;
    const s = (intensity * r2) / (r2 + d2 * 0.35);
    const o = candidates * 8;
    cand[o] = x;
    cand[o + 1] = y;
    cand[o + 2] = z;
    cand[o + 3] = r;
    cand[o + 4] = g;
    cand[o + 5] = b;
    cand[o + 6] = intensity;
    cand[o + 7] = range;
    score[candidates++] = s;
  }

  function pushColor(x, y, z, color, intensity, range) {
    push(x, y, z, color.r, color.g, color.b, intensity, range);
  }

  function gather(t, frozen, dt) {
    candidates = 0;
    // Transients (decay unless the simulation is frozen).
    const k = frozen ? 1 : Math.exp(-dt);
    for (let i = 0; i < transients; ) {
      const o = i * TS;
      if (!frozen) transient[o + 6] *= Math.pow(k, transient[o + 8]);
      if (transient[o + 6] < 0.03) {
        transients--;
        transient.copyWithin(o, transients * TS, transients * TS + TS);
        continue;
      }
      push(transient[o], transient[o + 1], transient[o + 2], transient[o + 3], transient[o + 4], transient[o + 5], transient[o + 6], transient[o + 7]);
      i++;
    }
    const run = ctx.run;
    // Rockets in flight and hostile rounds.
    const shots = run?.shots;
    if (shots)
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i];
        if (s.retired || s.detonated) continue;
        if (s.rocket) {
          _color.set(s.color ?? "#ffb060");
          pushColor(s.x, s.y, s.z, _color, 4.5 * (0.85 + 0.15 * flicker(t, i, 30)), 8);
        } else if (s.enemy) pushColor(s.x, s.y, s.z, ENEMY_ROUND, 1.2, 4);
      }
    // Telegraphed blasts (keeper attacks, mortar shells): glow builds as they wind up.
    const hazards = run?.hazards;
    if (hazards)
      for (let i = 0; i < hazards.length; i++) {
        const h = hazards[i];
        if (!(h.max > 0)) continue;
        const wind = 1 - Math.max(0, h.life) / h.max;
        const pulse = 0.85 + 0.15 * Math.sin(t * (6 + wind * 18));
        pushColor(h.x, (h.y ?? 0) + 0.7, h.z, HAZARD_COLOR, (0.6 + 5.5 * wind * wind) * pulse, (h.radius || 2) * 1.5 + 2);
      }
    // Pickups and XP shards.
    const pickups = run?.powerups;
    if (pickups)
      for (let i = 0; i < pickups.length; i++) {
        const p = pickups[i];
        if (p.dead || !p.mesh) continue;
        pushColor(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, p.mesh.material.color, 1.6 + 0.4 * Math.sin(t * 4 + i), 4);
      }
    const gems = run?.gems;
    if (gems)
      for (let i = 0, n = Math.min(gems.length, GEM_SCAN); i < n; i++) {
        const g = gems[i];
        if (!g.dead) pushColor(g.x, (ctx.world?.height?.(g.x, g.z) ?? 0) + 0.6, g.z, GEM_COLOR, 0.8, 3);
      }
    // The rift: a slow throb.
    const portal = ctx.world?.portal;
    if (portal?.active) {
      const throb = 0.75 + 0.25 * Math.sin(t * 2.6) + 0.08 * Math.sin(t * 9.1);
      pushColor(portal.x, (portal.y ?? 0) + 2, portal.z, PORTAL_COLOR, 9 * throb, 15);
    }
    // Lava and glowing props, flickering.
    const reach2 = STATIC_REACH * STATIC_REACH;
    for (let i = 0; i < staticCount; i++) {
      const o = i * SS;
      const dx = statics[o] - focus.x,
        dz = statics[o + 2] - focus.z;
      if (dx * dx + dz * dz > reach2) continue;
      const lava = statics[o + 9] > 0;
      const f = lava ? 0.7 + 0.3 * flicker(t * 0.6, statics[o + 8], 10) : 0.8 + 0.2 * flicker(t, statics[o + 8]);
      push(statics[o], statics[o + 1], statics[o + 2], statics[o + 3], statics[o + 4], statics[o + 5], statics[o + 6] * f, statics[o + 7]);
    }
  }

  // Once per rendered frame: pick the LIGHT_POOL best-scoring sources (no allocation).
  function frame(t, dt, frozen) {
    if (!enabled) {
      clearPool();
      return;
    }
    cleared = false;
    placeFill();
    gather(t, frozen, dt);
    for (let l = 0; l < LIGHT_POOL; l++) {
      let best = -1,
        bestScore = 0;
      for (let i = 0; i < candidates; i++)
        if (score[i] > bestScore) {
          bestScore = score[i];
          best = i;
        }
      const light = pool[l];
      if (best < 0) {
        light.intensity = 0;
        continue;
      }
      score[best] = 0;
      const o = best * 8;
      light.position.set(cand[o], cand[o + 1], cand[o + 2]);
      light.color.setRGB(cand[o + 3], cand[o + 4], cand[o + 5]);
      light.intensity = cand[o + 6] * POOL_GAIN;
      light.distance = cand[o + 7];
    }
  }

  function setFocus(x, y, z) {
    focus.set(x, y, z);
  }

  return {
    pool,
    fill,
    applyRig,
    collectStatics,
    kick,
    frame,
    setFocus,
    enabled: () => enabled,
    counts: () => ({ transients, statics: staticCount, candidates }),
  };
}
