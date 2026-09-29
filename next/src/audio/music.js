// Procedural soundtrack: the original arcade-horror score (two alternating 16-bar
// arrangements plus a restrained half-time menu theme), its synth instruments, and the
// transport that picks an arrangement from the game state on every bar line.
// Wave-1 additions: a key and lead timbre per stage, a Warden / Iron Maw boss layer,
// 100 ms fades instead of hard cuts, and a low-pass "underwater" duck while paused.
// Wave-2 additions (IMPROVEMENTS §3.12): every live keeper plays the boss arrangement, the
// Crown Unmade sustains the unmadeDrone under it, mono audio centres every voice, and the
// shade echo send (createShadeEcho) that audio.js routes the Warden's shades through.

export const MUSIC_TEMPO = Object.freeze({ normal: 140, death: 168 });

const ACTIVITIES = new Set(["menu", "quiet", "normal", "trial", "boss"]);
const BOSS_SEQUENCES = new Set(["maw", "warden", "phase", "bellwether", "abbot", "castellan", "dais", "unmade"]);
const QUIET_VOICES = new Set(["bass", "organ", "bell", "choir"]);

const SCORE_VOLUME = 0.85; // fixed per-note level handed to the instruments
const LOOKAHEAD = 0.12; // seconds of notes scheduled ahead of the audio clock
const START_OFFSET = 0.02;
const FADE = 0.1; // music stops fade out instead of cutting
const DUCK_TAU = 0.12;
const VOICE_CAP = 96;
const ECHO_TIME = 0.268;
const ECHO_FEEDBACK = 0.24;
const ECHO_WET = 0.19;
const OPEN_FILTER = 20000;
const UNDERWATER_FILTER = 850;
// The Crown Unmade drone: a 49 Hz sawtooth under a 300 Hz low-pass, held while phase 3 lasts.
const DRONE_HZ = 49;
const DRONE_FILTER = 300;
const DRONE_GAIN = 0.05;
const DRONE_FADE = 0.4;
// The shades' echo send: one short slap-back that dies away.
const SHADE_ECHO_TIME = 0.15;
const SHADE_ECHO_FEEDBACK = 0.3;
const SHADE_ECHO_WET = 0.5;

// Semitone shift per stage (index 0 = menu / no run; the Meadows keep the original key).
const STAGE_KEYS = [0, 0, 2, -2, 3, -3];

const pitch = (semitones) => 55 * 2 ** (semitones / 12); // 0 = A1
const tempoOf = (death) => (death ? MUSIC_TEMPO.death : MUSIC_TEMPO.normal);

// Lead melodies: row = section (intro, development, breakdown, climax), column = 16th.
const HOOKS = [
  [12, null, 19, 15, null, 12, 10, null, 12, 15, 19, null, 22, 19, 15, null],
  [19, null, 24, 22, 19, null, 15, 19, 17, null, 15, 12, 11, null, 7, null],
  [24, null, null, 19, null, null, 15, null, 22, null, null, 19, null, null, 11, null],
  [12, 19, 24, null, 22, 19, 15, 19, 12, null, 15, 19, 23, 22, 19, 11],
];
const ANSWERS = [
  [19, null, 15, 12, null, 10, 12, 15, 19, 22, null, 24, 23, null, 19, null],
  [24, 23, 19, null, 22, null, 19, 15, 17, 19, null, 15, 12, null, 11, null],
  [31, null, null, null, 27, null, 26, null, 24, null, null, null, 23, null, 19, null],
  [12, 15, 19, 24, 23, null, 22, 19, 17, 15, 12, null, 11, 15, 19, 23],
];
// Menu theme: row = bar mod 4, column = beat 0/4/8/12.
const MENU_HOOKS = [
  [24, null, 19, 22],
  [19, 15, null, 12],
  [27, null, 24, 19],
  [23, 19, 15, null],
];
// Syncopated bass (semitones above the chord root). Death Mode swaps in a flat-2 turn.
const BASS_HOOK = [0, null, 0, 12, null, 0, 7, null, 0, 12, null, 0, 7, null, 12, 7];
const BASS_ANSWER = [0, null, 7, 12, 0, null, 10, null, 0, 7, null, 12, 0, null, 7, 11];
const ROOTS_HOOK = [0, -4, -2, -5]; // A F G E
const ROOTS_ANSWER = [0, -2, -4, -5]; // A G F E
const PLUCK_LINE = [31, 27, 29, 23];
const MENU_ROOTS = [0, -4, -2, -5];

function bassNote(answer, beat, death) {
  if (death && beat === (answer ? 13 : 15)) return 1;
  return (answer ? BASS_ANSWER : BASS_HOOK)[beat];
}

// Reusable event buffer so composing a 16th allocates nothing once warmed up.
export function createEventList() {
  const items = [];
  return {
    items,
    length: 0,
    clear() {
      this.length = 0;
    },
    add(voice, gain, duration, semitones) {
      let ev = items[this.length];
      if (!ev) {
        ev = { voice: "", gain: 0, duration: 0, frequency: 0 };
        items.push(ev);
      }
      ev.voice = voice;
      ev.gain = gain;
      ev.duration = duration;
      ev.frequency = semitones === undefined ? 0 : pitch(semitones);
      this.length++;
    },
    // Keep only `voices`, scaling their gain; pooled objects are swapped, never dropped.
    keep(voices, scale) {
      let n = 0;
      for (let i = 0; i < this.length; i++) {
        const ev = items[i];
        if (!voices.has(ev.voice)) continue;
        ev.gain *= scale;
        if (i !== n) {
          items[i] = items[n];
          items[n] = ev;
        }
        n++;
      }
      this.length = n;
    },
  };
}

const NO_FLAVOR = Object.freeze({ stage: 0, boss: null, rage: false });

// The note events of one 16th step. `flavor` = { stage, boss: null|"warden"|"maw", rage }.
export function scoreEvents(step, death = false, activity = "normal", flavor = NO_FLAVOR, list = createEventList()) {
  list.clear();
  const bar = Math.floor(step / 16) % 16,
    beat = step % 16,
    section = Math.floor(bar / 4),
    chord = bar % 4,
    sixteenth = 60 / tempoOf(death) / 4;
  if (activity === "menu") {
    composeMenu(list, bar, beat, sixteenth);
    return list;
  }
  const answer = Math.floor(step / 256) % 2 === 1,
    root = (answer ? ROOTS_ANSWER : ROOTS_HOOK)[chord] + (STAGE_KEYS[flavor.stage] ?? 0),
    breakdown = section === 2,
    climax = section === 3;

  const bass = bassNote(answer, beat, death);
  if (bass !== null && (!breakdown || beat % 4 === 0)) list.add("bass", death ? 0.36 : 0.3, sixteenth * (beat % 4 === 0 ? 1.45 : 0.8), root + bass);
  if (beat % 4 === 0 || (death && !breakdown && (beat === 3 || beat === 10 || beat === 14)) || (climax && beat === 15)) list.add("kick", 0.92, 0.22);
  if ((breakdown ? beat === 8 : beat === 4 || beat === 12) || (chord === 3 && beat >= 14)) list.add("snare", beat >= 14 ? 0.31 : 0.48, 0.16);
  if (!breakdown && (beat % 2 === 0 || climax || death)) list.add("hat", beat % 4 === 2 ? 0.16 : 0.075, beat % 4 === 2 ? 0.11 : 0.045);
  if (breakdown && beat % 4 === 2) list.add("hat", 0.08, 0.08);

  const melody = (answer ? ANSWERS : HOOKS)[section][beat];
  if (melody !== null) {
    // Over the closing E chord the minor third is raised: a harmonic-minor resolution.
    const note = root + melody + (chord === 3 && melody % 12 === 3 ? 1 : 0);
    list.add("lead", breakdown ? 0.12 : death ? 0.19 : 0.17, sixteenth * (breakdown ? 2.7 : 1.3), note + 12);
  }
  if (beat === 0) {
    const third = chord === 3 ? 4 : 3;
    const gain = breakdown ? 0.065 : 0.045,
      length = sixteenth * (breakdown ? 15 : 10);
    list.add("organ", gain, length, root + 12);
    list.add("organ", gain, length, root + third + 12);
    list.add("organ", gain, length, root + 19);
    list.add("bell", 0.12, 1.25, root + 36 + (bar % 2 ? 7 : 0));
  }
  if (beat === 10 && bar % 2 === 1) list.add("bell", 0.09, 0.85, root + 31);
  if (climax && beat === 14) list.add("bell", 0.1, 0.8, root + 36);
  // The answer arrangement adds a synthetic choir and a glassy pluck counterline.
  if (answer && beat === 0 && (breakdown || climax)) {
    const gain = breakdown ? 0.037 : 0.024,
      length = sixteenth * (breakdown ? 15 : 11);
    list.add("choir", gain, length, root + 12);
    list.add("choir", gain, length, root + 19);
  }
  if (answer && !breakdown && (beat === 6 || beat === 14))
    list.add("pluck", death ? 0.09 : 0.075, sixteenth * 1.7, root + PLUCK_LINE[chord] + (beat === 14 ? -5 : 0));

  if (activity === "quiet") {
    list.keep(QUIET_VOICES, 0.7);
    return list;
  }
  if (activity === "trial" || activity === "boss") {
    if (beat % 4 === 2) list.add("bass", 0.1, sixteenth * 0.6, root + 19 + (death ? 1 : 0));
  }
  if (activity === "boss") {
    if (beat % 4 === 2) list.add("bell", 0.06, 0.35, root + 31);
    if (beat % 4 === 3) list.add("hat", 0.07, 0.035);
    if (flavor.boss === "warden") composeWarden(list, bar, beat, root, sixteenth, flavor.rage);
    else if (flavor.boss === "maw") composeMaw(list, beat, root, sixteenth);
  }
  return list;
}

// Half-time theme on the same clock: two bars per chord, no drums.
function composeMenu(list, bar, beat, sixteenth) {
  const chord = Math.floor(bar / 2) % 4,
    root = MENU_ROOTS[chord],
    upper = bar >= 8 ? 12 : 0;
  if (beat === 0 || beat === 8) list.add("bass", 0.075, sixteenth * 5, root + (beat === 8 ? 7 : 0));
  if (beat % 4 === 0) {
    const melody = MENU_HOOKS[bar % 4][beat / 4];
    if (melody !== null) list.add("pluck", 0.065, sixteenth * (beat === 8 ? 5.5 : 3), root + melody + upper);
  }
  if (beat === 0 && bar % 2 === 0) {
    list.add("organ", 0.028, sixteenth * 24, root + 12);
    list.add("organ", 0.028, sixteenth * 24, root + (chord === 3 ? 4 : 3) + 12);
    list.add("organ", 0.028, sixteenth * 24, root + 19);
  }
  if (beat === 0 && bar % 4 === 0) list.add("choir", 0.026, sixteenth * 30, root + 24);
  if (beat === 14 && bar % 2 === 1) list.add("bell", 0.042, 1.6, root + 31);
}

// Rift Warden: a bar-long pedal drone and a tritone toll; once enraged, a semitone-rub
// ostinato drives every off-16th.
function composeWarden(list, bar, beat, root, sixteenth, rage) {
  if (beat === 0) list.add("drone", 0.1, sixteenth * 16, root + 12);
  if (beat === 8 && bar % 2 === 0) list.add("bell", 0.075, 1.5, root + 30);
  if (rage && beat % 2 === 1) list.add("pulse", beat % 4 === 3 ? 0.055 : 0.04, sixteenth * 0.55, root + 24 + (beat % 4 === 3 ? 1 : 0));
}

// Iron Maw: the quarry's machinery, anvil clangs and a grinding low pulse.
function composeMaw(list, beat, root, sixteenth) {
  if (beat === 6 || beat === 14) list.add("anvil", beat === 14 ? 0.16 : 0.12, 0.22, root + 31);
  if (beat === 3 || beat === 11) list.add("pulse", 0.05, sixteenth * 0.8, root + 12);
}

// Instrument layers. ratio = frequency multiple, length = fraction of the note duration.
const layer = (ratio, wave, gain, { length = 1, filter = 0, echo = false, attack = 0.005, pan = 0 } = {}) =>
  Object.freeze({ ratio, wave, gain, length, filter, echo, attack, pan, end: 0 });

const INSTRUMENTS = Object.freeze({
  bass: [layer(1, "sawtooth", 1, { filter: 1500 }), layer(0.5, "sine", 0.4)],
  deathBass: [layer(1, "sawtooth", 1, { filter: 2200 }), layer(0.5, "sine", 0.4)],
  organ: [layer(1, "triangle", 1, { attack: 0.035, pan: -0.3 }), layer(2, "sine", 0.3, { attack: 0.045, pan: 0.3 })],
  bell: [layer(1, "sine", 1, { echo: true, pan: 0.35 }), layer(2.76, "sine", 0.2, { length: 0.35, echo: true, pan: -0.35 })],
  choir: [
    layer(0.998, "triangle", 0.72, { filter: 1250, attack: 0.13, pan: -0.4 }),
    layer(1.002, "sawtooth", 0.2, { filter: 850, attack: 0.17, echo: true, pan: 0.4 }),
  ],
  pluck: [layer(1, "triangle", 1, { filter: 2800, echo: true, pan: -0.22 }), layer(2, "sine", 0.22, { length: 0.4, pan: 0.22 })],
  drone: [
    layer(1, "sawtooth", 0.6, { filter: 620, attack: 0.25, pan: -0.2 }),
    layer(1.4983, "sawtooth", 0.35, { filter: 480, attack: 0.3, pan: 0.2 }), // a slightly flat fifth
  ],
  pulse: [layer(1, "square", 1, { filter: 1400, echo: true })],
  anvil: [layer(1, "triangle", 1, { pan: 0.15 }), layer(2.76, "sine", 0.5, { length: 0.4, echo: true, pan: -0.15 })],
});

// Lead timbre per stage (index 0/1 = the original detuned saw + square pair).
const ORIGINAL_LEAD = [
  layer(1, "sawtooth", 0.68, { filter: 3200, echo: true, pan: -0.17 }),
  layer(1.004, "square", 0.22, { filter: 2400, echo: true, pan: 0.17 }),
];
const LEADS = Object.freeze([
  ORIGINAL_LEAD,
  ORIGINAL_LEAD,
  // Quarry: hollow square with an octave shadow.
  [layer(1, "square", 0.5, { filter: 2200, echo: true, pan: -0.17 }), layer(2, "triangle", 0.18, { length: 0.6, pan: 0.17 })],
  // Caldera: smouldering, thick detuned saws.
  [
    layer(1, "sawtooth", 0.6, { filter: 1800, echo: true, pan: -0.2 }),
    layer(0.994, "sawtooth", 0.3, { filter: 1600, echo: true, pan: 0.2 }),
  ],
  // Citadel: a metal bell lead with an inharmonic partial.
  [
    layer(1, "sine", 0.6, { echo: true, pan: -0.15 }),
    layer(2.76, "sine", 0.16, { length: 0.5, echo: true, pan: 0.15 }),
    layer(1, "triangle", 0.2, { filter: 3000 }),
  ],
  // Void: a detuned synthetic choir.
  [
    layer(0.994, "triangle", 0.62, { filter: 1400, attack: 0.03, echo: true, pan: -0.3 }),
    layer(1.006, "sawtooth", 0.2, { filter: 900, attack: 0.05, echo: true, pan: 0.3 }),
  ],
]);

const KICK_BODY = Object.freeze({ wave: "sine", filter: 0, echo: false, attack: 0.005, pan: 0, end: 38 });
const SNARE_BODY = Object.freeze({ wave: "triangle", filter: 0, echo: false, attack: 0.005, pan: 0, end: 95 });

// Holds a param at its current value from time t, so a following ramp starts there.
export function holdParam(param, t) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else {
    const value = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(value, t);
  }
}

// The echo send for shade cues: connect a voice to the returned node and its repeats (every
// 0.15 s, 0.3 feedback) reach `output`; the dry signal is the caller's own connection.
export function createShadeEcho(ac, output) {
  const input = ac.createGain();
  const delay = ac.createDelay(0.5);
  const feedback = ac.createGain();
  const wet = ac.createGain();
  delay.delayTime.value = SHADE_ECHO_TIME;
  feedback.gain.value = SHADE_ECHO_FEEDBACK;
  wet.gain.value = SHADE_ECHO_WET;
  input.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(wet);
  wet.connect(output);
  return input;
}

// Instruments for one AudioContext: voices -> compressor -> fade -> underwater low-pass -> bus,
// with a feedback echo send returning into the compressor. While mono() is true every voice
// plays centred.
export function createMusicPlayer(ac, output, mono = () => false) {
  const voices = new Set();
  const events = createEventList();
  const compressor = ac.createDynamicsCompressor();
  compressor.threshold.value = -15;
  compressor.knee.value = 15;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.18;
  const fade = ac.createGain(),
    lowpass = ac.createBiquadFilter(),
    open = Math.min(OPEN_FILTER, ac.sampleRate * 0.45); // stay inside the param's range
  lowpass.type = "lowpass";
  lowpass.frequency.value = open;
  lowpass.Q.value = 0.9;
  compressor.connect(fade);
  fade.connect(lowpass);
  lowpass.connect(output);
  const delay = ac.createDelay(0.5),
    feedback = ac.createGain(),
    wet = ac.createGain();
  delay.delayTime.value = ECHO_TIME;
  feedback.gain.value = ECHO_FEEDBACK;
  wet.gain.value = ECHO_WET;
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(wet);
  wet.connect(compressor);
  const noise = drumNoise(ac);
  let readyAt = 0,
    underwater = false,
    drone = null; // { osc, gain } while the Unmade drone sounds

  function envelope(time, duration, volume, attack) {
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(volume, time + Math.min(attack, duration / 3));
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    return gain;
  }

  function track(source, nodes, startAt, stopAt) {
    voices.add(source);
    source.onended = () => {
      voices.delete(source);
      for (const node of nodes) node.disconnect();
    };
    source.start(startAt);
    source.stop(stopAt);
  }

  // Every filtered note closes like a pluck: cutoff falls to 23% over the note.
  function oscillator(frequency, time, duration, volume, spec) {
    if (voices.size >= VOICE_CAP || !(volume > 0)) return;
    const osc = ac.createOscillator(),
      gain = envelope(time, duration, volume, spec.attack),
      nodes = [osc, gain];
    osc.type = spec.wave;
    osc.frequency.setValueAtTime(frequency, time);
    if (spec.end) osc.frequency.exponentialRampToValueAtTime(spec.end, time + duration);
    if (spec.filter) {
      const filter = ac.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.65;
      filter.frequency.setValueAtTime(spec.filter, time);
      filter.frequency.exponentialRampToValueAtTime(Math.max(180, spec.filter * 0.23), time + duration);
      osc.connect(filter);
      filter.connect(gain);
      nodes.push(filter);
    } else osc.connect(gain);
    const stereo = mono() ? null : ac.createStereoPanner?.();
    if (stereo) {
      stereo.pan.value = spec.pan;
      gain.connect(stereo);
      nodes.push(stereo);
    }
    const out = stereo || gain;
    out.connect(compressor);
    if (spec.echo) out.connect(delay);
    track(osc, nodes, time, time + duration + 0.015);
  }

  function percussion(time, duration, volume, frequency, type) {
    if (voices.size >= VOICE_CAP) return;
    const source = ac.createBufferSource(),
      filter = ac.createBiquadFilter(),
      gain = envelope(time, duration, volume, 0.002);
    source.buffer = noise;
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = 0.65;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(compressor);
    track(source, [source, filter, gain], time, time + duration + 0.01);
  }

  function play(layers, f, time, d, g) {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      oscillator(f * l.ratio, time, d * l.length, g * l.gain, l);
    }
  }

  return {
    get readyAt() {
      return readyAt;
    },
    schedule(step, time, death, volume = 1, activity = "normal", flavor = NO_FLAVOR) {
      if (volume <= 0) return;
      scoreEvents(step, death, activity, flavor, events);
      for (let i = 0; i < events.length; i++) {
        const { voice, gain, duration: d, frequency: f } = events.items[i];
        const g = gain * volume;
        switch (voice) {
          case "bass":
            play(death ? INSTRUMENTS.deathBass : INSTRUMENTS.bass, f, time, d, g);
            break;
          case "lead":
            play(LEADS[flavor.stage] || ORIGINAL_LEAD, f, time, d, g);
            break;
          case "kick":
            oscillator(145, time, d, g, KICK_BODY);
            percussion(time, 0.015, g * 0.1, 3000, "lowpass");
            break;
          case "snare":
            percussion(time, d, g, 1800, "bandpass");
            oscillator(190, time, 0.085, g * 0.35, SNARE_BODY);
            break;
          case "hat":
            percussion(time, d, g, 6500, "highpass");
            break;
          case "anvil":
            percussion(time, 0.05, g * 0.5, 2400, "bandpass");
            play(INSTRUMENTS.anvil, f, time, d, g);
            break;
          default:
            if (INSTRUMENTS[voice]) play(INSTRUMENTS[voice], f, time, d, g);
        }
      }
    },
    // Fades everything out over `fadeTime`, kills the echo tail, and reports when the
    // output is open again (callers schedule new notes from then on).
    stop(fadeTime = FADE) {
      const t = ac.currentTime,
        end = t + fadeTime;
      if (voices.size === 0) {
        readyAt = Math.max(readyAt, t); // nothing sounding: no fade window needed
        return readyAt;
      }
      holdParam(fade.gain, t);
      fade.gain.linearRampToValueAtTime(0, end);
      for (const voice of voices) {
        try {
          voice.stop(end);
        } catch {
          // Already stopped: its onended cleanup is on the way.
        }
      }
      feedback.gain.cancelScheduledValues(t);
      feedback.gain.setValueAtTime(0, t);
      readyAt = end + ECHO_TIME + 0.012; // the delay line has drained by then
      fade.gain.setValueAtTime(1, readyAt);
      feedback.gain.setValueAtTime(ECHO_FEEDBACK, readyAt);
      return readyAt;
    },
    setUnderwater(on) {
      if (on === underwater) return;
      underwater = on;
      lowpass.frequency.setTargetAtTime(on ? UNDERWATER_FILTER : open, ac.currentTime, on ? 0.09 : 0.06);
    },
    // The sustained Unmade drone, faded in and out; it rides the music chain (duck, fades).
    setDrone(on) {
      if (on === !!drone) return;
      const t = ac.currentTime;
      if (on) {
        const osc = ac.createOscillator(),
          filter = ac.createBiquadFilter(),
          gain = ac.createGain();
        osc.type = "sawtooth";
        osc.frequency.value = DRONE_HZ;
        filter.type = "lowpass";
        filter.frequency.value = DRONE_FILTER;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(DRONE_GAIN, t + DRONE_FADE);
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(compressor);
        osc.onended = () => {
          osc.disconnect();
          filter.disconnect();
          gain.disconnect();
        };
        osc.start(t);
        drone = { osc, gain };
        return;
      }
      holdParam(drone.gain.gain, t);
      drone.gain.gain.linearRampToValueAtTime(0, t + DRONE_FADE);
      drone.osc.stop(t + DRONE_FADE + 0.02);
      drone = null;
    },
  };
}

// Deterministic drum noise (LCG seed 9127) so every hit of a drum is identical.
function drumNoise(ac) {
  const buffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate),
    data = buffer.getChannelData(0);
  let seed = 9127;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    data[i] = seed / 2147483648;
  }
  return buffer;
}

// The live boss or keeper (bosses.current(), F1.3), or null.
function liveBoss(game) {
  const boss = game.bosses?.current?.();
  return boss && !boss.dead && boss.hp > 0 ? boss : null;
}

// The arrangement the game state asks for right now. A transition (F20) keeps the arrangement
// of the run it covers.
export function musicTarget(game) {
  const run = game.run,
    mode = game.mode;
  if (run?.demo || run?.over || mode === "menu" || mode === "dead") return "menu";
  if (game.cinematic) return BOSS_SEQUENCES.has(game.cinematic.kind) ? "boss" : "quiet";
  if ((mode !== "play" && mode !== "transition") || game.overlay) return "quiet";
  if (run?.bossSpawned || run?.quarryState === "active" || liveBoss(game)) return "boss";
  if (run?.trial?.state === "active") return "trial";
  return "normal";
}

// Phase 3 of the Warden (F6): the unmade flag holds and the Warden still lives.
export function unmadeDrone(game) {
  const run = game.run;
  if (!run?.flags?.unmade || run.over || run.victory) return false;
  const boss = liveBoss(game);
  return !!boss && (boss.boss === "warden" || boss.kind === "warden");
}

const duckFor = (target) => (target === "quiet" ? 0.35 : target === "menu" ? 0.65 : 1);

// Arrangement latch: changes (and the stage/boss flavour) land only on a bar line, so
// the melody never jumps mid-phrase. The transport itself is never reset here.
export class MusicIntensity {
  constructor() {
    this.flavor = { stage: 0, boss: null, rage: false };
    this.reset();
  }
  reset() {
    this.current = "normal";
  }
  at(step, target, flavor) {
    if (step % 16 === 0) {
      this.current = ACTIVITIES.has(target) ? target : "normal";
      if (flavor) {
        this.flavor.stage = flavor.stage;
        this.flavor.boss = flavor.boss;
        this.flavor.rage = flavor.rage;
      }
    }
    return this.current;
  }
}

// The music transport. audio.js owns the AudioContext and calls tick() every 40 ms of
// wall-clock time, so music keeps playing through pause, menus and cinematics.
export function createSoundtrack(game) {
  const intensity = new MusicIntensity();
  const wanted = { stage: 0, boss: null, rage: false };
  let ac = null,
    bus = null,
    player = null,
    step = 0,
    next = 0,
    silenced = false,
    rage = false;

  // The Warden's enrage (and the Crown Unmade) escalates its layer until the fight (or run) ends.
  game.bus?.on?.("boss", (p) => {
    if (p?.kind !== "warden") return;
    if (p.event === "phase" || p.event === "unmade") rage = true;
    else if (p.event === "spawn" || p.event === "defeat") rage = false;
  });

  function readFlavor() {
    const run = game.run,
      inRun = !!run && !run.demo,
      kind = game.cinematic?.kind;
    if (kind === "phase" || kind === "unmade") rage = true;
    else if (!run?.bossSpawned && run?.keeper?.id !== "warden") rage = false;
    wanted.stage = inRun ? Math.min(5, Math.max(1, run.stage | 0)) : 0;
    // The Maw's machinery and the Warden's drone are their own layers; the other keepers play
    // the plain boss arrangement.
    const keeper = run?.keeper?.id ?? (run?.quarryState === "active" ? "ironmaw" : null);
    wanted.boss =
      kind === "maw"
        ? "maw"
        : kind === "warden" || kind === "phase" || kind === "unmade" || run?.bossSpawned || keeper === "warden"
          ? "warden"
          : keeper === "ironmaw"
            ? "maw"
            : null;
    wanted.rage = rage;
    return inRun;
  }

  return {
    connect(context, musicBus) {
      ac = context;
      bus = musicBus;
      player = createMusicPlayer(ac, bus, () => game.prefs?.mono === true);
      next = ac.currentTime + START_OFFSET;
      silenced = false;
    },
    disconnect() {
      ac = bus = player = null;
    },
    // New run: fade out, restart the score from bar 0 in the "normal" arrangement.
    reset() {
      intensity.reset();
      step = 0;
      if (!player) return;
      const ready = player.stop();
      next = Math.max(ac.currentTime + START_OFFSET, ready);
    },
    realign() {
      if (ac) next = ac.currentTime + START_OFFSET;
    },
    // One scheduler pass. `level` = prefs.music / 100.
    tick(audible, level) {
      if (!player) return;
      const now = ac.currentTime;
      if (!audible) {
        // Transport freezes; resumes from the same step when audio comes back.
        next = now + START_OFFSET;
        if (!silenced) player.stop();
        player.setDrone(false);
        silenced = true;
        return;
      }
      silenced = false;
      player.setDrone(unmadeDrone(game));
      next = Math.max(next, now, player.readyAt); // after a stall, skip ahead instead of bursting
      const target = musicTarget(game);
      bus.gain.setTargetAtTime(level * duckFor(target), now, DUCK_TAU);
      player.setUnderwater(target === "quiet" && !game.cinematic);
      const inRun = readFlavor(),
        death = inRun ? !!game.run.death : !!game.menuDeath,
        bpm = (inRun && game.run.tuning?.bpm) || tempoOf(death),
        sixteenth = 60 / bpm / 4;
      while (next < now + LOOKAHEAD) {
        const activity = intensity.at(step, target, wanted);
        player.schedule(step, next, death, SCORE_VOLUME, activity, intensity.flavor);
        step++;
        next += sixteenth;
      }
    },
  };
}
