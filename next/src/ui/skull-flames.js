// Purple pixel flames in the menu Death skull's eye sockets. A 40x49 canvas laid exactly over the
// 80x98 skull image (one flame pixel = 2 CSS px, drawn pixelated), rebuilt at a stepped 10 fps.
// Reduced motion or "reduce flashes" draws one fixed frame instead of flickering.

const W = 40;
const H = 49;
const STEP_MS = 100; // 10 fps, PS1 sprite cadence
const FADE_MS = 150;
const LICK = 6; // rows the flames may rise above a socket's top
// Index 0 is empty; 5 is the near-white core.
const PALETTE = [null, "#2a0845", "#5b1896", "#a02fe0", "#e07cff", "#fbeaff"];

// Socket spans per grid row, measured from assets/death-skull.png (122x150) on the 40x49 grid.
const SOCKETS = [
  { 19: [9, 12], 20: [8, 14], 21: [7, 16], 22: [7, 17], 23: [7, 16], 24: [8, 15], 25: [8, 14], 26: [9, 11] },
  { 18: [26, 29], 19: [24, 30], 20: [22, 31], 21: [22, 32], 22: [22, 32], 23: [22, 31], 24: [23, 31], 25: [24, 30], 26: [28, 30] },
].map((spans) => {
  const rows = Object.keys(spans).map(Number);
  const top = Math.min(...rows);
  const bottom = Math.max(...rows);
  const mid = Math.round((top + bottom) / 2);
  return { spans, top, bottom, mid, topSpan: spans[top] };
});

function inSocket(socket, x, y) {
  const span = socket.spans[y];
  return !!span && x >= span[0] && x <= span[1];
}

// One flame frame into `heat` (Uint8Array W*H). `rand` returns [0, 1).
export function flameFrame(heat, rand) {
  heat.fill(0);
  for (const s of SOCKETS) {
    const x0 = Math.min(...Object.values(s.spans).map((span) => span[0])) - 1;
    const x1 = Math.max(...Object.values(s.spans).map((span) => span[1])) + 1;
    for (let y = s.bottom; y >= s.top - LICK; y -= 1) {
      for (let x = x0; x <= x1; x += 1) {
        const socket = inSocket(s, x, y);
        let h;
        if (socket && y >= s.mid) {
          const span = s.spans[y];
          const half = Math.max(1, (span[1] - span[0]) / 2);
          const dist = Math.abs(x - (span[0] + span[1]) / 2) / half;
          // Hot bed: violet at the rim, pink toward the middle, a small white-hot core.
          h = dist > 0.8 ? 2 : 3 + (dist < 0.6 && rand() < 0.6 ? 1 : 0) + (dist < 0.3 && y > s.mid && rand() < 0.6 ? 1 : 0);
        } else {
          const jitter = Math.floor(rand() * 3) - 1;
          const below = heat[(y + 1) * W + Math.max(0, Math.min(W - 1, x + jitter))];
          h = below - (rand() < (socket ? 0.3 : 0.45) ? 1 : 0);
          if (!socket && y >= s.top) h = 0; // never paint over the bone beside a socket
          if (y < s.top && (x < s.topSpan[0] - 2 || x > s.topSpan[1] + 2)) h = 0;
        }
        if (socket) h = Math.max(h, 1); // whole socket keeps a dim glow
        heat[y * W + x] = Math.max(0, h);
      }
    }
  }
  return heat;
}

function seeded(seed) {
  let n = seed >>> 0;
  return () => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return n / 4294967296;
  };
}

export function createSkullFlames(ctx, button) {
  const canvas = document.createElement("canvas");
  canvas.className = "skull-flames";
  canvas.width = W;
  canvas.height = H;
  canvas.setAttribute("aria-hidden", "true");
  button.append(canvas);
  const g = canvas.getContext?.("2d");
  const heat = new Uint8Array(W * H);
  // hover/focus light the eyes briefly; `lit` (Death Mode on) keeps them burning.
  const held = { hover: false, focus: false, lit: false };
  let raf = 0;
  let start = 0;
  let lastStep = -Infinity;

  const still = () => !!ctx.env?.reduced || ctx.prefs?.flashes === false;

  function paint() {
    if (!g) return;
    g.clearRect(0, 0, W, H);
    for (let i = 0; i < heat.length; i += 1) {
      const colour = PALETTE[heat[i]];
      if (!colour) continue;
      g.fillStyle = colour;
      g.fillRect(i % W, (i / W) | 0, 1, 1);
    }
  }

  function tick(now) {
    raf = 0;
    if (!held.hover && !held.focus && !held.lit) return;
    const fade = Math.min(1, (now - start) / FADE_MS);
    canvas.style.opacity = String(Math.round(fade * 4) / 4); // stepped fade, no smooth ramp
    if (still()) {
      if (lastStep < 0) {
        flameFrame(heat, seeded(7));
        paint();
        lastStep = now;
      }
    } else if (now - lastStep >= STEP_MS) {
      flameFrame(heat, Math.random);
      paint();
      lastStep = now;
    }
    if (fade < 1 || !still()) raf = requestAnimationFrame(tick);
  }

  function sync() {
    const on = held.hover || held.focus || held.lit;
    if (on && !raf && canvas.style.opacity !== "1") {
      start = performance.now();
      lastStep = -Infinity;
      raf = requestAnimationFrame(tick);
    } else if (on && !raf && !still()) {
      raf = requestAnimationFrame(tick);
    } else if (!on) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      canvas.style.opacity = "0";
    }
  }

  button.addEventListener("pointerenter", () => { held.hover = true; sync(); });
  button.addEventListener("pointerleave", () => { held.hover = false; sync(); });
  button.addEventListener("focus", () => { held.focus = !!button.matches?.(":focus-visible"); sync(); });
  button.addEventListener("blur", () => { held.focus = false; sync(); });

  // Death Mode keeps the flames burning until it is switched off (or the menu hides).
  function setLit(on) {
    held.lit = !!on;
    sync();
  }

  return { canvas, held, setLit };
}
