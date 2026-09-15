import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Three from 'three';
import {WEAPONS,ENEMY_TYPES,movementVector,segmentHit} from '../dist/rules.js';
import {DEFAULT_BINDINGS,ACTION_LABELS,keyLabel,loadPreferences,assignBinding} from '../dist/preferences.js';

assert.equal(WEAPONS.length,5);assert.equal(Object.keys(ENEMY_TYPES).length,10);
for(let i=0;i<360;i++){
 const a=i*Math.PI/180,v=movementVector(Math.sin(a),Math.cos(a),.6);
 assert.ok(Math.abs(Math.hypot(v.x,v.z)-1)<1e-10);
}
assert.equal(Math.hypot(...Object.values(movementVector(.3,.4,0))),.5);
assert.ok(segmentHit(0,0,10,0,5,.2,.4));assert.ok(!segmentHit(0,0,10,0,5,2,.4));

class Element {
 constructor(){this.children=[];this.textContent='';this.style={setProperty(){}};this.classList={add(){},remove(){},toggle(){}};this.disabled=false}
 appendChild(el){this.children.push(el)} replaceChildren(){this.children=[]} querySelector(){return new Element()}
 addEventListener(){} setAttribute(){} focus(){} remove(){} setPointerCapture(){} getBoundingClientRect(){return {left:0,top:0,width:110,height:110}}
}
const nodes=new Map();const document={body:new Element(),querySelector(s){if(!nodes.has(s))nodes.set(s,new Element());return nodes.get(s)},querySelectorAll(s){return s==='.weapon'?nodes.get('#weapons').children:[]},createElement(){return new Element()},addEventListener(){}};
class Renderer {constructor(){this.shadowMap={}}setPixelRatio(){}setSize(){}}
class Composer {addPass(){}render(){}setSize(){}setPixelRatio(){}}
const context={T:{...Three,WebGLRenderer:Renderer},EffectComposer:Composer,RenderPass:class{},UnrealBloomPass:class{},OutputPass:class{},WEAPONS,ENEMY_TYPES,movementVector,segmentHit,DEFAULT_BINDINGS,ACTION_LABELS,keyLabel,loadPreferences,assignBinding,document,window:{},navigator:{getGamepads:()=>[]},matchMedia:()=>({matches:false}),devicePixelRatio:1,innerWidth:1280,innerHeight:800,performance,crypto:webcrypto,console,setTimeout:()=>0,clearTimeout(){},requestAnimationFrame(){},addEventListener(){},fetch:async()=>({ok:true,json:async()=>({scores:[]})})};
vm.createContext(context);
const source=fs.readFileSync(new URL('../dist/game.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
vm.runInContext(source+`\n globalThis.test={start,update,equip,spawnEnemy,dash,fire,enemyUpdate,levelUp,hero,scene,updateEffects,pause,openPanel,closePanel,prefs,finishRun,activatePortal,enterStage, get state(){return {player,mode,enemies,shots,hazards,kills,score,elapsed,stage,stageKills,stageGoal,portalActive}},setAim(v){aim=v},setKeys(v){keys=v},setStick(v){aimStick=v},setMode(v){mode=v}}`,context);
const t=context.test;
assert.equal(context.window.gameReady,true);
t.scene.traverse(o=>{assert.ok(o.position.toArray().every(Number.isFinite));assert.ok(o.scale.toArray().every(Number.isFinite))});
t.start();assert.equal(t.state.mode,'play');
t.setKeys({KeyW:true,KeyD:true});for(let i=0;i<15;i++)t.update(.016);
assert.ok(Math.hypot(t.state.player.x,t.state.player.z)>0);t.dash();assert.ok(t.state.player.dashing>0);
for(let weapon=0;weapon<5;weapon++){
 t.start();t.setKeys({});t.equip(weapon);const enemy=t.spawnEnemy('brute');enemy.x=0;enemy.z=4;enemy.hp=500;enemy.max=500;t.setAim(0);t.fire();assert.ok(t.state.shots.length>=WEAPONS[weapon].count);
 for(let n=0;n<25;n++)t.update(.016);
 assert.ok(enemy.hp<500,WEAPONS[weapon].label+' should hit the target');
}
for(const type of Object.keys(ENEMY_TYPES)){
 t.start();const e=t.spawnEnemy(type);e.x=0;e.z=type==='brute'?2:7;e.cool=-1;t.enemyUpdate(e,.016);
 if(type==='gunner')assert.equal(t.state.shots.length,3);
 if(type==='mortar'||type==='brute')assert.ok(t.state.hazards.length>0);
 if(type==='charger'){assert.equal(e.state,'windup');t.enemyUpdate(e,.9);assert.equal(e.state,'charge')}
}
t.start();t.state.player.xp=11;t.update(.016);assert.equal(t.state.mode,'upgrade');assert.equal(t.state.player.level,2);
t.start();assert.equal(t.state.shots.length,0);assert.equal(t.state.enemies.length,0);assert.equal(t.state.hazards.length,0);
t.activatePortal();assert.equal(t.state.portalActive,true);assert.equal(t.state.stage,1);t.enterStage();assert.equal(t.state.stage,2);assert.equal(t.state.stageKills,0);assert.ok(t.state.stageGoal>t.state.player.xp);assert.equal(t.state.portalActive,false);t.start();
t.start();const near=t.spawnEnemy('runner');near.x=0;near.z=5;t.setStick({x:1,y:0});
for(let i=0;i<15;i++)t.update(.016);
assert.equal(t.state.shots.filter(b=>!b.enemy).length,0,'Aim stick and nearby enemy must never fire');
t.setKeys({Mouse0:true});t.update(.016);assert.ok(t.state.shots.some(b=>!b.enemy),'Held fire button shoots');
const pausedAt=t.state.elapsed;t.pause();t.update(1);assert.equal(t.state.elapsed,pausedAt);
t.openPanel('#settings');t.update(1);assert.equal(t.state.elapsed,pausedAt);t.closePanel();assert.equal(t.state.mode,'pause');t.pause();
assert.equal(t.state.mode,'play');const count=t.state.shots.length;t.update(.016);assert.equal(t.state.shots.length,count,'Resume must not resume held firing');
t.start();assignBinding(t.prefs.bindings,'fire','KeyJ');t.setKeys({Mouse0:true});t.update(.016);assert.equal(t.state.shots.length,0);t.setKeys({KeyJ:true});t.update(.016);assert.ok(t.state.shots.length>0);t.prefs.bindings={...DEFAULT_BINDINGS};
const testBindings={...DEFAULT_BINDINGS};assignBinding(testBindings,'forward','KeyS');assert.equal(testBindings.back,'KeyW');
const prefRoundTrip=loadPreferences({getItem:()=>JSON.stringify({...t.prefs,master:25,music:0,effects:80})});assert.equal(prefRoundTrip.master,25);assert.equal(prefRoundTrip.music,0);assert.equal(prefRoundTrip.effects,80);
t.start();
for(let tick=0;tick<4500;tick++){
 t.state.player.inv=2;
 if(t.state.mode==='upgrade')nodes.get('#cards').children[0].onclick();
 if(tick%500===0)t.equip(Math.floor(tick/500)%5);
 t.setKeys({Mouse0:true});const target=t.state.enemies.find(e=>e.hp>0);if(target)t.setAim(Math.atan2(target.x-t.state.player.x,target.z-t.state.player.z));
 t.update(1/60);t.updateEffects(1/60);
}
assert.ok(t.state.kills>0);
t.scene.traverse(o=>{assert.ok(o.position.toArray().every(Number.isFinite));assert.ok(o.scale.toArray().every(Number.isFinite))});
const visited=new Set();
function checkImports(file){
 if(visited.has(file))return;visited.add(file);
 assert.ok(fs.existsSync(file),'Missing module '+file);
 for(const m of fs.readFileSync(file,'utf8').matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){
  const spec=m[1];
  if(spec==='three')checkImports(new URL('../dist/vendor/three.module.js',import.meta.url).pathname);
  else if(spec.startsWith('.'))checkImports(new URL(spec,'file://'+file).pathname);
 }
}
checkImports(new URL('../dist/game.js',import.meta.url).pathname);
assert.ok(fs.existsSync(new URL('../dist/style.css',import.meta.url)));
console.log('PASS: 75-second combat simulation, upgrades, all runtime module references ('+visited.size+' modules).');
console.log('PASS: scene initialization, 360° movement, dash, five weapon hits, six enemy classes, ranged/charge/area attacks, level-up, clean restart.');
console.log('PASS: no automatic fire, explicit fire input, aim-only stick, pause/menu freeze, resume clears firing, remapped fire key, conflict swap, audio preference persistence.');
