import assert from 'node:assert/strict';

const sounds=await import('../dist/audio-effects.js').catch(error=>{
 if(error.code==='ERR_MODULE_NOT_FOUND')return {};
 throw error;
});
const {EXTRA_SOUNDS,EXTRA_LAYERS,EFFECT_GAPS,ENEMY_VOICES,STEP_SOUNDS,AMBIENT_SOUNDS}=sounds;
assert.ok(EXTRA_SOUNDS&&EFFECT_GAPS&&ENEMY_VOICES&&STEP_SOUNDS&&AMBIENT_SOUNDS,'Campaign effects must expose a schedulable sound catalog');

// Catch invalid oscillator/ramp values before they can throw inside Web Audio.
const waveforms=new Set(['sine','triangle','sawtooth','square']);
function checkTone(tone,layer=false){
 assert.ok(Array.isArray(tone)&&tone.length===(layer?6:5),'Tone tuples must match the audio.tone adapter');
 const [frequency,duration,waveform,volume,endFrequency,delay=0]=tone;
 for(const n of [frequency,duration,volume,endFrequency,delay])assert.ok(Number.isFinite(n),'Non-finite envelopes must never reach Web Audio');
 assert.ok(frequency>=30&&frequency<=3000&&endFrequency>=30&&endFrequency<=3000,'Keep effects in a restrained audible register');
 assert.ok(duration>=.02&&duration<=1.2&&delay>=0&&delay<=.5&&duration+delay<=1.35,'All voices must end promptly');
 assert.ok(volume>0&&volume<=.09,'Individual effect voices must stay below weapon/explosion accents');
 assert.ok(waveforms.has(waveform),'Use an oscillator supported by the existing synthesizer');
}
for(const [type,primary] of Object.entries(EXTRA_SOUNDS)){
 checkTone(primary);
 const layers=EXTRA_LAYERS?.[type]||[];
 assert.ok(layers.length<=2,'An optional effect must never consume more than three voices');
 layers.forEach(tone=>checkTone(tone,true));
 assert.ok(primary[3]+layers.reduce((sum,tone)=>sum+tone[3],0)<=.13,'Composite accents must remain quieter than major combat cues');
 assert.ok(Number.isFinite(EFFECT_GAPS[type])&&EFFECT_GAPS[type]>=.06&&EFFECT_GAPS[type]<=20,'Every type needs a finite nonzero replay gap');
}
for(const type of [...Object.keys(EXTRA_LAYERS||{}),...Object.keys(EFFECT_GAPS)])assert.ok(EXTRA_SOUNDS[type],'Metadata cannot refer to an unavailable sound');
assert.equal(Object.keys(EXTRA_SOUNDS).some(type=>type.startsWith('warn')),false,'The additional palette must not replace combat warnings');

// Catch missing stage/kind routing, including Death Mode and encounter aliases.
for(const route of [STEP_SOUNDS,AMBIENT_SOUNDS]){
 assert.equal(route.length,5,'Every campaign world must have a sound');
 assert.equal(new Set(route).size,5,'Worlds need distinct sound identities');
 route.forEach(type=>assert.ok(EXTRA_SOUNDS[type],'Routing must resolve to a playable tone'));
 assert.equal(new Set(route.map(type=>JSON.stringify(EXTRA_SOUNDS[type]))).size,5,'Different names cannot hide identical world sounds');
}
for(const kind of ['runner','skitter','gunner','charger','brute','mortar','sniper','leaper','splitter','stormer','revenant','hexer','broodmother','ironmaw','warden'])assert.ok(EXTRA_SOUNDS[ENEMY_VOICES[kind]],'Missing enemy voice: '+kind);
const voices=[...new Set(Object.values(ENEMY_VOICES))];
assert.ok(voices.length>=10,'Distinct enemy families need audible identities');
assert.equal(new Set(voices.map(type=>JSON.stringify(EXTRA_SOUNDS[type]))).size,voices.length,'Different enemy families must not all reuse one growl');

// Repeated foley and noncritical vocals cannot become sustained warning-like tones.
for(const type of STEP_SOUNDS){assert.ok(EFFECT_GAPS[type]>=.25);assert.ok(EXTRA_SOUNDS[type][1]<=.12&&EXTRA_SOUNDS[type][3]<=.025)}
for(const type of voices){assert.ok(EFFECT_GAPS[type]>=2);assert.ok(EXTRA_SOUNDS[type][1]<EFFECT_GAPS[type]);assert.ok(EXTRA_SOUNDS[type][3]<=.05)}
for(const type of AMBIENT_SOUNDS){assert.ok(EFFECT_GAPS[type]>=6);assert.ok(EXTRA_SOUNDS[type][3]<=.025)}
for(const type of ['dashEnd','heartbeat','shield','pickup','portal','playerDeath','impactStone','fleshHit','meadowBird','meadowWind','uiOpen','uiConfirm','uiBack'])assert.ok(EXTRA_SOUNDS[type],'Missing player/world feedback: '+type);
assert.ok(EFFECT_GAPS.heartbeat>=.75&&EFFECT_GAPS.meadowBird>=6,'Heartbeat and birds need deliberate breathing room');
assert.ok(EFFECT_GAPS.fleshHit>=.1&&EFFECT_GAPS.impactStone>=.1,'Automatic fire must not emit a new impact voice for every pellet');
for(const type of ['uiOpen','uiConfirm','uiBack'])assert.ok(EXTRA_SOUNDS[type][1]<=.15,'Menu feedback should be brief');

console.log(`PASS audio effects: ${Object.keys(EXTRA_SOUNDS).length} finite restrained envelopes, at most three voices and 1.35s tails, explicit cooldowns, five world routes, ${voices.length} enemy voices, and preserved warning namespace.`);
