// Screen-luminance flash rules (IMPROVEMENTS F17), THREE-free so tests drive them directly;
// renderer.js re-exports them and serves them as gfx.requestFlash(kind, strength).
//
// The budget is always on, whatever the preferences: at most three flashes run at full
// strength in any rolling second (the WCAG 2.3.1 three-flash rule); later requests in that
// second are downgraded to 30%. Reduce flashes also caps the kinds below, each in its own unit
// (overlay opacity, tint or light intensity); a cap is a min(), so an owner that caps too never
// double-dims.
export const FLASH_LIMIT = 3;
export const FLASH_WINDOW = 1; // seconds of real time
export const FLASH_DOWNGRADE = 0.3;

export const REDUCED_FLASH = Object.freeze({
  hit: 0.3, // #hitflash opacity
  lightning: 0.35, // storm light intensity
  beacon: 0.1, // aurora flare tint
  flare: 0.1,
  explosion: 3, // point-light intensity
  light: 3,
});

// createFlashBudget() -> { request(now, strength) -> allowed strength, reset() }. `now` is in
// seconds of real time. A downgraded request does not use up the budget.
export function createFlashBudget({ limit = FLASH_LIMIT, window = FLASH_WINDOW, downgrade = FLASH_DOWNGRADE } = {}) {
  const times = new Array(limit).fill(-Infinity); // ring of the last `limit` full-strength flashes
  let oldest = 0;
  return {
    request(now, strength) {
      if (!(strength > 0)) return 0;
      if (now - times[oldest] < window) return strength * downgrade;
      times[oldest] = now;
      oldest = (oldest + 1) % limit;
      return strength;
    },
    reset() {
      times.fill(-Infinity);
      oldest = 0;
    },
  };
}

// The Reduce flashes cap of a kind (no cap for kinds not listed).
export function reducedFlash(kind, strength, reduce) {
  const cap = REDUCED_FLASH[kind];
  return reduce && cap !== undefined ? Math.min(strength, cap) : strength;
}
