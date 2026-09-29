// Web Audio engine: context lifecycle, master/music/effects buses, the SFX dispatcher
// (cooldowns, voice caps and priority stealing, pan and distance by screen direction),
// thunder, player and creature foley, stage ambience, and the 40 ms scheduler that
// drives the soundtrack. Every sound is synthesized. Every entry point is safe to call
// with no context, a suspended one, or audio blocked by the browser: it never throws.
//
// Wave 2 (IMPROVEMENTS F17, F18, §3.12): every requested sound is announced on bus "sound"
// { name, x, z, src } before any mute or cooldown gate, so captions work with audio off;
// fx() takes { x, z, rate, src, reverse, shade }; mono audio centres every pan and downmixes
// the master; shade cues play quieter through a short echo send; and the Wave-2 bus events
// (relics, guard hits, elites, props, the Rift Chain, feats, heals, codex, unlocks, vigils)
// play their recipes here.
import { clamp, smoothstep } from "../core/util.js";
import {
  SOUNDS,
  PRIORITY,
  CHAIN_ROOTS,
  gapOf,
  priorityOf,
  isInterface,
  ENEMY_VOICES,
  VOICE_RATES,
  STEP_SOUNDS,
  AMBIENT_SOUNDS,
  AMBIENT_EXTRAS,
  AMBIENCE_BEDS,
  VARIANTS,
  WEAPON_RACKS,
  CASINGS,
  ROOMS,
} from "./sfx.js";
import { installUiSounds } from "./ui-sounds.js";
import { createSoundtrack, createShadeEcho, holdParam } from "./music.js";
import { KEEPERS } from "../data/keepers.js";

const HEADROOM = 0.22; // master gain ceiling at 100%
const DEFAULT_LEVELS = Object.freeze({ master: 100, music: 70, effects: 100 });
const LEVEL_SMOOTH = 0.012; // volume changes glide instead of zipper-clicking
const SCHEDULER_MS = 40;

// SFX voice pool: above the soft cap only `event` priority and higher may start; at the
// hard cap a new sound steals the oldest voice of a strictly lower priority.
const SOFT_CAP = 24;
const HARD_CAP = 32;
const ATTACK = 0.005;
const STEAL_FADE = 0.012;
const PITCH_VARIATION = 0.04;
const GAIN_VARIATION = 0.04;
const STINGER_COVER = 0.35; // a `level` arpeggio this soon after a stinger is redundant
const UI_QUEUE_LIFE = 500; // ms a UI sound may wait for the unlocking resume()

// Screen-direction pan and a gentle distance duck for positioned effects.
const DEFAULT_YAW = 0.35;
const PAN_SPAN = 16; // metres of screen-lateral offset for a full-width pan
const PAN_WIDTH = 0.75;
const DUCK_NEAR = 6;
const DUCK_FAR = 40;
const DUCK_DEPTH = 0.55;

// Foley (simulation-time clocks: they freeze with pause).
const STRIDE = 1.7; // metres walked per footstep
const TELEPORT = 1; // metres in one step: a stage placement, not a stride
const STEP_DETUNE = 0.02; // left/right feet differ slightly in pitch and side
const STEP_PAN = 0.08;
const HEART_THRESHOLD = 0.25;
const HEART_SLOW = 1.8;
const HEART_FAST = 0.8;
const VOICE_INTERVAL = 5.5;
const VOICE_FIRST = 3;
const VOICE_NEARBY = 19;
const VOICE_RANGE = 28;
const VOICE_FALLOFF = 32;
const VOICE_FLOOR = 0.12;
const AMBIENT_FIRST = 2;
const EXTRA_FIRST = 6;
const AMBIENT_PAN = 0.45;

// Ambience beds and thunder.
const BED_MODES = new Set(["play", "sequence"]);
const BED_FADE_IN = 1.6;
const BED_FADE_OUT = 0.6;
const BED_NOISE_SECONDS = 3;
const THUNDER_PAN = 0.7;
const TEST_TONES = [440, 554, 660];

// Wave-2 cues.
const SHADE_GAIN = 0.7; // the Warden's shades replay their keeper's cue quieter, with an echo
const NOISE_SECONDS = 1; // one shared white-noise buffer for every noise layer
// Sound pass: PS1-style grit and room, plus the new world foley.
const NOISE_HOLD = 3; // noise layers sample-and-hold every 3rd sample (~14.7 kHz at 44.1)
const SPU_CUTOFF = 11000; // the effects bus is band-limited like the console's SPU
const ROOM_SLEW = 0.3;
const GEM_WINDOW = 0.6; // s between gems that keeps the chime climbing
const GEM_STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24]; // a pentatonic climb, in semitones
const WHIZ_RADIUS = 1.8;
const EMERGE_RANGE = 26;
const PORTAL_RANGE = 18;
const PORTAL_EVERY = 1.1;
const NEAR_RANGE = 10; // lava pools and live hazard props
const RICOCHET_CHANCE = 0.35;
const QUIET = Object.freeze({ quiet: true }); // decorative layers: no caption event
const CHAIN_BREAK_MIN = 10; // breaks of shorter chains stay silent (the HUD shows none either)
const GUARD_FRONT = 0.6; // a shield front hit that is not a full block plays its cue quieter
// The front of a guard answers in its material: the Castellan's steel Aegis, else stone crust.
const GUARD_SOUNDS = Object.freeze({ castellan: "aegisBlock" });
// Hazard props: which prop event sounds which recipe (F10).
const PROP_CUES = Object.freeze({
  fuse: Object.freeze({ charge: "fuse", crystal: "crystalFall" }),
  blast: Object.freeze({ marsh: "gasPop", beacon: "beaconFlare" }),
});

const GESTURES = ["pointerdown", "pointerup", "keydown", "touchend"];

const STATUS = Object.freeze({
  resume: "Press Test sound to enable audio.",
  failed: "Audio could not start. Press Test sound to retry.",
  raise: "Unmute and raise Master and Effects to test.",
  testing: "Playing test tones.",
  blocked: "Audio is blocked by this browser.",
});

const NO_OPTIONS = Object.freeze({});
const PLAIN_TONE = Object.freeze({ crush: 0, tremolo: null }); // test tones and thunder: no effects
const KEEPER_OF_DEF = new Map(Object.entries(KEEPERS).map(([id, def]) => [def, id]));
const crushCurves = new Map(); // bits -> WaveShaper curve (plain arrays outlive any context)

const vary = (amount) => 1 + (Math.random() * 2 - 1) * amount;
const hidden = () => typeof document !== "undefined" && document.hidden === true;
const userActivated = () => (typeof navigator === "undefined" ? true : navigator.userActivation?.hasBeenActive ?? true);
// Esc, modifiers and the like are not activating: creating a context then only warns.
const activeGesture = () => (typeof navigator === "undefined" ? true : navigator.userActivation?.isActive ?? true);
const stageIndex = (run) => clamp((run.stage | 0) - 1, 0, STEP_SOUNDS.length - 1);
// Voice key of an enemy or a shade actor: its keeper id, else the Wave-1 boss or its kind.
const voiceKind = (e) =>
  e.keeper || KEEPER_OF_DEF.get(e.def) || (e.miniboss || e.boss === "ironmaw" ? "ironmaw" : e.boss === "warden" ? "warden" : e.kind);
// A position argument that is an enemy (Wave-1 call sites) carries no sound options.
const isActor = (pos) => "hp" in pos || "def" in pos;

// A stepped transfer curve: the signal passes through 2^bits levels.
function crushCurve(bits) {
  let curve = crushCurves.get(bits);
  if (!curve) {
    const half = 2 ** bits / 2;
    curve = new Float32Array(1025);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.round(((i / 512) - 1) * half) / half;
    crushCurves.set(bits, curve);
  }
  return curve;
}

export function createAudio(ctx) {
  let ac = null,
    master = null,
    musicBus = null,
    sfxBus = null,
    shadeEcho = null,
    timer = null,
    resuming = false,
    status = "",
    thunderNoise = null,
    bedNoise = null,
    layerNoise = null,
    bed = null,
    levelQueued = false,
    stingerAt = -Infinity,
    warnings = 8,
    spu = null,
    room = null,
    roomStage = -1,
    uiCues = 0,
    uiAt = -Infinity,
    gemAt = -Infinity,
    gemStep = 0;
  const live = []; // allocated SFX voices, oldest first
  const lastPlayed = new Map(); // effect name -> context time it last started
  const lastAnnounced = new Map(); // effect name -> real time of its last "sound" event
  const pendingUi = [];
  const spot = { gain: 1, pan: 0 }; // scratch result of locate()
  const fxOpts = { x: 0, z: 0, src: undefined, rate: 1, reverse: false, echo: false }; // scratch play() options of fx()
  // Simulation-time foley state: stride distance, clocks, last player sample, next foot.
  const foley = {
    distance: 0,
    heart: 0,
    voice: VOICE_FIRST,
    ambient: AMBIENT_FIRST,
    extra: EXTRA_FIRST,
    x: 0,
    z: 0,
    tracked: false,
    dashing: false,
    wasDashing: false,
    left: false,
    primed: false,
    portal: 0,
    near: 1,
  };
  const seen = new WeakSet(); // enemies already heard emerging (audio-only bookkeeping)
  const whizzed = new WeakSet(); // enemy shots already heard passing
  const soundtrack = createSoundtrack(ctx);

  // --- preferences ------------------------------------------------------------------
  const prefs = () => ctx.prefs || {};
  const muted = () => prefs().muted === true || prefs().mute === true;
  const mono = () => prefs().mono === true;
  function level(key) {
    const v = Number(prefs()[key]);
    return Number.isFinite(v) ? clamp(v, 0, 100) : DEFAULT_LEVELS[key];
  }
  const running = () => ac?.state === "running";
  const inDemo = () => !!ctx.run?.demo;
  const silent = () => muted() || level("master") === 0 || (level("music") === 0 && level("effects") === 0);
  const musicAudible = () => running() && !hidden() && !muted() && level("master") > 0 && level("music") > 0;
  // Mono audio (F18.6): every panner sits at the centre.
  const panOf = (pan) => (mono() ? 0 : pan);

  function warn(where, err) {
    if (warnings-- > 0) console.warn(`[audio] ${where} failed`, err);
  }
  const safely = (where, fn) => (arg) => {
    try {
      fn(arg);
    } catch (err) {
      warn(where, err);
    }
  };

  function setStatus(text) {
    status = text;
    const el = typeof document !== "undefined" ? document.getElementById("audioStatus") : null;
    if (el) el.textContent = text;
  }

  // --- captions ---------------------------------------------------------------------
  // Every requested sound is announced before the mute, level and cooldown gates, so deaf and
  // hard-of-hearing players can mute and still read captions (F17). The HUD captions the names
  // in its CAPTIONS table; repeats inside a sound's own gap are one event, muted or not.
  function announce(name, x, z, src) {
    if (inDemo()) return;
    const now = ctx.time?.real ?? 0;
    const last = lastAnnounced.get(name);
    if (last !== undefined && now - last < gapOf(name)) return;
    lastAnnounced.set(name, now);
    ctx.bus?.emit?.("sound", { name, x, z, src });
  }

  // --- context lifecycle ------------------------------------------------------------
  function unlock() {
    try {
      if (!ac || ac.state === "closed") createContext();
      resume();
    } catch (err) {
      console.warn("Audio startup failed", err);
      teardown();
      setStatus(STATUS.failed);
    }
  }

  function createContext() {
    const Context = window.AudioContext || window.webkitAudioContext;
    ac = new Context();
    master = ac.createGain();
    musicBus = ac.createGain();
    sfxBus = ac.createGain();
    master.connect(ac.destination);
    musicBus.connect(master);
    spu = ac.createBiquadFilter();
    spu.type = "lowpass";
    spu.frequency.value = SPU_CUTOFF;
    sfxBus.connect(spu);
    spu.connect(master);
    shadeEcho = createShadeEcho(ac, sfxBus);
    room = createRoom();
    roomStage = -1;
    // A new context's clock restarts at 0: stale cooldowns would block every sound.
    live.length = 0;
    lastPlayed.clear();
    bed = null;
    soundtrack.connect(ac, musicBus);
    apply(true);
    ac.onstatechange = safely("statechange", () => {
      if (running()) soundtrack.realign();
    });
    if (timer === null) tick();
  }

  function resume() {
    const pending = ac.resume?.();
    if (!pending) return;
    resuming = true;
    pending.then(
      safely("resume", () => {
        resuming = false;
        flushUi();
      }),
      safely("resume", () => {
        resuming = false;
        pendingUi.length = 0;
        setStatus(STATUS.resume);
      }),
    );
  }

  function teardown() {
    try {
      ac?.close?.()?.catch?.(() => {});
    } catch {
      // Closing a half-built context can throw; it is being discarded either way.
    }
    ac = master = musicBus = sfxBus = shadeEcho = spu = room = null;
    live.length = 0;
    bed = null;
    soundtrack.disconnect();
  }

  function apply(immediate = false) {
    if (!master) return;
    const t = ac.currentTime;
    setLevel(master.gain, muted() ? 0 : (HEADROOM * level("master")) / 100, t, immediate);
    setLevel(musicBus.gain, level("music") / 100, t, immediate); // the scheduler adds its duck
    setLevel(sfxBus.gain, level("effects") / 100, t, immediate);
    // Mono downmixes everything at the master; panners are also centred at the source.
    master.channelCount = mono() ? 1 : 2;
    master.channelCountMode = mono() ? "explicit" : "max";
  }

  function setLevel(param, value, t, immediate) {
    param.cancelScheduledValues(t);
    if (immediate) param.setValueAtTime(value, t);
    else param.setTargetAtTime(value, t, LEVEL_SMOOTH);
  }

  // Per-stage room: a feedback delay whose loop darkens through a lowpass. Voices of recipes
  // with `room` feed `input`; the wet return joins the effects bus.
  function createRoom() {
    const input = ac.createGain(),
      delay = ac.createDelay(1),
      tone = ac.createBiquadFilter(),
      feedback = ac.createGain(),
      wet = ac.createGain();
    delay.delayTime.value = ROOMS[0][0];
    tone.type = "lowpass";
    tone.frequency.value = ROOMS[0][3];
    feedback.gain.value = ROOMS[0][1];
    wet.gain.value = ROOMS[0][2];
    input.connect(delay);
    delay.connect(tone);
    tone.connect(feedback);
    feedback.connect(delay);
    tone.connect(wet);
    wet.connect(sfxBus);
    return { input, delay, tone, feedback, wet };
  }

  function updateRoom() {
    const stage = ctx.run ? stageIndex(ctx.run) : 0;
    if (!room || stage === roomStage) return;
    roomStage = stage;
    const [time, feedback, wet, cutoff] = ROOMS[stage] ?? ROOMS[0],
      t = ac.currentTime;
    room.delay.delayTime.setTargetAtTime(time, t, ROOM_SLEW);
    room.feedback.gain.setTargetAtTime(feedback, t, ROOM_SLEW);
    room.wet.gain.setTargetAtTime(wet, t, ROOM_SLEW);
    room.tone.frequency.setTargetAtTime(cutoff, t, ROOM_SLEW);
  }

  // Wall-clock loop: music keeps going through pause, menus and cinematics.
  function tick() {
    timer = null;
    if (!ac) return;
    try {
      soundtrack.tick(musicAudible(), level("music") / 100);
      updateBed();
      updateRoom();
    } catch (err) {
      warn("scheduler", err);
    }
    timer = setTimeout(tick, SCHEDULER_MS);
  }

  // --- SFX voices -------------------------------------------------------------------
  // Output stage shared by tones and noise layers: optional crush, tremolo and panner, then
  // the effects bus (and the shade echo). Returns the extra nodes and LFO to track.
  function route(amp, gain, time, duration, sound, pan, echo, nodes) {
    let out = amp;
    if (sound.crush) {
      const shaper = ac.createWaveShaper();
      shaper.curve = crushCurve(sound.crush);
      const post = ac.createGain();
      post.gain.value = gain;
      out.connect(shaper);
      shaper.connect(post);
      out = post;
      nodes.push(shaper, post);
    }
    let lfo = null;
    if (sound.tremolo) {
      const trem = ac.createGain();
      const depth = ac.createGain();
      lfo = ac.createOscillator();
      trem.gain.value = 1 - sound.tremolo.depth / 2;
      depth.gain.value = sound.tremolo.depth / 2;
      lfo.frequency.value = sound.tremolo.rate;
      lfo.connect(depth);
      depth.connect(trem.gain);
      out.connect(trem);
      out = trem;
      nodes.push(trem, depth, lfo);
      lfo.start(time);
      lfo.stop(time + duration);
    }
    const panner = pan && ac.createStereoPanner ? ac.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = clamp(pan, -1, 1);
      out.connect(panner);
      out = panner;
      nodes.push(panner);
    }
    out.connect(sfxBus);
    if (echo && shadeEcho) out.connect(shadeEcho);
    if (sound.room && room) out.connect(room.input);
    return lfo;
  }

  // Starts one voice (an oscillator or a noise source) and tracks it in the pool.
  function track(source, amp, lfo, nodes, priority, time, duration) {
    const voice = { source, amp, lfo, nodes, priority, live: true };
    live.push(voice);
    source.onended = () => release(voice);
    source.start(time);
    source.stop(time + duration);
  }

  function envelope(time, duration, peak) {
    const amp = ac.createGain();
    amp.gain.setValueAtTime(0.0001, time);
    amp.gain.linearRampToValueAtTime(peak, time + ATTACK);
    amp.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    return amp;
  }

  function tone(f, time, duration, wave, gain, end, priority, pan, sound = PLAIN_TONE, echo = false) {
    if (!ac || !(gain > 0) || !(f > 0)) return;
    if (live.length >= HARD_CAP && !steal(priority)) return;
    const osc = ac.createOscillator();
    // A crushed tone's envelope runs at full scale so the crush steps it; its level follows.
    const amp = envelope(time, duration, sound.crush ? 1 : gain);
    osc.type = wave;
    osc.frequency.setValueAtTime(f, time);
    if (end > 0) osc.frequency.exponentialRampToValueAtTime(end, time + duration);
    osc.connect(amp);
    const nodes = [osc, amp];
    const lfo = route(amp, gain, time, duration, sound, panOf(pan), echo, nodes);
    track(osc, amp, lfo, nodes, priority, time, duration);
  }

  // A filtered white-noise layer: [filter type, startHz, seconds, gain, endHz, delay]. The
  // filter sweep follows pitch and rate; the length follows rate only.
  function noise(layer, time, scale, pitch, rate, reverse, sound, pan, echo) {
    const [type, startHz, seconds, rawGain, endHz] = layer;
    const gain = rawGain * scale;
    if (!ac || !(gain > 0)) return;
    if (live.length >= HARD_CAP && !steal(sound.priority)) return;
    const duration = seconds / rate;
    layerNoise ??= noiseBuffer(NOISE_SECONDS, NOISE_HOLD);
    const source = ac.createBufferSource();
    const filter = ac.createBiquadFilter();
    const amp = envelope(time, duration, sound.crush ? 1 : gain);
    const from = (reverse && endHz > 0 ? endHz : startHz) * pitch * rate;
    const to = (reverse && endHz > 0 ? startHz : endHz) * pitch * rate;
    source.buffer = layerNoise;
    source.loop = true;
    filter.type = type;
    filter.frequency.setValueAtTime(from, time);
    if (to > 0) filter.frequency.exponentialRampToValueAtTime(to, time + duration);
    source.connect(filter);
    filter.connect(amp);
    const nodes = [source, filter, amp];
    const lfo = route(amp, gain, time, duration, sound, panOf(pan), echo, nodes);
    track(source, amp, lfo, nodes, sound.priority, time, duration);
  }

  function release(voice) {
    if (voice.live) {
      voice.live = false;
      const i = live.indexOf(voice);
      if (i >= 0) live.splice(i, 1);
    }
    for (const node of voice.nodes) node.disconnect();
  }

  // Oldest voice of the lowest priority below `priority` gives way with a short fade.
  function steal(priority) {
    let victim = -1;
    for (let i = 0; i < live.length; i++) {
      const p = live[i].priority;
      if (p < priority && (victim < 0 || p < live[victim].priority)) victim = i;
    }
    if (victim < 0) return false;
    const voice = live[victim];
    live.splice(victim, 1);
    voice.live = false;
    const t = ac.currentTime;
    holdParam(voice.amp.gain, t);
    voice.amp.gain.linearRampToValueAtTime(0, t + STEAL_FADE);
    try {
      voice.source.stop(t + STEAL_FADE + 0.005);
      voice.lfo?.stop(t + STEAL_FADE + 0.005);
    } catch {
      // Already stopping on its own.
    }
    return true;
  }

  // rate: playback rate (pitch and length together); reverse: glides run backwards.
  function scheduleTones(tones, now, scale, pitch, rate, reverse, sound, pan, echo) {
    for (let i = 0; i < tones.length; i++) {
      const t = tones[i];
      const start = reverse && t[4] > 0 ? t[4] : t[0];
      const end = reverse && t[4] > 0 ? t[0] : t[4];
      tone(start * pitch * rate, now + t[5] / rate, t[1] / rate, t[2], t[3] * scale, end * pitch * rate, sound.priority, pan, sound, echo);
    }
  }

  // One call = one random detune/gain for every tone, so layers keep their intervals.
  function render(sound, now, volume, pan, pitch, rate, reverse, echo) {
    const p = sound.steady ? pitch : pitch * vary(PITCH_VARIATION),
      g = sound.steady ? 1 : vary(GAIN_VARIATION);
    scheduleTones(sound.tones, now, volume * g, p, rate, reverse, sound, pan, echo);
    scheduleTones(sound.fixed, now, g, p, rate, reverse, sound, pan, echo);
    for (let i = 0; i < sound.noise.length; i++) {
      const layer = sound.noise[i];
      noise(layer, now + layer[5] / rate, volume * g, p, rate, reverse, sound, pan, echo);
    }
  }

  // The dispatcher. Returns true when the sound was accepted. `opts` = { x, z, src } for the
  // caption event, plus rate, reverse and echo for the recipe.
  function play(name, volume = 1, pan = 0, pitch = 1, opts = NO_OPTIONS) {
    if (typeof name !== "string" || !(volume > 0)) return false;
    // Read before announcing: a "sound" listener may play another sound through fx().
    const rate = opts.rate > 0 ? opts.rate : 1,
      reverse = opts.reverse === true,
      echo = opts.echo === true;
    if (opts.quiet !== true) announce(name, opts.x, opts.z, opts.src);
    const ui = isInterface(name);
    if (ui && priorityOf(name) >= PRIORITY.event) {
      uiCues++;
      uiAt = Date.now();
    }
    if ((inDemo() && !ui) || hidden() || !ac || muted() || level("master") === 0 || level("effects") === 0) return false;
    if (!running()) {
      // The click that unlocks audio usually opens a panel: keep its sound for the resume.
      if (ui && resuming && pendingUi.length < 3) pendingUi.push({ name, volume, at: Date.now() });
      return false;
    }
    if (priorityOf(name) < PRIORITY.event && live.length > SOFT_CAP) return false;
    const now = ac.currentTime;
    if (now - (lastPlayed.get(name) ?? -100) < gapOf(name)) return false;
    lastPlayed.set(name, now); // unknown names still consume their slot
    const sound = SOUNDS[variantOf(name)];
    if (!sound) return false;
    if (name === "gem") pitch *= gemPitch(now);
    if (name === "level") queueLevel();
    else {
      if (sound.stinger) stingerAt = now;
      render(sound, now, volume, pan, pitch, rate, reverse, echo);
    }
    return true;
  }

  // A random alternate recipe (Math.random: audio never touches the simulation streams).
  function variantOf(name) {
    const list = VARIANTS[name];
    return list ? list[Math.floor(Math.random() * list.length)] : name;
  }

  // Quick successive gems climb a pentatonic scale; a pause resets the chime.
  function gemPitch(now) {
    gemStep = now - gemAt < GEM_WINDOW ? Math.min(gemStep + 1, GEM_STEPS.length - 1) : 0;
    gemAt = now;
    return 2 ** (GEM_STEPS[gemStep] / 12);
  }

  // A decorative, uncaptioned layer at a world point (panned and distance-ducked).
  function layerAt(name, volume, x, z, pitch = 1) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return play(name, volume, 0, pitch, QUIET);
    locate(x, z);
    return play(name, volume * spot.gain, spot.pan, pitch, QUIET);
  }

  function flushUi() {
    const fresh = Date.now() - UI_QUEUE_LIFE;
    for (const item of pendingUi.splice(0)) if (item.at >= fresh) play(item.name, item.volume);
  }

  // `level` is decided after the current task: if a stinger for the same moment (portal,
  // stage, boss, level-up) fires in the same frame, the generic arpeggio stays silent.
  function queueLevel() {
    if (levelQueued) return;
    levelQueued = true;
    queueMicrotask(flushLevel);
  }
  const flushLevel = safely("level", () => {
    levelQueued = false;
    if (!running()) return;
    const now = ac.currentTime;
    if (now - stingerAt >= STINGER_COVER) render(SOUNDS.level, now, 1, 0, 1, 1, false, false);
  });

  // Screen-lateral pan and distance duck of a world point relative to the player.
  function locate(x, z) {
    spot.gain = 1;
    spot.pan = 0;
    const p = ctx.run?.player;
    if (!p) return spot;
    const dx = x - p.x,
      dz = z - p.z,
      yaw = Number.isFinite(ctx.cam?.yaw) ? ctx.cam.yaw : DEFAULT_YAW;
    // Camera-right in world space is (cos yaw, -sin yaw).
    spot.pan = clamp((dx * Math.cos(yaw) - dz * Math.sin(yaw)) / PAN_SPAN, -1, 1) * PAN_WIDTH;
    spot.gain = 1 - DUCK_DEPTH * smoothstep(DUCK_NEAR, DUCK_FAR, Math.hypot(dx, dz));
    return spot;
  }

  // fx(name, volume, pos): pos is a point { x, z } or an enemy (Wave-1 call sites), or the
  // Wave-2 options { x, z, src, rate, reverse, shade }. `src` names the emitter kind for the
  // captions (an enemy passes its keeper, boss or kind); `shade: true` (or a src starting
  // with "shade") plays a Warden shade's cue at 0.7 gain through the echo send.
  function fx(name, volume = 1, pos) {
    try {
      if (!pos || typeof pos !== "object") {
        play(name, volume);
        return;
      }
      const actor = isActor(pos);
      const shade = pos.shade === true || String(pos.src ?? "").startsWith("shade");
      fxOpts.x = pos.x;
      fxOpts.z = pos.z;
      fxOpts.src = pos.src ?? (actor ? voiceKind(pos) : undefined);
      fxOpts.rate = actor ? 1 : pos.rate;
      fxOpts.reverse = !actor && pos.reverse === true;
      fxOpts.echo = shade;
      const gain = shade ? SHADE_GAIN : 1;
      if (Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
        locate(pos.x, pos.z);
        play(name, volume * gain * spot.gain, spot.pan, 1, fxOpts);
      } else play(name, volume * gain, 0, 1, fxOpts);
    } catch (err) {
      warn("fx", err);
    }
  }

  // Enemy vocalisation: the original's attenuation curve, now panned by screen side. Keepers
  // borrow a creature voice at their own playback rate; a shade actor ({ shade: true, def })
  // speaks as its keeper, quieter and echoed.
  function voice(e, type) {
    try {
      const p = ctx.run?.player;
      if (!e || !p) return;
      const kind = voiceKind(e);
      const name = type || ENEMY_VOICES[kind];
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (!name || !(d < VOICE_RANGE)) return;
      const shade = e.shade === true;
      const gain = Math.max(VOICE_FLOOR, 1 - d / VOICE_FALLOFF) * (shade ? SHADE_GAIN : 1);
      play(name, gain, locate(e.x, e.z).pan, 1, { x: e.x, z: e.z, src: kind, rate: VOICE_RATES[kind] ?? 1, echo: shade });
    } catch (err) {
      warn("voice", err);
    }
  }

  // hold > 1 repeats each random value (a cheap sample-rate reduction for PS1 grit).
  function noiseBuffer(seconds, hold = 1) {
    const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * seconds), ac.sampleRate),
      data = buffer.getChannelData(0);
    let v = 0;
    for (let i = 0; i < data.length; i++) {
      if (i % hold === 0) v = Math.random() * 2 - 1;
      data[i] = v;
    }
    return buffer;
  }

  // Nightmare thunder: low-passed noise swell plus a sub-bass drop, panned toward the bolt.
  function thunder(at) {
    try {
      if (inDemo() || ctx.mode !== "play") return;
      const x = Number.isFinite(at?.x) ? at.x : undefined;
      const z = Number.isFinite(at?.z) ? at.z : undefined;
      announce("thunder", x, z, "storm");
      if (!running() || muted()) return;
      const n = ac.currentTime,
        pan = panOf(x !== undefined && z !== undefined ? locate(x, z).pan * THUNDER_PAN : 0);
      thunderNoise ??= noiseBuffer(2); // AudioBuffers outlive their context: kept for the page
      const source = ac.createBufferSource(),
        filter = ac.createBiquadFilter(),
        gain = ac.createGain(),
        panner = pan && ac.createStereoPanner ? ac.createStereoPanner() : null;
      source.buffer = thunderNoise;
      filter.type = "lowpass";
      filter.frequency.value = 350;
      gain.gain.setValueAtTime(0.001, n);
      gain.gain.linearRampToValueAtTime(0.7 * vary(GAIN_VARIATION), n + 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, n + 1.8);
      source.connect(filter);
      filter.connect(gain);
      if (panner) {
        panner.pan.value = pan;
        gain.connect(panner);
        panner.connect(sfxBus);
      } else gain.connect(sfxBus);
      source.onended = () => {
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
        panner?.disconnect();
      };
      source.start(n);
      source.stop(n + 1.9);
      tone(52, n, 1.2, "sine", 0.25, 27, PRIORITY.event, pan);
    } catch (err) {
      warn("thunder", err);
    }
  }

  // --- foley and ambience (called once per simulation step in play) ------------------
  function resetFoley() {
    foley.distance = 0;
    foley.heart = 0;
    foley.voice = VOICE_FIRST;
    foley.ambient = AMBIENT_FIRST;
    foley.extra = EXTRA_FIRST;
    foley.tracked = false;
    foley.dashing = foley.wasDashing = false;
    foley.primed = false;
    foley.portal = 0;
  }

  // Distance walked since the previous step, and whether a dash spanned the step.
  function trackPlayer(p) {
    const moved = foley.tracked ? Math.hypot(p.x - foley.x, p.z - foley.z) : 0;
    foley.x = p.x;
    foley.z = p.z;
    foley.tracked = true;
    foley.wasDashing = foley.dashing;
    foley.dashing = p.dashing > 0;
    return moved;
  }

  // Low HP heartbeat speeds up from every 1.8 s at 25% to every 0.8 s near death.
  const heartInterval = (health) => HEART_FAST + (HEART_SLOW - HEART_FAST) * clamp(health / HEART_THRESHOLD, 0, 1);

  function footstep(stage) {
    foley.left = !foley.left;
    play(STEP_SOUNDS[stage], 1, foley.left ? -STEP_PAN : STEP_PAN, foley.left ? 1 - STEP_DETUNE : 1 + STEP_DETUNE);
  }

  function nearestHostile(run, p) {
    const list = run.enemies || [];
    let best = null,
      bestDistance = VOICE_NEARBY;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead || !(e.hp > 0)) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d < bestDistance) {
        best = e;
        bestDistance = d;
      }
    }
    return best;
  }

  function updateFoley(dt, run, p, moved) {
    if (foley.wasDashing && !foley.dashing) {
      play("dashEnd");
      foley.distance = 0;
    }
    // Every stride sounds (the original's gaps dropped every other step at run speed).
    if (!foley.wasDashing && !foley.dashing && moved < TELEPORT) {
      foley.distance += moved;
      if (foley.distance >= STRIDE) {
        foley.distance %= STRIDE;
        footstep(stageIndex(run));
      }
    }
    foley.heart -= dt;
    const health = p.max > 0 ? p.hp / p.max : 1;
    if (p.hp > 0 && health < HEART_THRESHOLD && foley.heart <= 0) {
      play("heartbeat");
      foley.heart = heartInterval(health);
    }
    foley.voice -= dt;
    if (foley.voice <= 0) {
      foley.voice = VOICE_INTERVAL;
      const e = nearestHostile(run, p);
      if (e) voice(e);
    }
  }

  // Sparse stage accents every 7-12 s of game time (plus the meadow's birdsong).
  function updateAmbient(dt, run) {
    if (run.tutorial || ctx.mode !== "play" || !running() || muted() || level("effects") === 0) return;
    const stage = stageIndex(run);
    foley.ambient -= dt;
    if (foley.ambient <= 0) {
      foley.ambient = 7 + Math.random() * 5;
      play(AMBIENT_SOUNDS[stage], 1, (Math.random() * 2 - 1) * AMBIENT_PAN);
    }
    const extra = AMBIENT_EXTRAS[stage];
    if (!extra) return;
    foley.extra -= dt;
    if (foley.extra <= 0) {
      foley.extra = 10 + Math.random() * 8;
      play(extra, 1, (Math.random() * 2 - 1) * AMBIENT_PAN);
    }
  }

  // New enemies rising, enemy rounds whizzing past, and the spatial beds (open portal, lava,
  // live hazard props). Reads the run only; its bookkeeping lives in WeakSets and foley.
  function updateWorld(dt, run, p) {
    const enemies = run.enemies || [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (seen.has(e)) continue;
      seen.add(e);
      // The first scan after a stage entry only learns who is already there.
      if (!foley.primed || e.dead || e.boss || e.keeper || e.elite || e.parent) continue;
      if (Math.hypot(e.x - p.x, e.z - p.z) < EMERGE_RANGE) layerAt("emerge", 1, e.x, e.z, 0.85 + Math.random() * 0.3);
    }
    foley.primed = true;
    const shots = run.shots || [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      if (!s.enemy || whizzed.has(s) || !(Math.hypot(s.x - p.x, s.z - p.z) < WHIZ_RADIUS)) continue;
      whizzed.add(s);
      if (p.hp > 0) layerAt("whiz", 1, s.x, s.z, 0.85 + Math.random() * 0.3);
    }
    const portal = ctx.world?.portal;
    foley.portal -= dt;
    if (run.portalActive && portal && foley.portal <= 0) {
      foley.portal = PORTAL_EVERY;
      const d = Math.hypot(portal.x - p.x, portal.z - p.z);
      if (d < PORTAL_RANGE) layerAt("portalHum", 1 - d / PORTAL_RANGE, portal.x, portal.z);
    }
    foley.near -= dt;
    if (foley.near <= 0) {
      foley.near = 0.8 + Math.random() * 1.2;
      nearbyHazard(run, p);
    }
  }

  // The nearest lava pool or live hazard prop inside NEAR_RANGE bubbles or hisses.
  function nearbyHazard(run, p) {
    let best = null,
      bestD = NEAR_RANGE,
      name = null;
    const pools = ctx.world?.scenery?.lavaPools?.() ?? [];
    for (const pool of pools) {
      const d = Math.hypot(pool.x - p.x, pool.z - p.z);
      if (d < bestD) [best, bestD, name] = [pool, d, "lavaBubble"];
    }
    for (const o of run.objects || []) {
      if (o.kind !== "prop" || o.dead || !(o.hp > 0)) continue;
      const d = Math.hypot(o.x - p.x, o.z - p.z);
      if (d < bestD) [best, bestD, name] = [o, d, "hazardHiss"];
    }
    if (best) layerAt(name, 1 - bestD / NEAR_RANGE, best.x, best.z, 0.8 + Math.random() * 0.4);
  }

  function update(dt) {
    try {
      const run = ctx.run,
        p = run?.player;
      if (!p) return;
      const moved = trackPlayer(p);
      if (run.demo || hidden()) return;
      updateAmbient(dt, run);
      updateFoley(dt, run, p, moved);
      if (ctx.mode === "play" && running() && !muted()) updateWorld(dt, run, p);
    } catch (err) {
      warn("update", err);
    }
  }

  // Looping room tone per stage while the world is on screen; crossfades on stage change.
  function bedStage() {
    const run = ctx.run;
    if (!run || run.demo || run.tutorial || ctx.overlay || !BED_MODES.has(ctx.mode)) return 0;
    if (!running() || hidden() || muted() || level("master") === 0 || level("effects") === 0) return 0;
    return stageIndex(run) + 1;
  }

  function updateBed() {
    const stage = bedStage();
    if ((bed ? bed.stage : 0) === stage) return;
    if (bed) releaseBed(bed);
    bed = stage ? startBed(stage) : null;
  }

  function startBed(stage) {
    const def = AMBIENCE_BEDS[stage - 1],
      t = ac.currentTime;
    bedNoise ??= noiseBuffer(BED_NOISE_SECONDS);
    const source = ac.createBufferSource(),
      filter = ac.createBiquadFilter(),
      swell = ac.createGain(),
      fader = ac.createGain(),
      lfo = ac.createOscillator(),
      depth = ac.createGain();
    const nodes = [source, filter, swell, fader, lfo, depth],
      sources = [source, lfo];
    source.buffer = bedNoise;
    source.loop = true;
    filter.type = def.filter;
    filter.frequency.value = def.freq;
    filter.Q.value = def.q;
    lfo.frequency.value = def.lfo;
    depth.gain.value = def.depth;
    fader.gain.setValueAtTime(0.0001, t);
    fader.gain.linearRampToValueAtTime(def.gain, t + BED_FADE_IN);
    source.connect(filter);
    filter.connect(swell);
    swell.connect(fader);
    fader.connect(sfxBus);
    lfo.connect(depth);
    depth.connect(swell.gain); // swell breathes between 1 - depth and 1 + depth
    if (def.sweep) {
      const sweep = ac.createGain();
      sweep.gain.value = def.sweep;
      lfo.connect(sweep);
      sweep.connect(filter.frequency);
      nodes.push(sweep);
    }
    for (const [hz, amount] of def.hum) {
      const osc = ac.createOscillator(),
        g = ac.createGain();
      osc.frequency.value = hz;
      g.gain.value = amount;
      osc.connect(g);
      g.connect(swell);
      nodes.push(osc, g);
      sources.push(osc);
    }
    source.onended = () => {
      for (const node of nodes) node.disconnect();
    };
    source.start(t, Math.random() * BED_NOISE_SECONDS);
    for (let i = 1; i < sources.length; i++) sources[i].start(t);
    return { stage, fader, sources };
  }

  function releaseBed(b) {
    const t = ac.currentTime,
      end = t + BED_FADE_OUT;
    holdParam(b.fader.gain, t);
    b.fader.gain.linearRampToValueAtTime(0, end);
    for (const s of b.sources) {
      try {
        s.stop(end + 0.05);
      } catch {
        // Never started (context failed mid-build): nothing to stop.
      }
    }
  }

  // --- Wave-2 cues from the bus ------------------------------------------------------

  // Directional guards answer by arc: a rear hit on the Abbot's ember core, the Castellan's
  // Aegis (a full block at full gain, a front hit quieter), or stone crust.
  function guardHit({ e, arc, mult = 1, blocked = false } = {}) {
    if (!e) return;
    if (arc === "rear" && mult > 1) fx("emberHit", 1, e);
    else if (arc === "front") fx(GUARD_SOUNDS[e.keeper] ?? "impactStone", blocked ? 1 : GUARD_FRONT, e);
  }

  function prop({ kind, event, x, z } = {}) {
    const name = PROP_CUES[event]?.[kind];
    if (name) fx(name, 1, { x, z, src: kind });
  }

  // Tier-ups climb the A-minor roots; a break of a real chain falls away.
  function chain({ event, tier = 0, count = 0 } = {}) {
    if (event === "tier") play("chainUp", 1, 0, (CHAIN_ROOTS[clamp(tier - 1, 0, CHAIN_ROOTS.length - 1)] ?? CHAIN_ROOTS[0]) / CHAIN_ROOTS[0]);
    else if ((event === "sever" || event === "end") && count >= CHAIN_BREAK_MIN) play("chainBreak");
  }

  // --- public actions ---------------------------------------------------------------
  // New run (not the attract demo): restart the score from bar 0, clear cooldowns.
  function start() {
    try {
      resetFoley();
      lastPlayed.clear();
      lastAnnounced.clear();
      // Outside a gesture a fresh context would only start suspended (and warn).
      if (ac || userActivated()) unlock();
      soundtrack.reset();
    } catch (err) {
      warn("start", err);
    }
  }

  // Settings TEST SOUND. Returns a promise that settles (never rejects) once `status` is final.
  function test() {
    try {
      if (muted() || level("master") === 0 || level("effects") === 0) {
        setStatus(STATUS.raise);
        return Promise.resolve();
      }
      unlock();
      if (!ac) return Promise.resolve();
      return Promise.resolve(ac.resume?.())
        .then(() => {
          if (!ac) return;
          const n = ac.currentTime + 0.03;
          TEST_TONES.forEach((f, i) => tone(f, n + i * 0.13, 0.24, "triangle", 0.35, 0, PRIORITY.vital, 0));
          setStatus(STATUS.testing);
        })
        .catch(() => setStatus(STATUS.blocked));
    } catch (err) {
      warn("test", err);
      return Promise.resolve();
    }
  }

  // --- wiring -----------------------------------------------------------------------
  if (typeof document !== "undefined") {
    const gesture = () => {
      if (!muted() && !running() && activeGesture()) unlock();
    };
    for (const type of GESTURES) document.addEventListener(type, gesture, { capture: true });
    installUiSounds(document, ctx.bus, {
      cue: (name, pitch = 1) => play(name, 1, 0, pitch, QUIET),
      cues: () => uiCues,
      lastCue: () => uiAt,
    });
  }

  // A player round stopped by cover sometimes sings off it (Math.random: audio only).
  function ricochet(at) {
    try {
      if (at && Math.random() < RICOCHET_CHANCE) layerAt("ricochet", 0.6, at.x, at.z, 0.85 + Math.random() * 0.35);
    } catch (err) {
      warn("ricochet", err);
    }
  }

  const on = (type, fn) => ctx.bus?.on?.(type, safely(type, fn));
  on("prefs", () => apply());
  on("thunder", (p) => thunder(p));
  on("runStart", resetFoley);
  on("stageEnter", (p) => {
    foley.tracked = false; // the player was placed, not walked
    foley.primed = false; // the stage's opening population appears silently
    if ((p?.stage ?? ctx.run?.stage) > 1 && !ctx.run?.tutorial) play("stingerStage");
  });
  on("portalOpen", () => play("stingerPortal", 1, 0, 1, { src: "portal" }));
  on("boss", (p) => {
    if (p?.event === "spawn") play("stingerBoss");
    else if (p?.event === "vigil") fx("vigilHum", 1, p.e);
    else if (p?.event === "phase") play("stingerPhase", 1, 0, 1, QUIET);
    else if (p?.event === "stagger") layerAt("keeperStagger", 1, p.e?.x, p.e?.z);
    else if (p?.event === "defeat") layerAt("keeperFall", 1, p.e?.x, p.e?.z);
  });
  // Sound pass: brass after each shot, a per-weapon clack on a switch.
  on("fire", (p) => {
    const name = CASINGS[p?.weapon];
    if (name && ctx.mode === "play") play(name, 1, (Math.random() * 2 - 1) * 0.3, 0.9 + Math.random() * 0.2, QUIET);
  });
  on("weapon", (p) => {
    const name = WEAPON_RACKS[p?.index];
    if (name && ctx.mode === "play") play(name, 1, 0, 1, QUIET);
  });
  on("levelUp", () => play("stingerLevel"));
  // Kill and crit cues from the combat events (same-moment duplicates share one cooldown).
  on("enemyKilled", (p) => {
    if (!p?.e) return;
    fx("kill", 1, p.e);
    if (p.critical) layerAt("critKill", 1, p.e.x, p.e.z);
  });
  on("enemyHit", (p) => p?.critical && p.e && fx("crit", 1, p.e));
  on("guardHit", guardHit);
  on("elite", (p) => {
    if (p?.event === "spawn") fx("eliteSpawn", 1, p.e);
    else if (p?.event === "defeat") fx("eliteDeath", 1, p.e);
  });
  on("relic", () => play("relic"));
  on("prop", prop);
  on("chain", chain);
  on("feat", (p) => p?.cue && play("feat"));
  // Repair field regen pops silently (F16.5); the demo's heals are silent through play().
  on("playerHeal", (p) => p?.reason !== "regen" && play("heal"));
  on("codex", () => play("newEntry"));
  on("unlock", () => play("unlock"));

  return {
    unlock,
    apply: () => {
      try {
        apply();
      } catch (err) {
        warn("apply", err);
      }
    },
    fx,
    voice,
    ricochet,
    thunder,
    start,
    update,
    test,
    silent,
    get status() {
      return status;
    },
  };
}
