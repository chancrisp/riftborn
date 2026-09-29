// Synthesized effect recipes. Pure data: no timers, no audio nodes. Every sound is one or
// more short oscillator tones, each described by a tuple
//   [startHz, seconds, waveform, rawGain, endHz (0 = no glide), delay seconds]
// scheduled by audio.js with a 5 ms attack and an exponential decay to silence.
// `tones` scale with the caller's volume; `fixed` transients never do (the original's
// hard-coded weapon clicks and the level arpeggio). Raw gains sit under the 0.22 master
// headroom and the effects bus.
// Wave-2 recipes (IMPROVEMENTS §3.12) may also carry
//   noise    filtered white-noise layers [filter type, startHz, seconds, rawGain, endHz, delay]
//   tremolo  { rate Hz, depth 0..1 } on every tone
//   crush    bits: the tone envelopes step through 2^bits levels (a 4-bit volume, like the PSG)
//   ui       plays in menus and the attract demo too (like the ui* names)
//   room     feeds the per-stage room echo (default on; interface sounds stay dry)
// Every noise layer reads one sample-and-held white-noise buffer (a ~14 kHz PS1-SPU grit).

// Voice priority: which sounds survive when the SFX voice pool is full. Sounds at
// `event` or above ignore the soft cap and may steal a voice from lower priorities.
export const PRIORITY = Object.freeze({ ambient: 0, hit: 1, action: 2, event: 3, warning: 4, vital: 5 });

const tone = (startHz, seconds, wave, gain, endHz = 0, delay = 0) => Object.freeze([startHz, seconds, wave, gain, endHz, delay]);
const noise = (filter, startHz, seconds, gain, endHz = 0, delay = 0) => Object.freeze([filter, startHz, seconds, gain, endHz, delay]);

function sound(priority, tones, { fixed = [], noise: layers = [], gap, steady = false, stinger = false, tremolo = null, crush = 0, ui = false, room = !ui } = {}) {
  return Object.freeze({
    priority,
    tones: Object.freeze(tones),
    fixed: Object.freeze(fixed),
    noise: Object.freeze(layers),
    gap,
    steady,
    stinger,
    tremolo: tremolo && Object.freeze(tremolo),
    crush,
    ui,
    room,
  });
}

// Interface sounds: steady (no random detune), dry, and crunched to a 5-bit envelope.
function ui(priority, tones, layers = [], gap = 0.12, crush = 5) {
  return sound(priority, tones, { noise: layers, gap, steady: true, crush, room: false });
}

// Stride-derived footsteps: the original's 0.28-0.32 s gaps rejected every other step at
// base speed; this floor only guards against bursts, so every 1.7 m stride is heard.
const STEP_GAP = 0.09;
// Stingers are musical: exact pitch, and at most one per second.
const STINGER = { gap: 1, steady: true, stinger: true };

const { ambient, hit, action, event, warning, vital } = PRIORITY;

// The citadel bell, shared by the Citadel ambience and the Castellan's garrison cue.
const bell = (scale) => [tone(294, 0.91, "sine", 0.018 * scale, 292), tone(699, 0.68, "sine", 0.006 * scale, 697, 0.018)];

// Rift Chain tier-up roots on the A-minor score (A3, C4, E4, A4); chainUp is authored on A3.
export const CHAIN_ROOTS = Object.freeze([220, 261.63, 329.63, 440]);

export const SOUNDS = Object.freeze({
  // Core combat and flow cues.
  bossIntro: sound(event, [tone(65, 1.2, "triangle", 0.12, 42)]),
  phase: sound(event, [tone(130, 0.8, "sawtooth", 0.07, 65)]),
  victory: sound(event, [tone(330, 1.6, "triangle", 0.1, 440)]),
  warnCharge: sound(warning, [tone(125, 0.21, "sawtooth", 0.055, 280)]),
  warnAim: sound(warning, [tone(720, 0.1, "triangle", 0.045, 420)]),
  warnGround: sound(warning, [tone(180, 0.24, "triangle", 0.06, 95)]),
  warnRing: sound(warning, [tone(450, 0.2, "sine", 0.055, 650)]),
  proc: sound(action, [tone(680, 0.09, "triangle", 0.045, 980)]),
  // Guns: a noise crack, a pitched body and a short filtered tail, layered.
  rifle: sound(action, [tone(600, 0.065, "sawtooth", 0.075, 130), tone(150, 0.07, "sine", 0.05, 60)], {
    fixed: [tone(1800, 0.02, "triangle", 0.035, 700)],
    noise: [noise("highpass", 3200, 0.03, 0.05, 1400), noise("bandpass", 900, 0.09, 0.035, 280, 0.01)],
  }),
  smg: sound(action, [tone(850, 0.045, "square", 0.035, 230), tone(190, 0.035, "triangle", 0.03, 80)], {
    noise: [noise("highpass", 4200, 0.025, 0.04), noise("bandpass", 1500, 0.045, 0.022, 500, 0.005)],
  }),
  shotgun: sound(action, [tone(180, 0.14, "sawtooth", 0.18, 40), tone(95, 0.2, "sine", 0.12, 35)], {
    fixed: [tone(62, 0.19, "triangle", 0.08, 30)],
    noise: [noise("highpass", 2600, 0.04, 0.07), noise("lowpass", 2400, 0.22, 0.14, 300), noise("bandpass", 600, 0.35, 0.03, 200, 0.04)],
  }),
  rail: sound(action, [tone(1600, 0.23, "sawtooth", 0.1, 130), tone(62, 0.3, "sine", 0.06, 40)], {
    fixed: [tone(2600, 0.12, "sine", 0.045, 320)],
    noise: [noise("bandpass", 5000, 0.25, 0.04, 800)],
  }),
  rocket: sound(action, [tone(120, 0.25, "sawtooth", 0.2, 35)], {
    fixed: [tone(58, 0.22, "triangle", 0.08, 26)],
    noise: [noise("highpass", 2200, 0.05, 0.04), noise("lowpass", 1500, 0.4, 0.08, 200)],
  }),
  explosion: sound(action, [tone(90, 0.3, "sawtooth", 0.2, 24), tone(55, 0.6, "sine", 0.18, 28)], {
    noise: [noise("highpass", 3000, 0.06, 0.08, 1000), noise("lowpass", 1800, 0.7, 0.2, 120), noise("bandpass", 500, 0.9, 0.05, 150, 0.08)],
    crush: 6,
  }),
  hurt: sound(vital, [tone(140, 0.17, "sawtooth", 0.12, 45), tone(320, 0.08, "square", 0.03, 180)], {
    noise: [noise("bandpass", 1200, 0.1, 0.08, 400)],
    crush: 5,
  }),
  kill: sound(hit, [tone(180, 0.06, "triangle", 0.05, 65), tone(520, 0.05, "square", 0.018, 140, 0.01)], {
    noise: [noise("lowpass", 900, 0.08, 0.035, 200)],
    gap: 0.065,
  }),
  kill2: sound(hit, [tone(150, 0.08, "sawtooth", 0.04, 50), tone(700, 0.04, "triangle", 0.015, 220, 0.012)], {
    noise: [noise("bandpass", 1300, 0.07, 0.03, 300)],
  }),
  gem: sound(action, [tone(1100, 0.07, "sine", 0.05, 1600), tone(2200, 0.05, "sine", 0.015, 3200, 0.02)], {
    noise: [noise("highpass", 6000, 0.02, 0.01)],
    gap: 0.065,
    room: false,
  }),
  dash: sound(action, [tone(220, 0.18, "sawtooth", 0.07, 880)], { noise: [noise("bandpass", 400, 0.2, 0.08, 2400)] }),
  dash2: sound(action, [tone(180, 0.16, "triangle", 0.06, 720)], { noise: [noise("highpass", 800, 0.18, 0.07, 3000)] }),
  dash3: sound(action, [tone(300, 0.14, "square", 0.025, 900)], { noise: [noise("bandpass", 2600, 0.2, 0.07, 500)], crush: 5 }),
  charge: sound(action, [tone(160, 0.35, "sawtooth", 0.1, 500)]),
  mortar: sound(action, [tone(350, 0.12, "triangle", 0.07, 130)], { noise: [noise("lowpass", 700, 0.12, 0.04, 200)] }),
  switch: sound(action, [tone(350, 0.05, "triangle", 0.07, 600)], { noise: [noise("highpass", 3500, 0.02, 0.04)], room: false }),
  // Four rising notes 80 ms apart; ignores the volume argument like the original.
  level: sound(event, [], {
    steady: true,
    fixed: [
      tone(440, 0.25, "triangle", 0.13, 0, 0),
      tone(554, 0.25, "triangle", 0.13, 0, 0.08),
      tone(660, 0.25, "triangle", 0.13, 0, 0.16),
      tone(880, 0.25, "triangle", 0.13, 0, 0.24),
    ],
  }),
  // Wave-1: a bright metallic tick on critical hits.
  crit: sound(action, [tone(1480, 0.05, "square", 0.026, 2220), tone(2960, 0.07, "sine", 0.014, 1980, 0.012)], { gap: 0.1 }),

  // Foley and feedback.
  stepGrass: sound(ambient, [tone(112, 0.045, "triangle", 0.019, 48), tone(540, 0.025, "sawtooth", 0.004, 240, 0.006)], {
    noise: [noise("highpass", 2600, 0.05, 0.006)],
    gap: STEP_GAP,
  }),
  stepStone: sound(ambient, [tone(228, 0.05, "triangle", 0.021, 104)], { noise: [noise("bandpass", 1800, 0.03, 0.008)], gap: STEP_GAP }),
  stepAsh: sound(ambient, [tone(76, 0.065, "sawtooth", 0.012, 37)], { noise: [noise("lowpass", 900, 0.07, 0.008, 300)], gap: STEP_GAP }),
  stepMetal: sound(ambient, [tone(460, 0.065, "sine", 0.019, 318), tone(1090, 0.035, "sine", 0.005, 760, 0.008)], { gap: STEP_GAP }),
  stepVoid: sound(ambient, [tone(137, 0.09, "sine", 0.016, 67), tone(203, 0.06, "sine", 0.005, 104, 0.018)], { gap: STEP_GAP }),
  dashEnd: sound(hit, [tone(420, 0.085, "triangle", 0.033, 72), tone(96, 0.045, "sine", 0.02, 42, 0.025)], { gap: 0.5 }),
  // Lub-dub. The gap sits under the fastest low-HP interval (0.8 s) so the clock governs.
  heartbeat: sound(vital, [tone(56, 0.095, "sine", 0.039, 39), tone(67, 0.075, "sine", 0.024, 41, 0.15)], { gap: 0.7 }),
  shield: sound(vital, [tone(890, 0.13, "triangle", 0.04, 1420), tone(1440, 0.08, "sine", 0.014, 2040, 0.025)], { gap: 0.4 }),
  pickup: sound(action, [tone(590, 0.09, "sine", 0.035, 880), tone(880, 0.095, "sine", 0.019, 1175, 0.065)], { gap: 0.16 }),
  portal: sound(
    event,
    [tone(147, 0.64, "triangle", 0.047, 294), tone(221, 0.46, "sine", 0.021, 442, 0.09), tone(440, 0.26, "sine", 0.012, 660, 0.3)],
    { gap: 2 },
  ),
  playerDeath: sound(vital, [tone(174, 0.62, "sawtooth", 0.062, 35), tone(87, 0.74, "triangle", 0.023, 31, 0.075)], {
    noise: [noise("lowpass", 1200, 1, 0.06, 100)],
    crush: 5,
    gap: 2,
  }),
  impactStone: sound(hit, [tone(310, 0.04, "triangle", 0.025, 115), tone(1190, 0.025, "sine", 0.006, 420, 0.006)], {
    noise: [noise("bandpass", 2500, 0.05, 0.03, 900)],
    gap: 0.12,
  }),
  fleshHit: sound(hit, [tone(176, 0.04, "sawtooth", 0.023, 58), tone(73, 0.045, "sine", 0.014, 36, 0.008)], {
    noise: [noise("lowpass", 700, 0.06, 0.03, 200)],
    gap: 0.12,
  }),
  fleshHit2: sound(hit, [tone(150, 0.05, "square", 0.016, 52), tone(64, 0.05, "sine", 0.014, 34, 0.006)], { noise: [noise("bandpass", 500, 0.06, 0.03, 180)] }),

  // Creature voices: short breaths, clicks and falling calls that sit under the warnings.
  voiceGroan: sound(ambient, [tone(93, 0.43, "triangle", 0.03, 62), tone(139, 0.29, "sine", 0.009, 84, 0.065)], { gap: 3.8 }),
  voiceSkitter: sound(ambient, [tone(830, 0.065, "square", 0.015, 370), tone(1160, 0.045, "triangle", 0.009, 430, 0.09)], { gap: 2.8 }),
  voiceBile: sound(ambient, [tone(118, 0.19, "triangle", 0.033, 43), tone(61, 0.12, "sine", 0.012, 35, 0.045)], { gap: 3.5 }),
  voiceSniper: sound(ambient, [tone(530, 0.16, "sine", 0.019, 710), tone(1060, 0.07, "sine", 0.005, 910, 0.065)], { gap: 4.8 }),
  voiceStorm: sound(ambient, [tone(182, 0.24, "sawtooth", 0.021, 328), tone(277, 0.15, "triangle", 0.01, 415, 0.085)], { gap: 4.2 }),
  voiceBrute: sound(ambient, [tone(58, 0.49, "sawtooth", 0.04, 35), tone(88, 0.31, "triangle", 0.013, 49, 0.08)], { gap: 4.5 }),
  voiceRevenant: sound(ambient, [tone(196, 0.3, "sawtooth", 0.031, 49), tone(98, 0.23, "sine", 0.012, 36, 0.065)], { gap: 3.8 }),
  voiceHex: sound(ambient, [tone(392, 0.29, "triangle", 0.024, 196), tone(416, 0.31, "sine", 0.009, 207, 0.055)], { gap: 4.5 }),
  voiceBrood: sound(ambient, [tone(82, 0.28, "square", 0.021, 46), tone(164, 0.17, "triangle", 0.01, 92, 0.08)], { gap: 4.8 }),
  voiceSplitter: sound(ambient, [tone(153, 0.11, "square", 0.019, 67), tone(233, 0.095, "triangle", 0.01, 93, 0.14)], { gap: 3.2 }),

  // World accents: sparse one-shots over the ambience beds.
  meadowBird: sound(ambient, [tone(1740, 0.07, "sine", 0.012, 2380), tone(2120, 0.055, "sine", 0.007, 2640, 0.095)], { gap: 8 }),
  meadowWind: sound(
    ambient,
    [tone(132, 1.08, "triangle", 0.008, 96), tone(197, 0.86, "sine", 0.004, 146, 0.11), tone(1860, 0.075, "sine", 0.009, 2420, 0.44)],
    { gap: 9 },
  ),
  quarryClank: sound(ambient, [tone(382, 0.28, "triangle", 0.019, 275), tone(914, 0.16, "sine", 0.008, 730, 0.02)], { gap: 8 }),
  calderaRumble: sound(ambient, [tone(43, 1.12, "sine", 0.023, 34), tone(65, 0.86, "triangle", 0.008, 48, 0.11)], { gap: 10 }),
  citadelBell: sound(ambient, bell(1), { gap: 12 }),
  voidWhisper: sound(ambient, [tone(211, 0.82, "triangle", 0.01, 73), tone(223, 0.68, "sine", 0.006, 79, 0.055)], { gap: 11 }),

  // Interface.
  uiOpen: ui(event, [tone(294, 0.09, "square", 0.015, 440), tone(588, 0.07, "triangle", 0.012, 880, 0.03)], [noise("bandpass", 800, 0.08, 0.01, 2400)]),
  uiConfirm: ui(event, [tone(587, 0.085, "square", 0.02, 784), tone(784, 0.065, "triangle", 0.018, 988, 0.06)], [noise("highpass", 4000, 0.015, 0.01)]),
  uiBack: ui(event, [tone(523, 0.07, "square", 0.018, 330), tone(262, 0.08, "triangle", 0.015, 0, 0.03)]),

  // Wave-1 stingers: distinct motifs where the original reused the `level` arpeggio.
  // Rift portal opens: a glassy chime climbing in fifths.
  stingerPortal: sound(
    event,
    [
      tone(440, 0.55, "sine", 0.05, 443),
      tone(659, 0.5, "sine", 0.04, 661, 0.09),
      tone(880, 0.45, "triangle", 0.035, 884, 0.18),
      tone(1319, 0.5, "sine", 0.025, 1325, 0.27),
    ],
    STINGER,
  ),
  // New world: a falling whoosh that blooms into a minor chord once the portal sound clears.
  stingerStage: sound(
    event,
    [
      tone(660, 0.42, "sawtooth", 0.028, 165),
      tone(220, 1, "triangle", 0.06, 0, 0.3),
      tone(262, 0.95, "triangle", 0.042, 0, 0.36),
      tone(330, 0.9, "sine", 0.036, 0, 0.42),
    ],
    STINGER,
  ),
  // Boss arrival: a low tritone brass stab.
  stingerBoss: sound(
    event,
    [tone(55, 1.1, "sawtooth", 0.1, 49), tone(77.8, 1, "sawtooth", 0.07, 69.3), tone(110, 0.5, "square", 0.03, 98, 0.04)],
    STINGER,
  ),
  // Level threshold: an upward power-up leap with a sparkle.
  stingerLevel: sound(
    event,
    [
      tone(392, 0.12, "square", 0.03, 784),
      tone(523, 0.12, "square", 0.028, 0, 0.1),
      tone(659, 0.12, "square", 0.028, 0, 0.2),
      tone(784, 0.4, "triangle", 0.05, 0, 0.3),
      tone(1047, 0.45, "sine", 0.025, 0, 0.3),
      tone(2093, 0.2, "sine", 0.012, 3136, 0.5),
    ],
    { ...STINGER, noise: [noise("highpass", 6000, 0.4, 0.01, 0, 0.3)], crush: 5 },
  ),

  // ---- Wave 2 (IMPROVEMENTS §3.12) -------------------------------------------------------
  // Keepers.
  toll: sound(event, [tone(110, 1.2, "triangle", 0.08, 108), tone(262, 0.9, "sine", 0.04, 259), tone(415, 0.25, "square", 0.012, 410)], { gap: 0.4 }),
  skid: sound(action, [], { noise: [noise("lowpass", 300, 0.3, 0.05)], gap: 0.3 }),
  emberHit: sound(hit, [tone(880, 0.05, "square", 0.02, 440)], { gap: 0.05 }),
  rumble: sound(warning, [tone(45, 0.8, "sine", 0.03)], { noise: [noise("lowpass", 120, 0.8, 0.06)], gap: 0.5 }),
  aegisBlock: sound(hit, [tone(1250, 0.05, "square", 0.018, 900)], { gap: 0.06 }),
  vigilHum: sound(warning, [tone(196, 2.6, "triangle", 0.02)], { tremolo: { rate: 6, depth: 0.5 }, gap: 2 }),
  // The citadel bell louder and without the ambient gap, so the cue and its caption always play.
  garrisonBell: sound(event, bell(1.4), { gap: 1 }),

  // Creatures.
  voiceDrowned: sound(ambient, [tone(70, 0.35, "square", 0.028, 45)], { gap: 4 }),
  gurgle: sound(warning, [tone(140, 0.5, "square", 0.03, 60), tone(55, 0.6, "triangle", 0.04, 40)], { gap: 0.3 }),
  voiceWorm: sound(ambient, [tone(140, 0.2, "square", 0.02, 60)], { noise: [noise("lowpass", 400, 0.2, 0.03)], gap: 3.5 }),
  voiceLamp: sound(ambient, [tone(660, 0.35, "sine", 0.012, 620)], { gap: 5 }),
  wardChime: sound(warning, [tone(1320, 0.25, "triangle", 0.02), tone(1760, 0.25, "sine", 0.012)], { gap: 0.3 }),

  // Elites and relics.
  eliteSpawn: sound(event, [tone(98, 0.5, "sawtooth", 0.03, 92), tone(147, 0.5, "triangle", 0.02, 139)], {
    noise: [noise("lowpass", 300, 0.6, 0.04, 1200)],
    gap: 0.5,
  }),
  eliteDeath: sound(event, [tone(65, 0.4, "sawtooth", 0.04, 40), tone(1200, 0.3, "square", 0.015, 200, 0.05)], {
    noise: [noise("lowpass", 2000, 0.5, 0.06, 150)],
    gap: 0.2,
  }),
  relic: sound(event, [tone(523, 0.12, "triangle", 0.03), tone(784, 0.12, "triangle", 0.03, 0, 0.08), tone(1047, 0.2, "triangle", 0.025, 0, 0.16)], {
    gap: 0.3,
  }),

  // Living worlds.
  gasPop: sound(action, [tone(300, 0.18, "square", 0.03, 80)], { noise: [noise("lowpass", 800, 0.15, 0.03)], gap: 0.05 }),
  fuse: sound(warning, [], { noise: [noise("highpass", 3000, 0.5, 0.02)], gap: 0.3 }),
  rockfall: sound(action, [tone(60, 0.3, "sawtooth", 0.04, 35)], { noise: [noise("lowpass", 500, 0.4, 0.06)], gap: 0.1 }),
  beaconFlare: sound(event, [tone(880, 0.6, "triangle", 0.02), tone(1109, 0.6, "triangle", 0.02), tone(1320, 0.6, "triangle", 0.02)], { gap: 1 }),
  crystalFall: sound(action, [tone(1600, 0.6, "triangle", 0.02, 400)], { gap: 0.2 }),

  // Rift Chain and feats: two crushed square notes, a root and its fifth (pitched per tier).
  chainUp: sound(event, [tone(220, 0.06, "square", 0.02), tone(330, 0.06, "square", 0.02, 0, 0.06)], { crush: 4, steady: true, gap: 0.2 }),
  chainBreak: sound(event, [tone(400, 0.25, "sawtooth", 0.03, 90)], { noise: [noise("highpass", 2000, 0.03, 0.02)], gap: 0.3 }),
  feat: sound(event, [tone(880, 0.12, "triangle", 0.025)], { gap: 0.08 }),

  // Heals, codex and unlocks.
  heal: sound(action, [tone(523, 0.12, "sine", 0.03, 784), tone(784, 0.12, "sine", 0.02, 1046, 0.06)], { gap: 0.1 }),
  newEntry: sound(event, [tone(1047, 0.12, "triangle", 0.02), tone(1319, 0.12, "triangle", 0.02, 0, 0.08)], { gap: 1 }),
  unlock: sound(event, [tone(659, 0.15, "triangle", 0.025), tone(988, 0.15, "triangle", 0.025, 0, 0.15)], { gap: 1 }),

  // Transitions and title cards (F20). The warp plays reversed on IN; both run from the menu.
  riftWarp: sound(event, [tone(110, 0.45, "sawtooth", 0.03, 880)], { noise: [noise("bandpass", 400, 0.45, 0.03, 3000)], gap: 0.4, ui: true }),
  uiTick: sound(ambient, [tone(1320, 0.02, "sine", 0.01)], { gap: 0.03, steady: true }),

  // ---- Sound pass: a crunchy PS1-console interface set (ui-sounds.js wires it) -------------
  uiHover: ui(ambient, [tone(2200, 0.018, "square", 0.006, 1800)], [], 0.045, 4),
  uiMove: ui(ambient, [tone(1760, 0.025, "square", 0.007, 1480)], [], 0.04, 4),
  uiClick: ui(event, [tone(1600, 0.02, "square", 0.012, 900), tone(520, 0.05, "triangle", 0.02, 380, 0.005)], [noise("highpass", 4000, 0.015, 0.01)], 0.05),
  uiClose: ui(event, [tone(880, 0.07, "triangle", 0.012, 440), tone(440, 0.09, "square", 0.014, 294, 0.03)], [noise("bandpass", 2400, 0.08, 0.01, 800)]),
  uiTab: ui(event, [tone(1047, 0.03, "square", 0.012), tone(1568, 0.04, "square", 0.01, 0, 0.03)], [], 0.06, 4),
  uiToggleOn: ui(event, [tone(660, 0.04, "square", 0.014), tone(990, 0.06, "square", 0.014, 0, 0.045)], [], 0.08),
  uiToggleOff: ui(event, [tone(990, 0.04, "square", 0.014), tone(660, 0.06, "square", 0.012, 0, 0.045)], [], 0.08),
  uiSlider: ui(ambient, [tone(1200, 0.015, "square", 0.008)], [], 0.035, 4),
  uiCycle: ui(event, [tone(880, 0.03, "square", 0.01), tone(1320, 0.035, "triangle", 0.01, 0, 0.03)], [], 0.06),
  uiCardHover: ui(ambient, [tone(784, 0.05, "triangle", 0.012, 1175), tone(2349, 0.03, "sine", 0.004, 0, 0.01)], [], 0.06),
  uiCardPick: ui(
    event,
    [tone(392, 0.1, "square", 0.02, 784), tone(784, 0.18, "triangle", 0.025, 0, 0.06), tone(1175, 0.22, "triangle", 0.02, 0, 0.12), tone(1568, 0.25, "sine", 0.012, 0, 0.18)],
    [noise("highpass", 5000, 0.2, 0.008, 0, 0.1)],
  ),
  uiError: ui(event, [tone(185, 0.09, "square", 0.03), tone(175, 0.12, "square", 0.03, 0, 0.1)], [], 0.25, 4),
  uiPause: ui(event, [tone(880, 0.06, "square", 0.015, 440), tone(220, 0.12, "triangle", 0.02, 0, 0.05)], [noise("lowpass", 3000, 0.15, 0.01, 300)], 0.2),
  uiResume: ui(event, [tone(220, 0.06, "triangle", 0.02, 440), tone(660, 0.1, "square", 0.012, 880, 0.05)], [noise("highpass", 2500, 0.06, 0.008)], 0.2),

  // ---- Sound pass: gameplay foley where the game was silent ------------------------------
  emerge: sound(hit, [tone(70, 0.35, "sine", 0.03, 110)], { noise: [noise("lowpass", 200, 0.35, 0.035, 900)], gap: 0.18 }),
  casing: sound(ambient, [tone(3400, 0.03, "sine", 0.006, 3000, 0.14), tone(4100, 0.025, "sine", 0.004, 3800, 0.22), tone(2900, 0.02, "sine", 0.003, 2800, 0.29)], {
    gap: 0.09,
    room: false,
  }),
  shell: sound(ambient, [tone(900, 0.05, "triangle", 0.008, 700, 0.2), tone(760, 0.04, "triangle", 0.005, 620, 0.31)], { gap: 0.3, room: false }),
  whiz: sound(hit, [tone(1400, 0.14, "sine", 0.012, 700)], { noise: [noise("bandpass", 3000, 0.15, 0.03, 1200)], gap: 0.12, room: false }),
  ricochet: sound(hit, [tone(2400, 0.22, "sine", 0.014, 1300, 0.01), tone(3300, 0.12, "triangle", 0.006, 2000, 0.02)], {
    noise: [noise("highpass", 3000, 0.03, 0.02)],
    gap: 0.15,
  }),
  stepGrass2: sound(ambient, [tone(98, 0.05, "triangle", 0.016, 44)], { noise: [noise("highpass", 3200, 0.06, 0.008)] }),
  stepStone2: sound(ambient, [tone(250, 0.045, "triangle", 0.018, 120)], { noise: [noise("bandpass", 2400, 0.025, 0.01)] }),
  stepAsh2: sound(ambient, [tone(68, 0.07, "triangle", 0.012, 34)], { noise: [noise("lowpass", 700, 0.09, 0.01, 250)] }),
  stepMetal2: sound(ambient, [tone(520, 0.06, "sine", 0.017, 360), tone(1240, 0.03, "sine", 0.005, 900, 0.006)], { noise: [noise("highpass", 4000, 0.02, 0.004)] }),
  stepVoid2: sound(ambient, [tone(123, 0.1, "sine", 0.015, 61)], { noise: [noise("bandpass", 400, 0.1, 0.005, 200)] }),
  // Weapon switch: a per-weapon handling clack after the generic `switch` click.
  rack0: sound(action, [tone(900, 0.03, "square", 0.012, 500, 0.05)], { noise: [noise("bandpass", 2200, 0.03, 0.04), noise("bandpass", 1600, 0.03, 0.035, 0, 0.07)], gap: 0.1, room: false }),
  rack1: sound(action, [tone(1400, 0.02, "square", 0.01, 900, 0.04)], { noise: [noise("highpass", 3500, 0.02, 0.035), noise("highpass", 3000, 0.02, 0.03, 0, 0.05)], gap: 0.1, room: false }),
  rack2: sound(action, [tone(220, 0.06, "triangle", 0.03, 150, 0.12)], { noise: [noise("lowpass", 1200, 0.08, 0.05), noise("lowpass", 1400, 0.06, 0.05, 0, 0.12)], gap: 0.1, room: false }),
  rack3: sound(action, [tone(400, 0.3, "sine", 0.015, 2400)], { noise: [noise("highpass", 3000, 0.02, 0.03, 0, 0.3)], gap: 0.1, room: false }),
  rack4: sound(action, [tone(90, 0.12, "triangle", 0.04, 60), tone(1200, 0.05, "square", 0.01, 0, 0.2)], { noise: [noise("lowpass", 600, 0.12, 0.05)], gap: 0.1, room: false }),
  critKill: sound(action, [tone(2637, 0.12, "square", 0.018), tone(1319, 0.18, "triangle", 0.02, 0, 0.03)], {
    noise: [noise("highpass", 5000, 0.05, 0.02)],
    gap: 0.12,
    crush: 5,
  }),
  // Keepers: phase change, stagger and fall.
  stingerPhase: sound(
    event,
    [tone(110, 0.9, "sawtooth", 0.06, 55), tone(116.5, 0.8, "sawtooth", 0.04, 58), tone(440, 0.3, "square", 0.02, 220, 0.1)],
    { ...STINGER, noise: [noise("lowpass", 400, 0.9, 0.04, 3000)] },
  ),
  keeperStagger: sound(event, [tone(80, 0.4, "sawtooth", 0.05, 50)], { noise: [noise("lowpass", 1500, 0.35, 0.05, 200)], gap: 0.5 }),
  keeperFall: sound(event, [tone(98, 1.4, "triangle", 0.07, 49), tone(147, 1.2, "sine", 0.04, 73, 0.1), tone(196, 1, "sine", 0.025, 98, 0.2)], {
    noise: [noise("lowpass", 900, 1.5, 0.07, 80)],
    gap: 2,
  }),
  // Spatial beds re-struck by the foley clock: an open portal's hum, lava and live props.
  portalHum: sound(ambient, [tone(73.4, 1.3, "sine", 0.022, 75), tone(880, 1.2, "sine", 0.003, 900)], { tremolo: { rate: 3, depth: 0.6 }, gap: 1 }),
  lavaBubble: sound(ambient, [tone(90, 0.12, "sine", 0.012, 180)], { noise: [noise("lowpass", 500, 0.25, 0.015, 200)], gap: 0.6 }),
  hazardHiss: sound(ambient, [], { noise: [noise("bandpass", 1800, 0.6, 0.006, 1400)], gap: 1.5 }),
});

// Random alternates: a request for the key plays one of these (sharing the key's cooldown).
export const VARIANTS = Object.freeze({
  dash: Object.freeze(["dash", "dash2", "dash3"]),
  kill: Object.freeze(["kill", "kill2"]),
  fleshHit: Object.freeze(["fleshHit", "fleshHit2"]),
  stepGrass: Object.freeze(["stepGrass", "stepGrass2"]),
  stepStone: Object.freeze(["stepStone", "stepStone2"]),
  stepAsh: Object.freeze(["stepAsh", "stepAsh2"]),
  stepMetal: Object.freeze(["stepMetal", "stepMetal2"]),
  stepVoid: Object.freeze(["stepVoid", "stepVoid2"]),
});

// Weapon slot -> handling clack; weapon slot -> ejected brass (none for rail and rocket).
export const WEAPON_RACKS = Object.freeze(["rack0", "rack1", "rack2", "rack3", "rack4"]);
export const CASINGS = Object.freeze(["casing", "casing", "shell", null, null]);

// Per-stage room echo (a feedback delay with a darkening loop): [delay s, feedback, wet, lowpass Hz].
export const ROOMS = Object.freeze([
  Object.freeze([0.09, 0.15, 0.1, 2500]), // meadow: open air, a faint slap
  Object.freeze([0.14, 0.35, 0.2, 3000]), // quarry: canyon walls
  Object.freeze([0.12, 0.3, 0.16, 1800]), // caldera: dull basalt
  Object.freeze([0.19, 0.45, 0.22, 2600]), // citadel: stone halls
  Object.freeze([0.28, 0.55, 0.25, 1500]), // void: a long dark tail
]);

// Per-type retrigger gap shared by every emitter (unknown names still take a slot).
export function gapOf(name) {
  const gap = SOUNDS[name]?.gap;
  if (gap !== undefined) return gap;
  return name.startsWith("warn") ? 0.3 : 0.03;
}

export const priorityOf = (name) => SOUNDS[name]?.priority ?? (name.startsWith("warn") ? PRIORITY.warning : PRIORITY.hit);

// Sounds that play outside a live run too (menus, the attract demo).
export const isInterface = (name) => name.startsWith("ui") || !!SOUNDS[name]?.ui;

// Enemy kind -> vocalisation (Iron Maw uses "ironmaw", the final boss "warden"; keepers use
// their keeper id).
export const ENEMY_VOICES = Object.freeze({
  runner: "voiceGroan",
  skitter: "voiceSkitter",
  gunner: "voiceBile",
  charger: "voiceGroan",
  brute: "voiceBrute",
  mortar: "voiceBile",
  sniper: "voiceSniper",
  leaper: "voiceGroan",
  splitter: "voiceSplitter",
  stormer: "voiceStorm",
  revenant: "voiceRevenant",
  hexer: "voiceHex",
  broodmother: "voiceBrood",
  ironmaw: "voiceBrute",
  warden: "voiceHex",
  drowned: "voiceDrowned",
  ashworm: "voiceWorm",
  lamplighter: "voiceLamp",
  bellwether: "voiceGroan",
  abbot: "voiceBrute",
  castellan: "voiceBrute",
});

// Playback rate per kind (1 when absent): the keepers borrow creature voices, pitched.
export const VOICE_RATES = Object.freeze({ bellwether: 0.7, abbot: 0.8, castellan: 1.1 });

// Index = stage - 1 (the tutorial walks the Meadows).
export const STEP_SOUNDS = Object.freeze(["stepGrass", "stepStone", "stepAsh", "stepMetal", "stepVoid"]);
export const AMBIENT_SOUNDS = Object.freeze(["meadowWind", "quarryClank", "calderaRumble", "citadelBell", "voidWhisper"]);
// A second, sparser accent layer per stage (birdsong over the meadow wind).
export const AMBIENT_EXTRAS = Object.freeze(["meadowBird", null, null, null, null]);

// Wave-1 ambience beds: one quiet looping filtered-noise room tone per stage, breathing
// with a slow LFO on level (`depth`, 0..1) and optionally on the filter (`sweep`, Hz).
// `hum` adds faint sine partials ([Hz, level relative to the bed]) under the noise.
export const AMBIENCE_BEDS = Object.freeze([
  // Meadows: gusting wind.
  Object.freeze({ filter: "bandpass", freq: 520, q: 0.7, gain: 0.035, lfo: 0.11, depth: 0.5, sweep: 180, hum: [] }),
  // Shattered Quarry: hollow cave air.
  Object.freeze({ filter: "lowpass", freq: 260, q: 0.8, gain: 0.06, lfo: 0.05, depth: 0.3, sweep: 0, hum: [] }),
  // Ember Caldera: the mountain's low roar.
  Object.freeze({ filter: "lowpass", freq: 150, q: 1.1, gain: 0.085, lfo: 0.08, depth: 0.35, sweep: 40, hum: [[41, 0.1]] }),
  // Aurora Citadel: thin whistling air between towers.
  Object.freeze({ filter: "bandpass", freq: 1700, q: 1.6, gain: 0.03, lfo: 0.06, depth: 0.55, sweep: 300, hum: [] }),
  // The Void Crown: a slow beating drone under dark noise.
  Object.freeze({ filter: "lowpass", freq: 120, q: 0.9, gain: 0.06, lfo: 0.035, depth: 0.4, sweep: 0, hum: [[55, 0.18], [55.4, 0.18]] }),
]);
