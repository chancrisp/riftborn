import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
// Exercise the real game audio lifecycle under the browser's suspended-context policy.
const game=fs.readFileSync(new URL('../dist/game.js',import.meta.url),'utf8');
const audioSource=game.slice(game.indexOf('const audio={'),game.indexOf("$('#sound').onclick="));
let resumes=0,notes=0,timers=0;
const param=()=>({value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}});
const node=()=>({gain:param(),frequency:param(),connect(){},disconnect(){},start(){notes++},stop(){}});
class Context{
 constructor(){this.state='suspended';this.currentTime=0;this.destination={}}
 createGain(){return node()}createOscillator(){return node()}
 resume(){resumes++;this.state='running';return Promise.resolve()}
 close(){this.state='closed';return Promise.resolve()}
}
const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{textContent:''});return elements.get(id)};
const prefs={master:100,music:70,effects:100,muted:false};
const context={window:{AudioContext:Context},prefs,demoActive:false,mode:'play',runDeath:false,runTuning:{bpm:140},console,$,savePrefs(){},syncSettings(){},setTimeout:()=>{timers++;return timers},clearTimeout(){},createMusicPlayer:()=>({schedule(){notes++}})};
vm.createContext(context);vm.runInContext(audioSource+';globalThis.subject=audio;',context);
const audio=context.subject;audio.start();await Promise.resolve();audio.tick();
assert.ok(resumes>0,'First run must explicitly resume a suspended AudioContext');
assert.ok(notes>0,'A running game must schedule audible output');
audio.ctx.state='suspended';const before=resumes;audio.start();await Promise.resolve();
assert.ok(resumes>before,'A subsequent run must recover interrupted sound');
assert.ok(audio.master.gain.value>0&&audio.music.gain.value>0&&audio.sfx.gain.value>0);
audio.ctx.state='closed';const stoppedNotes=notes;audio.fx('switch');assert.equal(notes,stoppedNotes,'Weapon selection does not use a closed context before run restart');audio.start();await Promise.resolve();assert.equal(audio.ctx.state,'running','A closed context is recreated');
vm.runInContext(game.slice(game.indexOf("$('#sound').onclick="),game.indexOf("$('#testSound').onclick=")),context);
prefs.master=0;elements.get('#sound').onclick();assert.equal(prefs.master,100);assert.equal(prefs.muted,false,'Sound button restores a zeroed master');
elements.get('#sound').onclick();assert.equal(prefs.muted,true,'Second click still mutes');
console.log('PASS: first-run audio unlock, interrupted-context recovery, and connected nonzero volume buses.');
