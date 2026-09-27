import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createTerrain} from '../dist/terrain.js';
import {buildStageWorld} from '../dist/scenery.js';
import {webcrypto} from 'node:crypto';
import * as Three from 'three';
import {traceWorld,hitBody,pointAt} from '../dist/ballistics.js';
import {retroMaterial,retroCharacter,retroResolution,RetroShader} from '../dist/retro.js';
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
Object.assign(context,{traceWorld,hitBody,pointAt,createTerrain,buildStageWorld,retroMaterial,retroCharacter,retroResolution,RetroShader,ShaderPass:class{}});
vm.createContext(context);
const source=fs.readFileSync(new URL('../dist/game.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
vm.runInContext(source+`\n globalThis.test={height,start,update,equip,spawnEnemy,dash,fire,enemyUpdate,levelUp,hero,scene,updateEffects,pause,openPanel,closePanel,prefs,finishRun,activatePortal,enterStage,hurtEnemy,bossUpdate,updateCombatUI,moveWithCollision,portalBearing,setTimeOfDay,ambient,sun,rim,flora,floraLights,updateFlora, get state(){return {player,mode,enemies,shots,hazards,kills,score,elapsed,stage,stageKills,stageGoal,portalActive,bossSpawned,victory,gems,portal:stagePortal.position}},setAim(v){aim=v;aimPitch=0},setKeys(v){keys=v},setStick(v){aimStick=v},setMode(v){mode=v}}`,context);
const t=context.test;
vm.runInContext(`globalThis.demoTest={updateDemo,start,get state(){return {demoActive,demoAge,runId,pending:pendingScores.size,player,kills,shots,mode}},setPointer(){mouse.moved=true;mouse.x=0;mouse.y=0}}`,context);
const demo=context.demoTest;
assert.equal(demo.state.demoActive,true);
assert.equal(demo.state.mode,'menu');
assert.equal(demo.state.runId,null,'CPU demo must not own a leaderboard run');
const positions=new Set();
demo.setPointer();
for(let i=0;i<1200;i++){demo.updateDemo(1/60);positions.add(Math.round(demo.state.player.x)+','+Math.round(demo.state.player.z))}
assert.ok(demo.state.kills>0,'CPU must aim and kill enemies even after pointer movement');
assert.ok(positions.size>10,'CPU must move around the terrain');
assert.ok(Math.abs(demo.state.demoAge-30)<.01,'CPU simulation runs at 1.5x speed');
assert.equal(demo.state.pending,0,'CPU must never queue leaderboard scores');
assert.equal(demo.state.mode,'menu','CPU combat must keep the main menu open');
t.openPanel('#settings');const demoPaused=demo.state.demoAge;demo.updateDemo(1);assert.equal(demo.state.demoAge,demoPaused);t.closePanel();
demo.start();assert.equal(demo.state.demoActive,false);assert.equal(demo.state.player.hp,100);assert.equal(demo.state.kills,0);assert.equal(demo.state.shots.length,0);assert.ok(demo.state.runId);
console.log('PASS: live CPU combat and movement, 1.5x speed, menu panel freeze, score isolation, and clean player takeover.');
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
  if(spec==='three')checkImports(fileURLToPath(new URL('../dist/vendor/three.module.js',import.meta.url)));
  else if(spec.startsWith('.'))checkImports(fileURLToPath(new URL(spec,pathToFileURL(file))));
 }
}
checkImports(fileURLToPath(new URL('../dist/game.js',import.meta.url)));
assert.ok(fs.existsSync(new URL('../dist/style.css',import.meta.url)));
console.log('PASS: 75-second combat simulation, upgrades, all runtime module references ('+visited.size+' modules).');
console.log('PASS: scene initialization, 360° movement, dash, five weapon hits, six enemy classes, ranged/charge/area attacks, level-up, clean restart.');
console.log('PASS: no automatic fire, explicit fire input, aim-only stick, pause/menu freeze, resume clears firing, remapped fire key, conflict swap, audio preference persistence.');

t.start();
for(let n=1;n<5;n++){
 t.activatePortal();const p=t.state.player,portal=t.state.portal;
 assert.ok(Math.hypot(portal.x,portal.z)<54.01,'Portal remains safely inside the arena');
 for(let frame=0;frame<1000&&Math.hypot(p.x-portal.x,p.z-portal.z)>2.8;frame++){
  const dx=portal.x-p.x,dz=portal.z-p.z,d=Math.hypot(dx,dz);
  t.moveWithCollision(p,dx/d*.12,dz/d*.12,.45);
 }
 assert.ok(Math.hypot(p.x-portal.x,p.z-portal.z)<3,'Direct portal approach must not hit collision barriers');
 p.inv=5;t.update(.016);assert.equal(t.state.stage,n+1,'Walking into portal must advance the stage');
}
assert.ok(Math.abs(t.portalBearing(0,-1,0)+Math.PI/2)<1e-9);
assert.ok(Math.abs(t.portalBearing(1,0,0))<1e-9);
assert.ok(Math.abs(t.portalBearing(0,1,0)-Math.PI/2)<1e-9);
assert.ok(Math.abs(t.portalBearing(1,0,Math.PI/2)-Math.PI/2)<1e-9);
const dayAmbient=t.ambient.intensity,daySun=t.sun.intensity,dayRim=t.rim.intensity;t.setTimeOfDay('night');assert.ok(t.ambient.intensity<dayAmbient);assert.ok(t.sun.intensity<daySun);assert.ok(t.rim.intensity<dayRim);assert.ok(t.flora.visible);t.updateFlora(1);assert.ok(t.floraLights.every(l=>l.intensity>0));
t.setTimeOfDay('day');assert.equal(t.ambient.intensity,dayAmbient);assert.equal(t.flora.visible,false);assert.ok(t.floraLights.every(l=>l.intensity===0));
console.log('PASS: unobstructed walking and portal activation in stages 1–4, compass cardinal bearings and camera rotation, dark night lighting, flora illumination, day restoration.');

t.start();const sniper=t.spawnEnemy('sniper');sniper.x=0;sniper.z=18;sniper.cool=-1;
t.enemyUpdate(sniper,.016);assert.equal(sniper.state,'snipe');assert.ok(sniper.warning);assert.equal(t.state.shots.length,0);
t.enemyUpdate(sniper,.5);assert.equal(t.state.shots.length,0);t.enemyUpdate(sniper,.5);assert.equal(t.state.shots.length,1);assert.equal(sniper.warning,null);
t.start();const victim=t.spawnEnemy('runner');t.hurtEnemy(victim,10000);const carried=t.state.gems.reduce((n,g)=>n+g.v,0),xp=t.state.player.xp;t.activatePortal();t.enterStage();assert.equal(t.state.player.xp,xp+carried);assert.equal(t.state.player.inv,2);
for(let stage=2;stage<5;stage++){t.activatePortal();t.enterStage()}
t.activatePortal();assert.equal(t.state.bossSpawned,true);assert.equal(t.state.portalActive,false);const boss=t.state.enemies.find(e=>e.kind==='warden');assert.ok(boss);t.activatePortal();assert.equal(t.state.enemies.filter(e=>e.kind==='warden').length,1);
boss.cool=-1;t.enemyUpdate(boss,.016);assert.equal(boss.state,'bossWindup');assert.equal(t.state.shots.length,0);t.enemyUpdate(boss,1.2);assert.equal(t.state.shots.length,14);
boss.hp=boss.max*.4;t.enemyUpdate(boss,.016);assert.equal(boss.enraged,true);t.hurtEnemy(boss,100000);assert.equal(t.state.victory,true);assert.equal(t.state.mode,'dead');assert.ok(nodes.get('.menu-card h1').innerHTML.includes('CONQUERED'));
t.start();assert.equal(t.state.victory,false);assert.equal(t.state.bossSpawned,false);assert.equal(t.state.stage,1);
console.log('PASS: sniper warning precedes shot, portal collects XP and grants arrival protection, unique final boss with delayed attacks/enrage, victory and clean restart.');

// Combat visuals, portal clearance and resource counts across repeated transitions.
t.start();
const lightingCount=()=>{let count=0;t.scene.traverse(o=>{if(o.isLight)count++});return count};
const initialLights=lightingCount();
for(let stage=1;stage<=5;stage++){
 const p=t.state.player,portal=t.state.portal;p.x=portal.x;p.z=portal.z;
 t.setAim(0);t.fire();const shot=t.state.shots.at(-1);
 assert.ok(Math.abs(shot.m.position.y-t.height(shot.x,shot.z)-1.47)<1e-6,'Shot starts above elevated ground');
 assert.ok(t.flora.children.length===3);assert.equal(lightingCount(),initialLights,'Stage rebuild must not leak lights');
 for(const kind of Object.keys(ENEMY_TYPES)){const e=t.spawnEnemy(kind);assert.ok(Number.isFinite(e.c.g.position.y));assert.ok(Math.abs(e.c.g.position.y-t.height(e.x,e.z))<1e-6)}
 if(stage<5){t.activatePortal();t.enterStage()}
}
t.start();assert.equal(lightingCount(),initialLights);assert.equal(t.flora.children.length,3);
console.log('PASS: elevated projectile/enemy placement, all enemy types in all stages, constant light/foliage counts through stage rebuilds and restart.');

t.start();t.fire();
vm.runInContext('globalThis.shotTest={updateShots}',context);
const freeShot=t.state.shots[0];Object.assign(freeShot,{x:25,y:100,z:17,vx:37,vy:-2,vz:21});
const previousGround=t.height(freeShot.x,freeShot.z);context.shotTest.updateShots(.2);
assert.ok(Math.abs(freeShot.y-99.6)<1e-9,'Flight uses persistent world height and vertical velocity');
assert.ok(Math.abs(freeShot.x-32.4)<1e-9&&Math.abs(freeShot.z-21.2)<1e-9);
assert.notEqual(t.height(freeShot.x,freeShot.z),previousGround,'Trajectory test crosses changing terrain');
assert.equal(freeShot.m.position.y,freeShot.y,'Rendered tracer matches physical bullet height');
console.log('PASS: integrated projectile flight crosses changing terrain without resampling its altitude.');

// The public entry path must collect a fresh username, including after a retry.
t.start(true);nodes.get('#start').onclick();
assert.equal(nodes.get('#playerName').value,'','Every run asks for a fresh username');
nodes.get('#playerName').value='   ';nodes.get('#runForm').onsubmit({preventDefault(){}});
assert.equal(t.state.mode,'menu','Whitespace usernames cannot start a run');
assert.ok(nodes.get('#usernameError').textContent);
nodes.get('#playerName').value='  Ash Runner  ';nodes.get('#runForm').onsubmit({preventDefault(){}});
assert.equal(t.state.mode,'play');
const sent=[];context.fetch=async(url,options)=>{if(options?.method==='POST')sent.push(JSON.parse(options.body));return {ok:true,json:async()=>({scores:[{name:'Ash Runner',score:90,stage:3,played_at:Date.UTC(2026,8,26,12)}]})}};
t.update(1.2);nodes.get('#playerName').value='Changed later';t.finishRun(false);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(sent.at(-1).name,'Ash Runner','Saved name belongs to the run, not a mutable input');
assert.ok(sent.at(-1).seconds>=1);assert.equal(sent.at(-1).stage,1);assert.ok(Math.abs(sent.at(-1).played_at-Date.now())<2000);
nodes.get('#start').onclick();assert.equal(nodes.get('#playerName').value,'','Play Again also clears the username');t.closePanel();
await nodes.get('#refreshLeaderboard').onclick();
assert.deepEqual(nodes.get('#leaderboardRows').children.at(-1).children.map(c=>c.textContent),['Ash Runner','90','3',new Date(Date.UTC(2026,8,26,12)).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})]);
console.log('PASS: username required every run, trimmed run identity, score submission and Player/Score/Stage/Date rows.');
