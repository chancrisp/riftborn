// Small math helpers shared by every system. Pure functions, no THREE dependency.
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// Frame-rate independent exponential approach: damp(current, target, rate, dt).
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
export const TAU = Math.PI * 2;
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export const angleDelta = (from, to) => wrapAngle(to - from);
// Yaw convention: 0 faces +Z, atan2(dx, dz).
export const yawTo = (fx, fz, tx, tz) => Math.atan2(tx - fx, tz - fz);
export const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

// Screen-relative input rotated into world space; analog magnitude is preserved (capped at 1).
export function movementVector(x, y, yaw) {
  const length = Math.max(1, Math.hypot(x, y));
  x /= length;
  y /= length;
  return { x: Math.cos(yaw) * x + Math.sin(yaw) * y, z: -Math.sin(yaw) * x + Math.cos(yaw) * y };
}

// Swept circle test: does segment A->B pass within r of point (x, z)?
export function segmentHit(ax, az, bx, bz, x, z, r) {
  const dx = bx - ax,
    dz = bz - az,
    l = dx * dx + dz * dz;
  const t = l ? clamp(((x - ax) * dx + (z - az) * dz) / l, 0, 1) : 0;
  return Math.hypot(ax + t * dx - x, az + t * dz - z) <= r;
}
// Parameter t (0..1) of the closest approach of segment A->B to point (x, z).
export function segmentT(ax, az, bx, bz, x, z) {
  const dx = bx - ax,
    dz = bz - az,
    l = dx * dx + dz * dz;
  return l ? clamp(((x - ax) * dx + (z - az) * dz) / l, 0, 1) : 0;
}

// Faster braking and direction reversal reduce residual drift; top speed unchanged.
export function movementResponse(current, target, dt) {
  const stopping = Math.hypot(target.x, target.z) < 0.05,
    reversing = current.x * target.x + current.z * target.z < 0;
  const response = 1 - Math.exp(-dt * (stopping ? 28 : reversing ? 24 : 18));
  return { x: current.x + (target.x - current.x) * response, z: current.z + (target.z - current.z) * response };
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}
export const formatInt = (n) => Math.round(n || 0).toLocaleString("en-US");
// Numbers shown in previews: small fractions keep 3 significant digits, others 2 decimals.
export const previewNumber = (n) =>
  n > 0 && n < 1 ? Number(n.toPrecision(3)) : Math.round((n + Number.EPSILON * Math.abs(n)) * 100) / 100;

export function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
