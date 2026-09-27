import assert from 'node:assert/strict';
import {RUN_MODES} from '../dist/rules.js';
assert.ok(RUN_MODES.normal.bpm>=128,'The normal soundtrack should have a driving tempo');
assert.ok(RUN_MODES.death.bpm>RUN_MODES.normal.bpm,'Death Mode remains more intense');
const {scoreEvents}=await import('../dist/soundtrack.js');
for(const death of [false,true]){
 const voices=new Set(),phrases=new Set();
 for(let i=0;i<1024;i++){
  const notes=scoreEvents(i,death);assert.ok(notes.length<=14,'Bounded voice count');
  for(const n of notes){voices.add(n.voice);assert.ok(n.gain>0&&n.gain<=1);assert.ok(n.duration>0&&n.duration<5);if(n.frequency!==undefined)assert.ok(Number.isFinite(n.frequency)&&n.frequency>20&&n.frequency<18000)}
  if(i%16===0)phrases.add(JSON.stringify(Array.from({length:16},(_,j)=>scoreEvents(i+j,death))));
 }
 for(const voice of ['bass','lead','organ','bell','kick','snare','hat'])assert.ok(voices.has(voice),voice+' is present');
 assert.ok(phrases.size>=12,'Song includes distinct phrases and changing sections');
}
assert.notDeepEqual(scoreEvents(0,false),scoreEvents(0,true),'Modes have distinct arrangements');
console.log('PASS: two varied horror-synth arrangements, driving tempos, instrument coverage and bounded voices.');

const {MusicIntensity}=await import('../dist/soundtrack.js');
const intensity=new MusicIntensity();assert.equal(intensity.at(1,'boss'),'normal');assert.equal(intensity.at(16,'boss'),'boss');assert.equal(intensity.at(17,'quiet'),'boss');assert.equal(intensity.at(32,'quiet'),'quiet');intensity.reset();assert.equal(intensity.current,'normal');
for(const death of [false,true])for(const activity of ['quiet','normal','trial','boss'])for(let step=0;step<256;step++)assert.ok(scoreEvents(step,death,activity).length<=16);
assert.ok(scoreEvents(2,false,'boss').length>scoreEvents(2,false,'normal').length);
console.log('PASS adaptive music: bar-boundary changes, reset and bounded encounter layers.');

// Menu context must latch without resetting transport, and must be a composed
// arrangement rather than the combat score with its percussion merely removed.
const menuIntensity=new MusicIntensity();
assert.equal(menuIntensity.at(0,'menu'),'menu');assert.equal(menuIntensity.at(7,'normal'),'menu');assert.equal(menuIntensity.at(16,'normal'),'normal');
const phrase=(start,death,activity)=>Array.from({length:256},(_,i)=>scoreEvents(start+i,death,activity));
for(const death of [false,true]){
 const first=phrase(0,death,'normal'),second=phrase(256,death,'normal'),menu=phrase(0,death,'menu');
 assert.notDeepEqual(first,second,'The second 16-bar arrangement must add musical material');
 assert.deepEqual(first,phrase(512,death,'normal'),'The two arrangements resolve into a stable 32-bar form');
 assert.notDeepEqual(menu,phrase(0,death,'quiet'),'Menu theme needs its own melody and rhythm');
 const gain=bars=>bars.flat().reduce((n,event)=>n+event.gain,0);
 assert.ok(gain(menu)<gain(first)*.4,'Menu orchestration leaves room for menu interaction');
 assert.ok(!menu.flat().some(e=>['kick','snare','hat','lead'].includes(e.voice)),'Menu theme omits the combat drum/lead layer');
 assert.ok(second.flat().some(e=>e.voice==='choir')&&second.flat().some(e=>e.voice==='pluck'),'Second arrangement uses its new counterline and choir');
 for(const activity of ['menu','quiet','normal','trial','boss'])for(let step=0;step<1024;step++)for(const e of scoreEvents(step,death,activity)){
  assert.ok(e.gain>0&&e.gain<=1&&Number.isFinite(e.gain));assert.ok(e.duration>0&&e.duration<5&&Number.isFinite(e.duration));if(e.frequency!==undefined)assert.ok(Number.isFinite(e.frequency)&&e.frequency>20&&e.frequency<18000);
  assert.ok(scoreEvents(step,death,activity).length<=16,'Expanded layers stay bounded');
 }
}
console.log('PASS expanded score: dedicated quiet menu, alternating 16-bar compositions, new instruments, repeatable form and finite bounded events.');

// A timed Web Audio fixture executes the real synthesizer: source endings free
// voices, envelopes stay finite, stop disconnects sources, and overload is capped.
const {createMusicPlayer}=await import('../dist/soundtrack.js');
class AudioFixture{
 constructor(){this.currentTime=0;this.sampleRate=8000;this.pending=new Set();this.starts=0;this.ended=0}
 param(){const value=(n,time)=>{assert.ok(Number.isFinite(n));assert.ok(Number.isFinite(time));return n};return {value:0,setValueAtTime:value,linearRampToValueAtTime:value,exponentialRampToValueAtTime:(n,time)=>{assert.ok(n>0);return value(n,time)}}}
 node(){return {connect(){},disconnect(){this.disconnected=true}}}
 source(){const context=this,node=this.node();return Object.assign(node,{frequency:this.param(),start(time){assert.ok(Number.isFinite(time));assert.ok(time>=context.currentTime-1e-8);context.pending.add(this);context.starts++},stop(time=context.currentTime){assert.ok(Number.isFinite(time));this.end=time}})}
 createGain(){return {...this.node(),gain:this.param()}}
 createOscillator(){return this.source()}
 createBufferSource(){return this.source()}
 createBuffer(channels,length){const data=new Float32Array(length);return {getChannelData:()=>data}}
 createBiquadFilter(){return {...this.node(),Q:this.param(),frequency:this.param()}}
 createStereoPanner(){return {...this.node(),pan:this.param()}}
 createDelay(){return {...this.node(),delayTime:this.param()}}
 createDynamicsCompressor(){return {...this.node(),threshold:this.param(),knee:this.param(),ratio:this.param(),attack:this.param(),release:this.param()}}
 advance(time){this.currentTime=time;for(const source of this.pending)if(source.end<=time){this.pending.delete(source);source.onended?.();assert.equal(source.disconnected,true);this.ended++}}
}
const voiceResults=[];
for(const death of [false,true]){
 const ctx=new AudioFixture(),music=createMusicPlayer(ctx,ctx.createGain()),tick=60/(death?168:140)/4,latch=new MusicIntensity();
 for(let step=0;step<1024;step++){
  const time=.12+step*tick;ctx.advance(time-.12);
  const activity=['menu','normal','trial','boss'][Math.floor(step/256)];music.schedule(step,time,death,.85,latch.at(step,activity));
  assert.ok(music.active<=96,'The music source ceiling is never exceeded');
 }
 assert.equal(music.metrics.dropped,0,'Realistic look-ahead must play every instrument in every section');
 assert.ok(ctx.ended>1000,'Voices retire continually during the score');
 const peak=music.metrics.peak;ctx.advance(ctx.currentTime+5);assert.equal(music.active,0,'All scheduled notes eventually end');
 const silentStarts=ctx.starts;music.schedule(0,ctx.currentTime+.02,death,0,'menu');assert.equal(ctx.starts,silentStarts,'Zero volume creates no sources');
 for(let n=0;n<100;n++)music.schedule(0,ctx.currentTime+.02,death,1,'boss');
 assert.equal(music.active,96);assert.ok(music.metrics.dropped>0,'Overload drops extra sources instead of allocating without limit');
 music.stop();assert.equal(music.active,0);music.stop();music.schedule(0,ctx.currentTime+.02,death,.85,'menu');assert.ok(music.active>0,'Scheduling can resume after an idempotent stop');music.stop();
 voiceResults.push({mode:death?'Death':'Normal',peak});
}
console.log('PASS synthesizer lifecycle: '+JSON.stringify(voiceResults)+'; finite envelopes, retirement, silent scheduling, overload ceiling and stop/resume.');
