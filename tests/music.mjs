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
