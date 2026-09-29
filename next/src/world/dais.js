// The Crown Dais (IMPROVEMENTS F6): six broken crown spikes ringing the stage-5 portal pad under
// KEEPERS, their heights seeded by randomSource(stageSeed + PLACEMENT_OFFSETS.dais). Spikes and
// tips are two InstancedMeshes. The tips wake (setAwake) when the kill goal is met and then
// pulse at 15 fps, steady with Reduce flashes. Each spike is a cover and a walk obstacle; the
// world rebuilds navigation once after placement.
import * as THREE from "three";
import { retroMaterial, unlitMaterial, TILE } from "../render/materials.js";
import { randomSource } from "../core/rng.js";
import { sceneryShapes } from "./scenery.js";
import { coverBounds } from "./ballistics.js";

const SPIKES = 6;
const RING = 6.8; // spike bases around the pad centre
const TILT = 0.3; // inward lean, radians
const WIDTH = 0.6; // spike half-width (the gem's x/z radius)
const MIN_HEIGHT = 3;
const MAX_HEIGHT = 5;
const OBSTACLE = 0.8;
const COVER_RADIUS = 0.45; // upright stand-in for the leaning spike's shot volume
const SPIKE_COLOR = "#54437a";
const TIP = Object.freeze({ x: 0.25, y: 0.6, z: 0.25 });
const TIP_DORMANT = "#3a2a50";
const TIP_AWAKE = "#ba80ef";
const PULSE_LOW = 0.8;
const PULSE_RATE = 5; // rad/s of the awake pulse, sampled at 15 fps

const pose = new THREE.Object3D();
const axis = new THREE.Vector3();
const lean = new THREE.Quaternion();
const tint = new THREE.Color();

// Pad centre = the portal clearing. The spikes stand at i x 60 deg + 30 deg from the portal's
// facing, so the approach from the entry and five other walk gaps stay open.
export function createDais(terrain, scenery, portal, seed) {
  const random = randomSource(seed),
    { geometries, hulls } = sceneryShapes(),
    x = portal.x,
    z = portal.z,
    facing = Math.atan2(-x, -z),
    group = new THREE.Group(),
    spikes = new THREE.InstancedMesh(geometries.gem, retroMaterial(SPIKE_COLOR, TILE.crystal, { occlusion: true }), SPIKES),
    tips = new THREE.InstancedMesh(geometries.gem, unlitMaterial("#ffffff"), SPIKES);
  group.name = "crown-dais";
  tips.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SPIKES * 3), 3);
  group.add(spikes, tips);

  for (let i = 0; i < SPIKES; i++) {
    const a = facing + (i * Math.PI) / 3 + Math.PI / 6,
      bx = x + Math.sin(a) * RING,
      bz = z + Math.cos(a) * RING,
      by = terrain.height(bx, bz),
      h = random(MIN_HEIGHT, MAX_HEIGHT),
      // Unit vector toward the pad centre, and the leaning spike's up axis.
      dx = -Math.sin(a),
      dz = -Math.cos(a),
      ux = dx * Math.sin(TILT),
      uy = Math.cos(TILT),
      uz = dz * Math.sin(TILT);
    lean.setFromAxisAngle(axis.set(dz, 0, -dx), TILT);
    // The gem's centre sits at ground level: radius h up the leaning axis is the visible spike.
    pose.position.set(bx, by, bz);
    pose.quaternion.copy(lean);
    pose.scale.set(WIDTH, h, WIDTH);
    pose.updateMatrix();
    spikes.setMatrixAt(i, pose.matrix);
    pose.position.set(bx + ux * h, by + uy * h, bz + uz * h);
    pose.scale.set(TIP.x, TIP.y, TIP.z);
    pose.updateMatrix();
    tips.setMatrixAt(i, pose.matrix);
    const cover = {
      shape: "cylinder",
      x: bx + (ux * h) / 2,
      y: by + (uy * h) / 2,
      z: bz + (uz * h) / 2,
      sx: COVER_RADIUS,
      sy: uy * h,
      sz: COVER_RADIUS,
      rotation: 0,
      hull: hulls.cylinder,
    };
    cover.bounds = coverBounds(cover);
    scenery.covers.push(cover);
    terrain.addObstacle({ x: bx, z: bz, r: OBSTACLE });
  }
  spikes.computeBoundingSphere();
  tips.computeBoundingSphere();

  let time = 0,
    shown = -1;
  function paint(k) {
    if (k === shown) return;
    shown = k;
    tint.set(dais.awake ? TIP_AWAKE : TIP_DORMANT).multiplyScalar(k);
    for (let i = 0; i < SPIKES; i++) tips.setColorAt(i, tint);
    tips.instanceColor.needsUpdate = true;
  }

  const dais = {
    x,
    z,
    group,
    awake: false,
    setAwake(on) {
      dais.awake = !!on;
      shown = -1;
      paint(1);
    },
    // Simulation step: the awake pulse, held in 15 fps frames; `steady` (Reduce flashes) holds it.
    update(dt, steady = false) {
      if (!dais.awake) return;
      time += dt;
      paint(steady ? 1 : PULSE_LOW + (1 - PULSE_LOW) * (0.5 + 0.5 * Math.sin((Math.floor(time * 15) / 15) * PULSE_RATE)));
    },
    dispose() {
      group.removeFromParent();
      spikes.dispose();
      tips.dispose();
    },
  };
  paint(1);
  return dais;
}
