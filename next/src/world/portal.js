// The rift portal: built once, moved to each stage's portal clearing. The ring hovers over a
// low stone dais and faces the path arriving from the entry plaza (the original always faced
// +/-Z and sank 0.8 m into the ground). Opening/entry rules belong to the director.
import * as THREE from "three";
import { retroMaterial, unlitMaterial } from "../render/materials.js";
import { propTile, sceneryShapes, stagePalette } from "./scenery.js";

const OUTER_REACH = 3.1 + 0.37; // outer ring radius + tube
const DAIS_TOP = 0.3;
const SPIN = 0.72;
const PULSE = 0.08;
// The tutorial's rift gate (lintel underside ~6.35 m) is lower than the full ring at peak
// pulse, so the training rift is drawn at 0.8 scale to stand between dais and lintel.
const TRAINING_SIZE = 0.8;
const SPARK_RATE = 9;
const SPARK = "#b974ff";
const LIGHT = "#9e5cff";
// Light pulse [base, amplitude, rad/s]; Reduce flashes (IMPROVEMENTS F17) softens and slows it.
const LIGHT_PULSE = Object.freeze([19, 6, 9]);
const LIGHT_PULSE_REDUCED = Object.freeze([19, 1.5, 3]);
const rand = (a, b) => a + Math.random() * (b - a);

export function createPortal(ctx) {
  const outerGeometry = new THREE.TorusGeometry(3.1, 0.37, 5, 8),
    innerGeometry = new THREE.TorusGeometry(2.5, 0.08, 4, 12),
    coreGeometry = new THREE.IcosahedronGeometry(1.6, 1),
    group = new THREE.Group(),
    inner = new THREE.Mesh(innerGeometry, unlitMaterial("#d9a7ff"));
  group.name = "rift-portal";
  group.visible = false;
  group.add(new THREE.Mesh(outerGeometry, unlitMaterial("#9a7cff")), inner, new THREE.Mesh(coreGeometry, unlitMaterial("#812bff")));

  // The dais and the light live outside the ring group: the dais stays visible while the rift
  // is closed, and a light that never leaves the scene avoids a shader recompile on opening.
  const base = new THREE.Group(),
    light = new THREE.PointLight(LIGHT, 0, 18, 2),
    box = sceneryShapes().geometries.box,
    meadow = daisMaterials(1, false),
    slab = slabMesh(box, meadow.slab, 7, 0.16, 3.4, 0.08),
    step = slabMesh(box, meadow.step, 5, 0.14, 2.2, 0.23),
    rune = slabMesh(box, unlitMaterial(SPARK), 3.6, 0.03, 0.35, 0.315);
  base.name = "rift-dais";
  rune.visible = false;
  base.add(slab, step, rune, light);
  let daisShown = true,
    size = 1;

  const portal = {
    x: 0,
    z: 0,
    y: 0, // ground height at the portal
    group,
    base,
    active: false,
    setActive(on) {
      portal.active = !!on;
      group.visible = portal.active;
      rune.visible = portal.active && daisShown;
      if (!portal.active) light.intensity = 0;
    },
    // Visual pulse on run time (freezes with the game) plus idle sparks while open.
    update(dt, time) {
      inner.rotation.z += SPIN * dt;
      group.scale.setScalar(size * (1 + PULSE * Math.sin(time * 4)));
      const [base, amplitude, rate] = ctx.prefs?.flashes === false ? LIGHT_PULSE_REDUCED : LIGHT_PULSE;
      light.intensity = portal.active ? base + amplitude * Math.sin(time * rate) : 0;
      if (portal.active && Math.random() < dt * SPARK_RATE)
        ctx.fx?.burst?.(portal.x + rand(-2.5, 2.5), rand(1, 6), portal.z + rand(-2.5, 2.5), SPARK, 1, 1.8);
    },
    // Moves the portal onto the stage's clearing (layout point 0), facing the entry. `crownDais`
    // (KEEPERS stage 5, IMPROVEMENTS F6) keeps the pad for the Crown Dais.
    place(terrain, { crownDais = false } = {}) {
      const [x, z] = terrain.points[0],
        y = terrain.height(x, z),
        yaw = Math.atan2(-x, -z),
        look = daisMaterials(terrain.stage, terrain.tutorial);
      size = terrain.tutorial ? TRAINING_SIZE : 1;
      // Ring centre: at peak pulse the ring just kisses the dais instead of sinking into it.
      const hover = DAIS_TOP + OUTER_REACH * size * (1 + PULSE) - 0.05;
      portal.x = x;
      portal.z = z;
      portal.y = y;
      group.position.set(x, y + hover, z);
      group.scale.setScalar(size);
      light.position.y = hover;
      group.rotation.set(0, yaw, 0);
      base.position.set(x, y, z);
      base.rotation.set(0, yaw, 0);
      slab.material = look.slab;
      step.material = look.step;
      // Stage 5 never opens a rift (the Warden guards it), so its clearing stays bare unless the
      // Crown Dais stands there.
      daisShown = terrain.tutorial || terrain.stage < 5 || crownDais;
      slab.visible = step.visible = daisShown;
      rune.visible = portal.active && daisShown;
    },
    dispose() {
      group.removeFromParent();
      base.removeFromParent();
      outerGeometry.dispose();
      innerGeometry.dispose();
      coreGeometry.dispose();
    },
  };
  return portal;
}

// The dais wears the stage's prop palette: a pad in `high` under a step in `trail`.
function daisMaterials(stage, tutorial) {
  const { high, trail } = stagePalette(stage, tutorial),
    tile = propTile(stage);
  return { slab: retroMaterial(high, tile, { occlusion: true }), step: retroMaterial(trail, tile, { occlusion: true }) };
}
function slabMesh(geometry, material, sx, sy, sz, y) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(sx, sy, sz);
  mesh.position.y = y;
  return mesh;
}
