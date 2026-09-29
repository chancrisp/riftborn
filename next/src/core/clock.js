// Gameplay advances in fixed 1/60 s steps independent of render cadence. Up to 15
// steps (250 ms) of debt are serviced per frame; longer stalls (hidden tab, blocked
// main thread) are discarded so returning never unleashes a lethal catch-up burst.
export const STEP = 1 / 60;

export class SimulationClock {
  constructor() {
    this.debt = 0;
    this.dropped = 0;
    this.steps = 0;
  }
  reset() {
    this.debt = 0;
  }
  // step(dt) may return false to abort the remaining steps this frame (e.g. a
  // state change such as death or a modal opening mid-frame).
  advance(raw, active, step) {
    if (!active || !Number.isFinite(raw) || raw < 0) {
      this.reset();
      return 0;
    }
    if (raw > 0.25) {
      this.dropped += raw;
      this.reset();
      return 0;
    }
    this.debt += raw;
    let n = 0;
    while (this.debt + 1e-9 >= STEP && n < 15) {
      this.debt -= STEP;
      n++;
      this.steps++;
      if (step(STEP) === false) {
        this.reset();
        break;
      }
    }
    return n;
  }
  // 0..1 fraction of a step not yet simulated; lets visuals interpolate.
  get alpha() {
    return Math.min(1, this.debt / STEP);
  }
}

// Render pacing only (FPS cap). Never slows the simulation.
export class FramePacer {
  constructor() {
    this.next = null;
    this.cap = null;
  }
  ready(now, cap) {
    if (!cap) {
      this.next = null;
      this.cap = cap;
      return true;
    }
    const interval = 1000 / cap;
    if (cap !== this.cap || this.next === null) {
      this.cap = cap;
      this.next = now + interval;
      return true;
    }
    if (now + 0.01 < this.next) return false;
    this.next += (Math.max(0, Math.floor((now - this.next + 0.01) / interval)) + 1) * interval;
    return true;
  }
}
