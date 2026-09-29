import {EXTRA_SOUNDS,EXTRA_LAYERS,EFFECT_GAPS,ENEMY_VOICES,STEP_SOUNDS,AMBIENT_SOUNDS} from '../dist/audio-effects.js';
import {recordWeaponKill,recordDiscovery,completeMasteryRun,masteryEntries,trackMastery,cosmeticAvailable,COSMETICS} from '../dist/mastery.js';
import {createLandmark,LANDMARKS} from '../dist/landmarks.js';
import {CampaignSequence,EncounterPacing,movementResponse,STAGE_STORIES} from '../dist/campaign.js';
import {updateCutaway} from '../dist/occlusion.js';
import {BuildFeedback,WEAPON_FEEDBACK} from '../dist/combat-feedback.js';
import {dangerMarker,disposeMarker,chargePath} from '../dist/warnings.js';
import {ScoreOutbox} from '../dist/score-outbox.js';
import {compareRun} from '../dist/run-history.js';
import {UPGRADE_INFO,shotStats,applyUpgrade,upgradePreview,modPreview,dashPreview} from '../dist/upgrades.js';
import {loadProfile,saveProfile,award,recordEnemy,equipCosmetic,rememberRun,BESTIARY} from '../dist/profile.js';
import {CHALLENGE,NodeCharge,quarryImpact,anchorMultiplier} from '../dist/challenges.js';
import {DashEffects} from '../dist/dash-traits.js';
import {SkullTrial,TRIAL_NAMES,trialLocations} from '../dist/trials.js';
import {CombatEffects} from '../dist/combat-effects.js';
import {createBuild,RewardQueue,MODS,DASH_TRAITS,modOffer,shuffled,BALANCE,GAMEPLAY_VERSION} from '../dist/progression.js';
import {SimulationClock,PadMenu} from '../dist/simulation.js';
import {POWERUPS,DROP_LIFETIME,MAX_DROPS,STATUE_BONUS,rollPowerup,createBoons,collectBoon,tickBoons,absorbDamage,createStatues} from '../dist/encounters.js';
import {createTutorial,tutorialCopy,TUTORIAL_PORTAL,TUTORIAL_GOAL} from '../dist/tutorial.js';
import {createStorm} from '../dist/storm.js';
import {createMusicPlayer,scoreEvents,MusicIntensity} from '../dist/soundtrack.js';
import {renderHeight,fogRange,FramePacer} from '../dist/graphics.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createTerrain,randomSource} from '../dist/terrain.js';
import {buildStageWorld} from '../dist/scenery.js';
import {webcrypto} from 'node:crypto';
import * as Three from 'three';
import {traceWorld,hitBody,pointAt} from '../dist/ballistics.js';
import {retroMaterial,retroCharacter,retroResolution,RetroShader} from '../dist/retro.js';
import {WEAPONS,ENEMY_TYPES,DEATH_TYPES,RUN_MODES,enemyPool,movementVector,segmentHit} from '../dist/rules.js';
import {DEFAULT_BINDINGS,ACTION_LABELS,keyLabel,loadPreferences,assignBinding} from '../dist/preferences.js';

const leaderboardHtml=fs.readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
assert.ok(!leaderboardHtml.includes('id="boardunknown"')&&!leaderboardHtml.includes('id="boardVersion"'),'The public leaderboard exposes only Normal and Death mode buttons');

assert.equal(WEAPONS.length,5);assert.equal(Object.keys(ENEMY_TYPES).length,10);
for(let i=0;i<360;i++){
 const a=i*Math.PI/180,v=movementVector(Math.sin(a),Math.cos(a),.6);
 assert.ok(Math.abs(Math.hypot(v.x,v.z)-1)<1e-10);
}
assert.equal(Math.hypot(...Object.values(movementVector(.3,.4,0))),.5);
assert.ok(segmentHit(0,0,10,0,5,.2,.4));assert.ok(!segmentHit(0,0,10,0,5,2,.4));

class Element {
 constructor(){this.children=[];this.textContent='';this.style={setProperty(){}};this.classList={add(){},remove(){},toggle(){}};this.disabled=false}
 get firstElementChild(){return this.children[0]} appendChild(el){this.children.push(el)} replaceChildren(){this.children=[]} querySelector(){return new Element()}
 addEventListener(){} setAttribute(){} focus(){} remove(){} setPointerCapture(){} getBoundingClientRect(){return {left:0,top:0,width:110,height:110}}
}
const listeners=new Map();
const nodes=new Map();const document={body:new Element(),querySelector(s){if(!nodes.has(s))nodes.set(s,new Element());return nodes.get(s)},querySelectorAll(s){return s==='.weapon'?nodes.get('#weapons').children:[]},createElement(){return new Element()},addEventListener(){}};
class Renderer {constructor(){this.shadowMap={};this.info={reset(){}}}setPixelRatio(){}setSize(){}}
class Composer {addPass(){}render(){}setSize(){}setPixelRatio(){}}
const context={EXTRA_SOUNDS,EXTRA_LAYERS,EFFECT_GAPS,ENEMY_VOICES,STEP_SOUNDS,AMBIENT_SOUNDS,recordWeaponKill,recordDiscovery,completeMasteryRun,masteryEntries,trackMastery,cosmeticAvailable,COSMETICS,createLandmark,LANDMARKS,CampaignSequence,EncounterPacing,movementResponse,STAGE_STORIES,updateCutaway,BuildFeedback,WEAPON_FEEDBACK,dangerMarker,disposeMarker,chargePath,ScoreOutbox,compareRun,UPGRADE_INFO,shotStats,applyUpgrade,upgradePreview,modPreview,dashPreview,randomSource,loadProfile,saveProfile,award,recordEnemy,equipCosmetic,rememberRun,BESTIARY,CHALLENGE,NodeCharge,quarryImpact,anchorMultiplier,DashEffects,SkullTrial,TRIAL_NAMES,trialLocations,CombatEffects,createBuild,RewardQueue,MODS,DASH_TRAITS,modOffer,shuffled,BALANCE,GAMEPLAY_VERSION,SimulationClock,PadMenu,T:{...Three,WebGLRenderer:Renderer},EffectComposer:Composer,RenderPass:class{},UnrealBloomPass:class{},OutputPass:class{},WEAPONS,ENEMY_TYPES,DEATH_TYPES,RUN_MODES,enemyPool,movementVector,segmentHit,DEFAULT_BINDINGS,ACTION_LABELS,keyLabel,loadPreferences,assignBinding,document,window:{__RIFTBORN_TEST__:true},navigator:{getGamepads:()=>[]},matchMedia:()=>({matches:false}),devicePixelRatio:1,innerWidth:1280,innerHeight:800,performance,crypto:webcrypto,console:{...console,error(...args){if(args[0]!=='Audio startup failed')console.error(...args)}},setTimeout:()=>0,clearTimeout(){},requestAnimationFrame(){},addEventListener(name,fn){listeners.set(name,fn)},fetch:async()=>({ok:true,json:async()=>({scores:[]})})};
Object.assign(context,{POWERUPS,DROP_LIFETIME,MAX_DROPS,STATUE_BONUS,rollPowerup,createBoons,collectBoon,tickBoons,absorbDamage,createStatues,createTutorial,tutorialCopy,TUTORIAL_PORTAL,TUTORIAL_GOAL,createStorm,createMusicPlayer,MusicIntensity,renderHeight,fogRange,FramePacer,traceWorld,hitBody,pointAt,createTerrain,buildStageWorld,retroMaterial,retroCharacter,retroResolution,RetroShader,ShaderPass:class{}});
context.scoreApiUrl=(query='')=>'/api/scores'+(query.startsWith('?')?query:'');
vm.createContext(context);
// Keep generated run seeds and gameplay randomness reproducible in this VM.
vm.runInContext('Math.random=randomSource(7361)',context);
const source=fs.readFileSync(new URL('../dist/game.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
vm.runInContext(source+`\n globalThis.test={height,start,update,equip,spawnEnemy,dash,fire,enemyUpdate,levelUp,hero,scene,updateEffects,pause,openPanel,closePanel,prefs,finishRun,activatePortal,enterStage,hurtEnemy,bossUpdate,updateCombatUI,moveWithCollision,portalBearing,setNightmare,ambient,sun,rim,storm, get state(){return {player,mode,enemies,shots,hazards,kills,score,elapsed,stage,stageKills,stageGoal,portalActive,bossSpawned,victory,gems,portal:stagePortal.position}},setAim(v){aim=v;aimPitch=0},setKeys(v){keys=v},setStick(v){aimStick=v},setMode(v){mode=v}}`,context);
const t=context.test;
// Legacy portal-route scenarios now explicitly accept the new mandatory reward.
function settleRewards(){vm.runInContext('showReward()',context);for(let n=0;n<30&&t.state.mode==='upgrade';n++)nodes.get('#cards').children[0].onclick()}
const originalActivate=t.activatePortal;t.activatePortal=()=>{originalActivate();const mini=t.state.enemies.find(e=>e.miniboss&&e.hp>0);if(mini)t.hurtEnemy(mini,1e6);settleRewards()};
assert.equal(typeof document.querySelector('#deathSkull').onclick,'function','The red skull must enable Death Mode from the menu');
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
 t.start();const e=t.spawnEnemy(type);e.x=0;e.z=type==='brute'?2:7;e.spawn=0;e.cool=-1;t.enemyUpdate(e,.016);
 if(type==='gunner'){assert.equal(t.state.shots.length,0);t.enemyUpdate(e,.3);assert.equal(t.state.shots.length,3)}
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
const dayAmbient=t.ambient.intensity,daySun=t.sun.intensity;t.setNightmare(true);
assert.ok(t.ambient.intensity>=1&&t.sun.intensity<daySun,'Nightmare keeps useful fill light');assert.ok(t.storm.group.visible);
assert.ok(t.scene.fog.far<80&&t.scene.fog.near>=36,'Thick fog preserves the nearby play area');
t.storm.update(.04,1,t.state.player,t.height(t.state.player.x,t.state.player.z));
assert.ok(Array.from(t.storm.rain.geometry.attributes.position.array).every(Number.isFinite));
t.setNightmare(false);assert.equal(t.ambient.intensity,dayAmbient);assert.equal(t.storm.group.visible,false);assert.equal(t.storm.light.intensity,0);
console.log('PASS: portal routes, compass bearings, Nightmare storm/fog, and clean return to normal lighting.');

t.start();const sniper=t.spawnEnemy('sniper');sniper.x=0;sniper.z=18;sniper.spawn=0;sniper.cool=-1;
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
 assert.equal(t.storm.group.children.length,3);assert.equal(lightingCount(),initialLights,'Stage rebuild must not leak lights');
 for(const kind of Object.keys(ENEMY_TYPES)){const e=t.spawnEnemy(kind);assert.ok(Number.isFinite(e.c.g.position.y));assert.ok(Math.abs(e.c.g.position.y-t.height(e.x,e.z))<1e-6)}
 if(stage<5){t.activatePortal();t.enterStage()}
}
t.start();assert.equal(lightingCount(),initialLights);assert.equal(t.storm.group.children.length,3);
console.log('PASS: elevated projectile/enemy placement, all enemy types in all stages, constant light/weather counts through stage rebuilds and restart.');

t.start();t.fire();
vm.runInContext('globalThis.shotTest={updateShots}',context);
const freeShot=t.state.shots[0];Object.assign(freeShot,{x:25,y:100,z:17,vx:37,vy:-2,vz:21});
const previousGround=t.height(freeShot.x,freeShot.z);context.shotTest.updateShots(.2);
assert.ok(Math.abs(freeShot.y-99.6)<1e-9,'Flight uses persistent world height and vertical velocity');
assert.ok(Math.abs(freeShot.x-32.4)<1e-9&&Math.abs(freeShot.z-21.2)<1e-9);
assert.notEqual(t.height(freeShot.x,freeShot.z),previousGround,'Trajectory test crosses changing terrain');
assert.equal(freeShot.m.position.y,freeShot.y,'Rendered tracer matches physical bullet height');
console.log('PASS: integrated projectile flight crosses changing terrain without resampling its altitude.');
// Short creatures should accept a normal-height shot on level ground.
t.start();const crawler=t.spawnEnemy('skitter',{x:0,z:4});t.setAim(0);const crawlerHp=crawler.hp;t.fire();for(let i=0;i<10;i++)context.shotTest.updateShots(.016);assert.ok(crawler.hp<crawlerHp,'A level rifle shot must hit the crawler standard-height hitbox');

// The public entry path must collect a fresh username, including after a retry.
t.start(true);nodes.get('#start').onclick();
assert.equal(nodes.get('#playerName').value,'','Every run asks for a fresh username');
nodes.get('#playerName').value='   ';nodes.get('#runForm').onsubmit({preventDefault(){}});
assert.equal(t.state.mode,'menu','Whitespace usernames cannot start a run');
assert.ok(nodes.get('#usernameError').textContent);
nodes.get('#playerName').value='  Ash Runner  ';nodes.get('#runForm').onsubmit({preventDefault(){}});
assert.equal(t.state.mode,'play');
const sent=[],scoreReads=[];context.fetch=async(url,options)=>{if(options?.method==='POST')sent.push(JSON.parse(options.body));else scoreReads.push(url);return {ok:true,json:async()=>({scores:[{name:'Ash Runner',score:90,stage:3,played_at:Date.UTC(2026,8,26,12),gameplay_version:'campaign-2',death_mode:false}],capabilities:{modeFilter:true}})}};
t.update(1.2);nodes.get('#playerName').value='Changed later';t.finishRun(false);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(sent.at(-1).name,'Ash Runner','Saved name belongs to the run, not a mutable input');
assert.equal(sent.at(-1).death_mode,false);assert.ok(sent.at(-1).seconds>=1);assert.equal(sent.at(-1).stage,1);assert.ok(Math.abs(sent.at(-1).played_at-Date.now())<2000);
nodes.get('#start').onclick();assert.equal(nodes.get('#playerName').value,'','Play Again also clears the username');t.closePanel();
await nodes.get('#refreshLeaderboard').onclick();
assert.match(scoreReads.at(-1),/\?mode=normal&version=all$/,'The board combines gameplay versions within Normal');
assert.deepEqual(nodes.get('#leaderboardRows').children.at(-1).children.map(c=>c.textContent),['Ash Runner','90','3',new Date(Date.UTC(2026,8,26,12)).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})]);
assert.equal(nodes.get('#leaderboardRows').children[0].children[0].children[0].src,'assets/trophy-gold.svg');
assert.equal(nodes.get('#leaderboardRows').children[0].children[0].children.at(-1).textContent,'VERSION campaign-2');
console.log('PASS: username required every run, trimmed run identity, score submission and Player/Score/Stage/Date rows.');

vm.runInContext('globalThis.deathTest={setDeathMode,hurtPlayer,audio,get state(){return {menuDeath,runDeath,runTuning}}}',context);
const death=context.deathTest,esc=()=>listeners.get('keydown')({code:'Escape',preventDefault(){}}),skull=nodes.get('#deathSkull');
t.start(true);skull.onclick();assert.equal(death.state.menuDeath,true);esc();assert.equal(death.state.menuDeath,false);
skull.onclick();nodes.get('#start').onclick();esc();assert.equal(death.state.menuDeath,false,'Esc during pre-run username entry returns to normal');
skull.onclick();nodes.get('#start').onclick();nodes.get('#playerName').value='Doom';nodes.get('#runForm').onsubmit({preventDefault(){}});
assert.equal(death.state.runDeath,true);assert.equal(death.state.runTuning.damage,1.5);
esc();assert.equal(t.state.mode,'pause');assert.equal(death.state.runDeath,true,'Escape pauses without reducing difficulty');
assert.equal(death.setDeathMode(false),false,'A live run cannot change difficulty');
t.openPanel('#settings');esc();assert.equal(t.state.mode,'pause');assert.equal(death.state.runDeath,true);esc();
t.state.player.inv=0;death.hurtPlayer(10);assert.equal(t.state.player.hp,85,'Death damage is multiplied exactly once');
const faster=t.spawnEnemy('charger');Object.assign(faster,{x:0,z:3,cool:10,spawn:0});t.enemyUpdate(faster,.05);const fastDistance=Math.hypot(faster.x,faster.z-3);
t.setMode('menu');death.setDeathMode(false);t.start();t.state.player.inv=0;death.hurtPlayer(10);assert.equal(t.state.player.hp,90);
const ordinary=t.spawnEnemy('charger');Object.assign(ordinary,{x:0,z:3,cool:10,spawn:0});t.enemyUpdate(ordinary,.05);assert.ok(fastDistance>Math.hypot(ordinary.x,ordinary.z-3)*1.3,'Death enemies move faster on the same surface');
for(let stage=1;stage<=5;stage++){
 const normal=enemyPool(['runner','brute'],false,stage),hard=enemyPool(normal,true,stage);
 assert.ok(normal.every(k=>!DEATH_TYPES[k]));assert.ok(hard.includes('revenant')&&hard.includes('hexer'));assert.equal(hard.includes('broodmother'),stage>1);
}
t.setMode('menu');death.setDeathMode(true);
for(const kind of Object.keys(DEATH_TYPES)){
 t.start();const e=t.spawnEnemy(kind);Object.assign(e,{x:0,z:6,cool:-1,spawn:0});t.enemyUpdate(e,.016);assert.equal(e.state,'deathWindup');assert.equal(t.state.hazards.length,0);
 t.enemyUpdate(e,1.3);
 if(kind==='revenant'){assert.equal(e.state,'deathRush');const before={x:e.x,z:e.z};t.enemyUpdate(e,.1);assert.ok(Math.hypot(e.x-before.x,e.z-before.z)>1,'Revenant rush travels after its warning')}
 if(kind==='hexer'){assert.equal(t.state.hazards.length,5);assert.ok(t.state.hazards.every(h=>h.kind==='hex'),'Hexer marks a delayed cross attack')}
 if(kind==='broodmother'){assert.equal(t.state.enemies.filter(m=>m.kind==='skitter').length,3,'Broodmother releases crawlers');for(let i=0;i<8;i++){e.state='approach';e.spawn=0;e.cool=-1;t.enemyUpdate(e,.016);t.enemyUpdate(e,1.3)}assert.ok(t.state.enemies.filter(m=>m.kind==='skitter').length<=8,'Summons remain bounded')}
}
for(const kind of [...Object.keys(ENEMY_TYPES),...Object.keys(DEATH_TYPES),'warden']){
 const model=retroCharacter(kind,()=>{throw Error('Monsters must not carry player firearms')});assert.equal(model.monster,true);assert.equal(model.gunMount.visible,false);
 model.g.traverse(o=>{assert.ok(o.position.toArray().every(Number.isFinite));assert.ok(o.scale.toArray().every(Number.isFinite))});
}
// Inspect the actual note scheduler, with audio output replaced by note capture.
// A failed score save keeps its original run mode, even after a different menu selection.
t.start();t.update(1.2);const attempts=[];let failSave=true;
context.fetch=async(url,options)=>{if(options?.method==='POST'){attempts.push(JSON.parse(options.body));if(failSave)throw new Error('offline')}return {ok:true,json:async()=>({scores:[{name:'Doom',score:200,stage:1,death_mode:true},{name:'Crypt',score:150,stage:1,death_mode:true},{name:'Ash',score:90,stage:1,death_mode:true},{name:'Old',score:80,stage:1,death_mode:null},{name:'Other',score:70,stage:1,death_mode:false}],capabilities:{modeFilter:true}})}};
t.finishRun(false);await new Promise(resolve=>setImmediate(resolve));
assert.equal(attempts[0].death_mode,true);death.setDeathMode(false);t.start(true);failSave=false;
await nodes.get('#retryScore').onclick();assert.deepEqual(attempts[1],attempts[0],'Retry preserves the complete Death Mode run');
await nodes.get('#boarddeath').onclick();await nodes.get('#refreshLeaderboard').onclick();const rows=nodes.get('#leaderboardRows').children;
assert.equal(rows.length,3);assert.ok(rows.every(r=>r.children.length===4));
assert.equal(rows[0].children[0].children[0].src,'assets/trophy-gold.svg');
assert.equal(rows[1].children[0].children[0].src,'assets/trophy-silver.svg');
assert.equal(rows[2].children[0].children[0].src,'assets/trophy-bronze.svg');
assert.equal(rows[0].children[0].children[1].src,'assets/death-skull.png');assert.equal(rows[0].children[0].children[1].alt,'Death Mode');
console.log('PASS: immutable Death Mode score on offline retry, top-three trophy sprites, and Death skull beside player.');

const notes=[];death.audio.music={gain:{value:.7}};death.audio.tone=()=>{};death.audio.ctx={state:'running',currentTime:0,resume(){return Promise.resolve()}};death.audio.score={schedule:(step,time,mode,volume)=>notes.push({step,time,mode,volume,events:scoreEvents(step,mode)})};
t.setMode('menu');death.setDeathMode(true);t.start();death.audio.tick();const deathNotes=notes.slice(),deathSpacing=death.audio.next/death.audio.step;
t.setMode('menu');death.setDeathMode(false);t.start();notes.length=0;death.audio.tick();
assert.ok(deathSpacing<death.audio.next/death.audio.step);assert.notDeepEqual(deathNotes[0].events,notes[0].events);
notes.length=0;death.audio.ctx.currentTime=600;death.audio.tick();assert.ok(notes.length<=2,'Background catchup must not schedule a burst of stale notes');
assert.ok(notes.every(n=>n.time>=600));
notes.length=0;t.prefs.muted=true;death.audio.tick();assert.equal(notes.length,0);t.prefs.muted=false;
t.start(true);death.audio.ctx.currentTime+=1;death.audio.tick();assert.ok(notes.length>0,'Unlocked main menu keeps its music during the CPU demo');
console.log('PASS: distinct mode arrangements and tempos, bounded audio catchup, mute and unlocked menu music.');

vm.runInContext('globalThis.trainingTest={get state(){return {tutorial,terrain,runId,runDeath,pending:pendingScores.size}}}',context);
const training=context.trainingTest;let tutorialPosts=0;context.fetch=async()=>{tutorialPosts++;return {ok:true,json:async()=>({scores:[]})}};
t.setMode('menu');death.setDeathMode(true);nodes.get('#tutorial').onclick();assert.equal(training.state.runDeath,false);assert.equal(training.state.runId,null);assert.equal(training.state.terrain.tutorial,true);assert.equal(t.state.stageGoal,5);assert.equal(t.state.enemies.length,0);
t.setKeys({KeyW:true});for(let i=0;i<100;i++)t.update(.016);t.setKeys({});assert.equal(training.state.tutorial.step,'dash');t.dash();assert.equal(training.state.tutorial.step,'shoot');t.fire();assert.equal(training.state.tutorial.step,'weapon');t.equip(1);assert.equal(training.state.tutorial.step,'combat');assert.equal(t.state.enemies.length,5);assert.ok(t.state.enemies.every(e=>['runner','skitter'].includes(e.kind)&&e.def.speed===1&&e.def.damage===3));
for(let i=0;i<4;i++)t.hurtEnemy(t.state.enemies[i],1000);assert.equal(t.state.portalActive,false);t.hurtEnemy(t.state.enemies[4],1000);assert.equal(t.state.portalActive,true);assert.equal(training.state.tutorial.step,'rift');
const trainingPortal=t.state.portal;for(let i=0;i<1000&&Math.hypot(t.state.player.x-trainingPortal.x,t.state.player.z-trainingPortal.z)>2.5;i++){const dx=trainingPortal.x-t.state.player.x,dz=trainingPortal.z-t.state.player.z,d=Math.hypot(dx,dz);t.moveWithCollision(t.state.player,dx/d*.12,dz/d*.12,.45)}t.update(.016);assert.equal(t.state.mode,'menu');assert.equal(training.state.tutorial,null);assert.equal(tutorialPosts,0);assert.equal(nodes.get('#runSummary').textContent,'TUTORIAL COMPLETE');
nodes.get('#tutorial').onclick();assert.equal(training.state.tutorial.step,'move');t.pause();nodes.get('#endRun').onclick();assert.equal(t.state.mode,'menu');assert.equal(tutorialPosts,0);nodes.get('#start').onclick();assert.equal(nodes.get('#playerName').value,'');t.closePanel();t.start();assert.equal(training.state.terrain.tutorial,false);assert.equal(t.state.stageGoal,12);
console.log('PASS: tutorial controls, unique walkable courtyard, five easy enemies, exact five-kill rift, completion/abort/replay, no leaderboard submission and clean normal restart.');

vm.runInContext('globalThis.encounterTest={interact,dropPowerup,updatePowerups,get state(){return {boons,powerups,statueWorld,difficultyBonus}}}',context);
const encounter=context.encounterTest;t.start();const statue=encounter.state.statueWorld.statues[1];assert.ok(statue,'A run must have an optional statue');const tough=t.spawnEnemy('runner');const maxBefore=tough.max;t.state.player.x=statue.x+2;t.state.player.z=statue.z;listeners.get('keydown')({code:t.prefs.bindings.interact,preventDefault(){}});nodes.get('#cards').children[0].onclick();assert.equal(encounter.state.difficultyBonus,5);assert.equal(tough.max,maxBefore*1.05);encounter.interact();assert.equal(encounter.state.difficultyBonus,5,'A statue activates once');assert.equal(nodes.get('#difficultyMeter').textContent,'Statue curse: 105%');
for(const kind of Object.keys(POWERUPS)){encounter.dropPowerup(t.state.player.x,t.state.player.z,kind);encounter.updatePowerups(.016);if(kind!=='heal')assert.ok(encounter.state.boons[kind]>0)}assert.equal(encounter.state.powerups.length,0);assert.ok(encounter.state.boons.shield>0);
const doomed=t.spawnEnemy('brute');t.hurtEnemy(doomed,1);assert.ok(doomed.hp<=0);const warden=t.spawnEnemy('warden'),bossHp=warden.hp;t.hurtEnemy(warden,1);assert.equal(warden.hp,bossHp-1.5,'Insta kill cannot bypass a boss');
t.state.player.inv=0;const protectedHp=t.state.player.hp;death.hurtPlayer(10);assert.equal(t.state.player.hp,protectedHp);t.activatePortal();t.enterStage();assert.equal(encounter.state.difficultyBonus,5,'Statue difficulty persists through the rift');t.start();assert.equal(encounter.state.difficultyBonus,0);assert.ok(Object.values(encounter.state.boons).every(v=>v===0));assert.equal(encounter.state.powerups.length,0);
console.log('PASS: F interaction, one-use statues, additive difficulty, pickups, shield, boss-safe insta kill, stage persistence and clean reset.');
