import {updateCutaway} from './occlusion.js?v=16';
import {BuildFeedback,WEAPON_FEEDBACK} from './combat-feedback.js?v=16';
import {dangerMarker,disposeMarker,chargePath} from './warnings.js?v=16';
import {ScoreOutbox} from './score-outbox.js?v=16';
import {compareRun} from './run-history.js?v=16';
import {UPGRADE_INFO,shotStats,applyUpgrade,upgradePreview} from './upgrades.js?v=16';
import {loadProfile,saveProfile,award,recordEnemy,equipCosmetic,rememberRun,BESTIARY} from './profile.js?v=16';
import {CHALLENGE,NodeCharge,quarryImpact,anchorMultiplier} from './challenges.js?v=16';
import {DashEffects} from './dash-traits.js?v=16';
import {SkullTrial,TRIAL_NAMES,trialLocations} from './trials.js?v=16';
import {CombatEffects} from './combat-effects.js?v=16';
import {createBuild,RewardQueue,MODS,DASH_TRAITS,modOffer,shuffled,BALANCE,GAMEPLAY_VERSION} from './progression.js?v=16';
import {SimulationClock,PadMenu} from './simulation.js?v=16';
import {POWERUPS,DROP_LIFETIME,MAX_DROPS,STATUE_BONUS,rollPowerup,createBoons,collectBoon,tickBoons,absorbDamage,createStatues} from './encounters.js?v=16';
import {createTutorial,tutorialCopy,TUTORIAL_PORTAL,TUTORIAL_GOAL} from './tutorial.js?v=16';
import {createStorm} from './storm.js?v=16';
import {createMusicPlayer,MusicIntensity} from './soundtrack.js?v=16';
import {renderHeight,fogRange,FramePacer} from './graphics.js?v=16';
import * as T from 'three';
import {traceWorld,hitBody,pointAt} from './ballistics.js?v=16';
import {retroMaterial,retroCharacter,retroResolution,RetroShader} from './retro.js?v=16';
import {ShaderPass} from './vendor/postprocessing/ShaderPass.js';
import { createTerrain, randomSource } from './terrain.js?v=16';
import { buildStageWorld } from './scenery.js?v=16';
import { EffectComposer } from './vendor/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/postprocessing/RenderPass.js';
import { OutputPass } from './vendor/postprocessing/OutputPass.js';
import { WEAPONS, ENEMY_TYPES, DEATH_TYPES, RUN_MODES, enemyPool, segmentHit, movementVector } from './rules.js?v=16';
import { DEFAULT_BINDINGS, ACTION_LABELS, keyLabel, loadPreferences, assignBinding } from './preferences.js?v=16';

const $ = s => document.querySelector(s);
let encounterObjects=[],vents=[],nodeCharge=null,quarryState='dormant';
let trial=null,trialCount=0,statueCount=0,decisionSerial=0;
const debugLocal=['127.0.0.1','localhost'].includes(window.location?.hostname);
const debugScenario=debugLocal?new URLSearchParams(window.location.search).get('scenario'):null;
let storage;try{storage=debugScenario||window.__RIFTBORN_TEST__?null:window.localStorage}catch{}
let profileSaved=!!storage;
let profile=loadProfile(storage),newMilestones=[],lastSummary=null,boardMode='normal',boardVersion='current',boardRequest=0;
function realProgress(){return !demoActive&&!tutorial&&!debugScenario&&!window.__RIFTBORN_TEST__}
function persistProfile(){profileSaved=saveProfile(storage,profile);return profileSaved}
function milestone(key){if(award(profile,key,realProgress())){newMilestones.push(key);persistProfile()}}
let build=createBuild(),rewards=new RewardQueue(),activeReward=null,quarryRewarded=false;
let combatEffects,dashEffects;
const buildFeedback=new BuildFeedback();
function buildCue(type){if(!demoActive&&buildFeedback.emit(type))audio.fx(type==='echoReady'?'switch':'proc')}
let prefs;try{prefs=loadPreferences(window.localStorage)}catch{prefs=loadPreferences(null)}
function savePrefs(){try{window.localStorage.setItem('neon-crypt-preferences-v1',JSON.stringify(prefs))}catch{}}
let runRandom=Math.random;
const rand = (a,b) => a + runRandom()*(b-a);
const clamp = T.MathUtils.clamp, lerp = T.MathUtils.lerp;
const mobile = matchMedia('(pointer:coarse)').matches;
const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;
const canvas = $('#game');
const renderer = new T.WebGLRenderer({canvas, antialias:false, powerPreference:'high-performance'});
renderer.setPixelRatio(1);
// RENDERING — internal pixel resolution. The canvas is enlarged with nearest-neighbor scaling.
function retroSize(){const h=renderHeight(prefs.pixelation,mobile,qualityReduced),w=Math.round(h*innerWidth/innerHeight);renderer.setSize(w,h,false);retroResolution.set(w,h);return {w,h}}
let qualityReduced=false;const resolution=retroSize();
renderer.shadowMap.enabled = false;
renderer.info.autoReset=false;
renderer.shadowMap.type = T.PCFSoftShadowMap;
renderer.toneMapping = T.NoToneMapping;
renderer.toneMappingExposure = 1.3;
const scene = new T.Scene();
scene.background = new T.Color('#89b4e2');
scene.fog = new T.Fog('#89b4e2',65,165);
const camera = new T.PerspectiveCamera(47,innerWidth/innerHeight,.1,230);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene,camera));
composer.addPass(new OutputPass());const retroPass=new ShaderPass(RetroShader);composer.addPass(retroPass);composer.setSize(resolution.w,resolution.h);
const ambient=new T.HemisphereLight('#c9e5ff','#596651',2.6);scene.add(ambient);
const sun = new T.DirectionalLight('#ffe0ac',3.6);sun.position.set(-24,45,18);sun.castShadow=true;
sun.shadow.mapSize.set(mobile?1024:2048,mobile?1024:2048);
Object.assign(sun.shadow.camera,{left:-33,right:33,top:33,bottom:-33,near:1,far:100});
sun.shadow.bias=-.0004;sun.shadow.normalBias=.035;scene.add(sun,sun.target);
const rim = new T.DirectionalLight('#a791ff',1.8);rim.position.set(30,15,-40);scene.add(rim);
const flashLight = new T.PointLight('#ffcf67',0,11,2);scene.add(flashLight);
const world = new T.Group(), actors = new T.Group(), effects = new T.Group();scene.add(world,actors,effects);
const mats = new Map(), geo = {box:new T.BoxGeometry(1,1,1),ico:new T.IcosahedronGeometry(1,0),sphere:new T.SphereGeometry(1,10,7),gem:new T.OctahedronGeometry(1,0),ring:new T.RingGeometry(.9,1,12),torus:new T.TorusGeometry(1,.08,6,32),cylinder:new T.CylinderGeometry(1,1,1,8)};
// SHARED MESH HELPERS — cache materials/geometry so transient effects do not allocate every frame.
function material(color,glow=0){let key=color+':'+glow;if(!mats.has(key))mats.set(key,glow>0?new T.MeshBasicMaterial({color}):retroMaterial(color,3));return mats.get(key)}
function mesh(shape,color,x,y,z,sx=1,sy=sx,sz=sx,parent=world,glow=0){const m = new T.Mesh(geo[shape],material(color,glow));m.position.set(x,y,z);m.scale.set(sx,sy,sz);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m}
let tutorial=null,statueWorld=null,difficultyBonus=0,powerups=[],boons=createBoons();
let runSeed=7361, terrain=createTerrain(1,runSeed), stageWorld=null;
function height(x,z){return terrain.height(x,z)}

const PORTAL_RADIUS=3.5;
const storm=createStorm({mobile,reduced});scene.add(storm.group);
let stagePortal=null,portalLight=null,portalActive=false;
const STAGES=[
 {name:'MEADOWS',sky:'#89b4e2',fog:'#89b4e2',hue:.32,portal:[0,-30],pool:['runner','skitter','gunner'],goal:12},
 {name:'SHATTERED QUARRY',sky:'#7f8db6',fog:'#65708f',hue:.64,portal:[27,-19],pool:['runner','skitter','gunner','charger','sniper'],goal:22},
 {name:'EMBER CALDERA',sky:'#574464',fog:'#3b263e',hue:.04,portal:[-28,22],pool:['charger','brute','mortar','leaper','splitter'],goal:34},
 {name:'AURORA CITADEL',sky:'#273c70',fog:'#182449',hue:.72,portal:[6,34],pool:['sniper','leaper','splitter','stormer','brute'],goal:48},
 {name:'THE VOID CROWN',sky:'#130e34',fog:'#0b0820',hue:.78,portal:[-34,-20],pool:['stormer','mortar','brute','sniper','leaper'],goal:64}
];
let stage=1,stageKills=0,stageGoal=STAGES[0].goal,bossSpawned=false,victory=false,hitMarker=0;

function portalBearing(dx,dz,yaw){return Math.atan2(Math.sin(yaw)*dx+Math.cos(yaw)*dz,Math.cos(yaw)*dx-Math.sin(yaw)*dz)}
function buildWorld(){
 stagePortal=new T.Group();stagePortal.visible=false;world.add(stagePortal);
 const tor=new T.Mesh(new T.TorusGeometry(3.1,.37,5,8),material('#9a7cff',2.6));stagePortal.add(tor);
 stagePortal.add(new T.Mesh(new T.TorusGeometry(2.5,.08,4,12),material('#d9a7ff',4)));
 stagePortal.add(new T.Mesh(new T.IcosahedronGeometry(1.6,1),material('#812bff',3)));
 portalLight=new T.PointLight('#9e5cff',0,18,2);stagePortal.add(portalLight);
 setStageDecor();
}
buildWorld();

// LIGHTING — adjust ambient/sun/rim here; Nightmare color grading lives in retro.js.
function applyLighting(){
 const s=STAGES[stage-1]||STAGES.at(-1),nightmare=prefs.nightmare;
 if(retroPass.uniforms)retroPass.uniforms.nightmare.value=nightmare?1:0;
 scene.background=new T.Color(nightmare?'#111927':s.sky);scene.fog.color.set(nightmare?'#344355':s.fog);Object.assign(scene.fog,fogRange(prefs.fog,nightmare));
 ambient.intensity=nightmare?1.16:1.05;ambient.color.set(nightmare?'#b1bfd0':'#c9e5ff');ambient.groundColor.set(nightmare?'#818b95':'#596651');
 sun.color.set(nightmare?'#c0cddd':'#ffe0ac');sun.intensity=nightmare?1.02:1.25;rim.color.set(nightmare?'#869baa':'#a791ff');rim.intensity=nightmare?.5:.4;
 storm.setEnabled(nightmare);flashLight.intensity=0;
}

// WORLD LIFECYCLE — dispose stage-owned scenery, then rebuild terrain, statues and the portal.
function setStageDecor(){
 statueWorld?.dispose();statueWorld=null;stageWorld?.dispose();terrain=createTerrain(stage,runSeed,{tutorial:!!tutorial});stageWorld=buildStageWorld(terrain);world.add(stageWorld.group);if(!tutorial){statueWorld=createStatues(terrain,stageWorld,runSeed+stage*107);world.add(statueWorld.group)}trial=(!tutorial&&stage<5)?new SkullTrial(stage):null;if(trial&&statueWorld.statues[0])statueWorld.statues[0].rewarded=true;
 const [px,pz]=tutorial?TUTORIAL_PORTAL:STAGES[stage-1].portal;stagePortal.position.set(px,height(px,pz)+2.7,pz);stagePortal.rotation.set(0,0,0);stagePortal.visible=portalActive;
 applyLighting();
}
// PROGRESSION — called when the kill goal is reached; the final stage summons the boss.
function activatePortal(){if(stage===1&&!demoActive&&!tutorial)rewards.add('dash-trait','dash');if(stage===2&&!demoActive&&!tutorial&&quarryState!=='rewarded'){if(quarryState==='dormant'||quarryState==='waiting')startQuarry();return}if(stage===STAGES.length){summonBoss();return}if(portalActive)return;portalActive=true;stagePortal.visible=true;toast(tutorial?'TRAINING RIFT OPEN':'RIFT PORTAL OPEN · '+STAGES[stage-1].name);for(let i=0;i<90;i++){const [x,z]=tutorial?TUTORIAL_PORTAL:STAGES[stage-1].portal;burst(x,rand(.8,6),z,'#b974ff',1,3)}audio.fx('level');updateHUD()}
// RIFT ENTRY — tutorials finish here; normal runs retain upgrades and statue difficulty.
function enterStage(){if(!portalActive||activeReward||rewards.pending)return;combatEffects?.clear();dashEffects?.clear();buildFeedback.clear();abandonTrial();clearChallenges();quarryState='dormant';if(tutorial){finishTutorial(true);return}if(stage>=STAGES.length)return;for(const g of gems)player.xp+=g.v;for(const p of powerups)effects.remove(p.m);powerups=[];clearInput();player.vx=player.vz=0;player.dashing=0;player.inv=2;stage=Math.min(stage+1,STAGES.length);stageKills=0;stageGoal=STAGES[stage-1]?.goal||stageGoal+18;portalActive=false;for(const e of enemies)removeEnemy(e);clearObjects(shots);clearObjects(hazards);clearObjects(gems);clearObjects(particles);clearObjects(rings);particles=[];rings=[];numbers.forEach(n=>n.el.remove());numbers=[];enemies=[];shots=[];hazards=[];gems=[];player.x=0;player.z=0;player.hp=Math.min(player.max,player.hp+25);setStageDecor();toast('STAGE '+stage+' · '+STAGES[stage-1].name+' · SHARDS COLLECTED · +25 HEALTH');audio.fx('level');burst(0,1,0,'#d3a0ff',40,5);updateHUD()}

// WEAPON VISUALS — builds the low-poly weapon carried by the player.
function weaponModel(index,parent){
 const w=WEAPONS[index],g=new T.Group();parent.add(g);
 mesh('box','#253549',0,0,.18,.22,.25,.8,g);mesh('box',w.color,0,.04,.27,.25,.17,.46,g,.25);
 mesh('box','#192b3d',0,-.19,.03,.12,.32,.17,g);mesh('box','#65798c',0,0,.72,.09,.09,.42,g);
 if(index===1){g.scale.set(.85,.85,.85);mesh('box',w.color,0,.17,.2,.1,.08,.3,g)}
 if(index===2){mesh('box','#706681',.1,0,.64,.11,.13,.7,g);mesh('box','#706681',-.1,0,.64,.11,.13,.7,g)}
 if(index===3){mesh('box','#243951',0,.23,.13,.17,.15,.32,g);mesh('box',w.color,0,.02,.68,.17,.16,.9,g,.9)}
 if(index===4){g.clear();let tube=mesh('cylinder','#536c4c',0,0,.3,.24,1.1,.24,g);tube.rotation.x=Math.PI/2;mesh('box','#dca651',0,.12,.35,.38,.13,.7,g);mesh('box','#243340',0,-.25,.2,.15,.3,.17,g)}
 return g;
}
function character(kind='player'){return retroCharacter(kind,weaponModel)}
function animateCharacter(c,time,speed,recoil=0){time=Math.floor(time*15)/15;const stride=Math.sin(time*(c.crawler?15:9));c.legs[0].rotation.x=stride*.65*speed;c.legs[1].rotation.x=-c.legs[0].rotation.x;c.body.position.y=c.floating?.12+Math.sin(time*3)*.12:Math.abs(stride)*.06*speed;if(c.monster){c.arms.forEach((a,i)=>a.rotation.x=c.armPose+Math.sin(time*9+i*Math.PI)*.25*speed);c.appendages.forEach((a,i)=>a.rotation.z=Math.sin(time*6+i)*.18);return}c.arms[0].rotation.x=-.6+stride*.18*speed;c.arms[1].rotation.x=-1.15-recoil*.5;c.gunMount.position.z=.48-recoil*.14}
const hero=character();actors.add(hero.g);
const heroRing=new T.Mesh(new T.RingGeometry(.63,.69,12),new T.MeshBasicMaterial({color:'#a2fff1',transparent:true,opacity:.55,side:T.DoubleSide}));heroRing.rotation.x=-Math.PI/2;scene.add(heroRing);
let demoActive=false,demoFinished=false,demoAge=0,demoWeaponTime=0,demoStage=1,demoInput={x:0,z:0},demoFiring=false;
let player,mode='menu',elapsed=0,wave=1,score=0,kills=0,spawnTimer=0,shake=0,hit=0,recoil=0;
let menuDeath=false,runDeath=false,runTuning=RUN_MODES.normal,skullTime=0,skullHeld=false;
function setDeathMode(enabled){
 if(!['menu','dead'].includes(mode))return false;
 menuDeath=!!enabled;document.body.classList.toggle('death-mode',menuDeath);
 $('#modeBadge').textContent=menuDeath?'DEATH MODE':'';$('#deathSkull').setAttribute('aria-pressed',String(menuDeath));
 $('#deathSkull').setAttribute('aria-label',menuDeath?'Death Mode selected. Return to normal mode':'Enter Death Mode');
 $('#usernameTitle').textContent=menuDeath?'DEATH MODE':'NEW RUN';demoFinished=true;return true;
}
function escapeMenu(){if(activeReward?.preview){$('#cards').lastElementChild?.click();return}if(['menu','dead'].includes(mode)&&(!overlay||overlay==='#runSetup')&&menuDeath){if(overlay)closePanel();setDeathMode(false);return}pause()}
function updateSkull(dt){if(!['menu','dead'].includes(mode)||overlay)return;if(!reduced&&!skullHeld)skullTime+=dt;const x=.5+Math.sin(skullTime*.23+.8)*.39,y=.5+Math.cos(skullTime*.23+.8)*.38;$('#deathSkull').style.left=Math.round(12+x*Math.max(0,innerWidth-104))+'px';$('#deathSkull').style.top=Math.round(12+y*Math.max(0,innerHeight-104))+'px'}
$('#deathSkull').onclick=()=>setDeathMode(!menuDeath);
$('#deathSkull').onpointerenter=$('#deathSkull').onfocus=()=>skullHeld=true;
$('#deathSkull').onpointerleave=$('#deathSkull').onblur=()=>skullHeld=false;
let enemies=[],shots=[],particles=[],gems=[],hazards=[],rings=[],numbers=[];
let shotSerial=0,runDamage=[0,0,0,0,0],lethalSource=null;
let equippedIndex=-1;
let selected=0,cameraYaw=.35,cameraDistance=25,aim=0,aimPitch=0,fireTimer=0,toastTimer;
let touchFire=false,overlay=null,overlayReturn='menu',bindingAction=null,runId=null,runName='Player',pendingScores=new Map(),savingScores=false,padFireLocked=false;
let keys={},mouse={x:0,y:0,moved:false,down:false,orbit:false},moveStick={x:0,y:0},aimStick={x:0,y:0},gamepadAim={x:0,y:0},gamepadFire=false,prevPad=[];
const raycaster=new T.Raycaster(),floorPlane=new T.Plane(new T.Vector3(0,1,0),-1),aimPoint=new T.Vector3();
// PLAYER DEFAULTS — health, movement, weapon bonuses and dash timers reset for each run.
function freshPlayer(){return {x:0,z:0,vx:0,vz:0,hp:100,max:100,xp:0,next:10,level:1,speed:6.4,damage:1,rate:1,pierce:0,extra:0,crit:.1,magnet:3.8,dashCD:0,dashing:0,inv:0,dx:0,dz:1,regen:0}}
player=freshPlayer();
function clearObjects(list){for(const o of list)if(o.m){effects.remove(o.m);if(o.m.userData.danger)disposeMarker(o.m);else if(o.ownMat)o.m.material.dispose()}}
// RUN RESET — demo and tutorial never receive leaderboard run IDs. Clear temporary bonuses here.
function start(demo=false,training=false){
 clearChallenges();quarryState='dormant';combatEffects?.clear();dashEffects?.clear();buildFeedback.clear();build=createBuild();rewards=new RewardQueue();activeReward=null;quarryRewarded=false;trialCount=statueCount=0;newMilestones=[];
 runDamage=[0,0,0,0,0];lethalSource=null;shotSerial=0;
 for(const p of powerups)effects.remove(p.m);powerups=[];boons=createBoons();difficultyBonus=0;
 tutorial=training?createTutorial():null;document.body.classList.toggle('tutorial-active',training);$('#tutorialGuide').classList.toggle('hidden',!training);$('#endRun').textContent=training?'EXIT TUTORIAL':'END RUN & SAVE SCORE';
 runDeath=!training&&menuDeath;runTuning=runDeath?RUN_MODES.death:RUN_MODES.normal;
 demoActive=demo===true;demoFinished=false;demoAge=0;demoWeaponTime=0;demoInput={x:0,z:0};demoFiring=false;
 clearInput();runId=demoActive||tutorial||debugScenario?null:crypto.randomUUID();runName=demoActive?'CPU':($('#playerName').value||'').trim().slice(0,16)||'Player';if(realProgress()){profile.lastUsername=runName;persistProfile()}
 for(const e of enemies)removeEnemy(e);clearObjects(shots);clearObjects(particles);clearObjects(gems);clearObjects(hazards);clearObjects(rings);numbers.forEach(n=>n.el.remove());
 enemies=[];shots=[];particles=[];gems=[];hazards=[];rings=[];numbers=[];runSeed=(Math.random()*4294967296)>>>0;player=freshPlayer();elapsed=0;wave=1;score=0;kills=0;bossSpawned=false;victory=false;hitMarker=0;stage=1;stageKills=0;stageGoal=tutorial?TUTORIAL_GOAL:STAGES[0].goal;portalActive=false;spawnTimer=.8;fireTimer=0;selected=0;aimPitch=0;mode='play';cameraYaw=.35;cameraDistance=25;shake=hit=recoil=0;if(demoActive){stage=demoStage;stageGoal=STAGES[stage-1].goal;mode='menu';player.damage=1.6;player.rate=1.25;player.regen=3;player.hp=player.max=160}setStageDecor();if(tutorial)player.regen=20;
 if(demoActive){hero.g.visible=true;equip(0);for(let i=0;i<8;i++){const a=i*Math.PI/4;spawnEnemy(null,{x:Math.sin(a)*14,z:Math.cos(a)*14})}return}
 $('#runReport').classList.add('hidden');$('#menu').classList.add('hidden');$('#choice').classList.add('hidden');$('#pauseMenu').classList.add('hidden');hero.g.visible=true;
 document.body.classList.add('in-run');document.body.classList.remove('menu-open');
 equip(0);audio.start();if(!tutorial)toast('STAGE 1 · MEADOWS');updateHUD();
}
// WEAPON SELECTION — changes the model, highlighted slot and tutorial progress.
function equip(i){const next=(i+WEAPONS.length)%WEAPONS.length;if(next===selected&&equippedIndex===next&&hero.weapon)return;selected=next;equippedIndex=next;hero.gunMount.remove(hero.weapon);hero.weapon=weaponModel(selected,hero.gunMount);document.querySelectorAll('.weapon').forEach((b,n)=>{b.classList.toggle('active',n===selected);b.setAttribute('aria-pressed',String(n===selected))});if(mode==='play')audio.fx('switch');tutorialEvent('weapon',selected)}
WEAPONS.forEach((w,i)=>{const b=document.createElement('button');b.className='weapon';b.style.setProperty('--rarity',w.color);b.title=`${i+1}: ${w.label} — ${w.description}`;b.setAttribute('aria-label',b.title);b.innerHTML=`<span class="num">${i+1}</span><span class="weapon-sprite sprite-${i}" aria-hidden="true"></span><span class="name">${w.label}</span><span class="kind">${w.kind}</span>`;b.onclick=()=>equip(i);$('#weapons').appendChild(b)});equip(0);
function clearInput(){keys={};mouse.down=false;mouse.orbit=false;touchFire=false;gamepadFire=false;padFireLocked=true;moveStick.x=moveStick.y=aimStick.x=aimStick.y=0;for(const id of ['#moveStick','#aimStick'])$(id).querySelector('span').style.transform='none'}
function held(action){return !!keys[prefs.bindings[action]]}
// PAUSE — clear held inputs so resume cannot accidentally fire or keep moving.
function pause(){if(overlay){closePanel();return}if(mode==='play'){clearInput();mode='pause';document.body.classList.add('menu-open');$('#abandonTrial').classList.toggle('hidden',trial?.state!=='active');$('#buildSummary').textContent=buildText(true);$('#pauseStats').textContent=`STAGE ${stage} · ${score.toLocaleString()} SCORE · ${formatTime(elapsed)}`;$('#pauseMenu').classList.remove('hidden');$('#resume').focus()}else if(mode==='pause'){clearInput();mode='play';document.body.classList.remove('menu-open');$('#pauseMenu').classList.add('hidden')}}
// DASH — duration, cooldown and invulnerability are in seconds; movement still checks collision.
function dash(){if((mode!=='play'&&!demoActive)||player.dashCD>0)return;const v=inputMovement();let l=Math.hypot(v.x,v.z);player.dx=l>.1?v.x/l:Math.sin(aim);player.dz=l>.1?v.z/l:Math.cos(aim);player.dashing=.22;player.dashCD=1.8;player.inv=.35;dashEffects?.begin({x:player.x,y:height(player.x,player.z)+1.47,z:player.z});tutorialEvent('dash');burst(player.x,1,player.z,'#98ffff',25,5);audio.fx('dash')}
$('#start').onclick=()=>openPanel('#runSetup');$('#tutorial').onclick=()=>{setDeathMode(false);start(false,true)};$('#pause').onclick=pause;$('#resume').onclick=pause;$('#dashTouch').onclick=dash;$('#interactTouch').onclick=interact;
// INPUT DISPATCH — keyboard/mouse bindings from preferences.js enter gameplay here.
function trigger(code){if(code===prefs.bindings.pause){pause();return}if(mode!=='play'||overlay)return;if(code===prefs.bindings.dash)dash();if(code===prefs.bindings.interact)interact();for(let i=1;i<=5;i++)if(code===prefs.bindings['weapon'+i])equip(i-1)}
addEventListener('keydown',e=>{if(bindingAction){e.preventDefault();if(e.code==='Escape'){bindingAction=null;renderBindings();$('#bindStatus').textContent='Rebinding cancelled.'}else if(!e.repeat)captureBinding(e.code);return}if(e.code==='Escape'){e.preventDefault();escapeMenu();return}if(e.target?.matches?.('input,textarea,select'))return;if(mode!=='play'&&mode!=='pause')return;if(Object.values(prefs.bindings).includes(e.code))e.preventDefault();if(mode==='play')keys[e.code]=true;if(!e.repeat)trigger(e.code)});
addEventListener('keyup',e=>keys[e.code]=false);
addEventListener('blur',()=>{clearInput();if(mode==='play')pause()});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&mode==='play')pause()});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{if(e.pointerType!=='mouse'||mode!=='play'||overlay)return;const code='Mouse'+e.button;keys[code]=true;trigger(code);mouse.orbit=held('orbitDrag');mouse.x=e.clientX;mouse.y=e.clientY;mouse.moved=true;canvas.setPointerCapture(e.pointerId);e.preventDefault()});
canvas.addEventListener('pointermove',e=>{if(e.pointerType!=='mouse')return;if(mode==='play'&&held('orbitDrag'))cameraYaw-=e.movementX*.008;mouse.x=e.clientX;mouse.y=e.clientY;mouse.moved=true;$('#crosshair').style.left=e.clientX+'px';$('#crosshair').style.top=e.clientY+'px'});
addEventListener('pointerup',e=>{keys['Mouse'+e.button]=false;mouse.orbit=held('orbitDrag')});canvas.addEventListener('pointercancel',clearInput);
canvas.addEventListener('wheel',e=>{e.preventDefault();cameraDistance=clamp(cameraDistance+e.deltaY*.018,16,36)},{passive:false});
function bindStick(id,value){let el=$(id),pid=null;const update=e=>{let r=el.getBoundingClientRect(),x=(e.clientX-r.left-r.width/2)/40,y=(e.clientY-r.top-r.height/2)/40,l=Math.max(1,Math.hypot(x,y));value.x=x/l;value.y=y/l;el.querySelector('span').style.transform=`translate(${value.x*28}px,${value.y*28}px)`};el.onpointerdown=e=>{pid=e.pointerId;el.setPointerCapture(pid);update(e)};el.onpointermove=e=>{if(pid===e.pointerId)update(e)};el.onpointerup=el.onpointercancel=()=>{pid=null;value.x=value.y=0;el.querySelector('span').style.transform='none'}}
bindStick('#moveStick',moveStick);bindStick('#aimStick',aimStick);
$('#fireTouch').onpointerdown=e=>{if((mode!=='play'&&!demoActive)||demoFinished)return;touchFire=true;$('#fireTouch').setPointerCapture(e.pointerId);e.preventDefault()};$('#fireTouch').onpointerup=$('#fireTouch').onpointercancel=()=>touchFire=false;
// CONTROLLER INPUT — button indices: A=0, X=2, bumpers=4/5, trigger=7, menu=9.
const padMenu=new PadMenu();
function menuRoot(){return overlay?$(overlay):mode==='upgrade'?$('#choice'):mode==='pause'?$('#pauseMenu'):['menu','dead'].includes(mode)?$('#menu'):null}
function focusable(root){return [...root.querySelectorAll('button,input,select,summary')].filter(e=>!e.disabled&&!e.closest('[hidden],.hidden,[inert]')&&e.getClientRects().length)}
function pollPad(){
 const p=navigator.getGamepads?.()[0];gamepadAim={x:0,y:0};gamepadFire=false;if(!p)return;
 const rising=i=>p.buttons[i]?.pressed&&!prevPad[i],root=menuRoot();
 if(root){
  if(overlay==='#runSetup')$('#nameKeyboard').classList.remove('hidden');
  const items=focusable(root),direction=padMenu.directionAt(p,performance.now()/1000);let i=items.indexOf(document.activeElement);
  if(direction&&items.length){i=(i+direction+items.length)%items.length;items[i].focus()}
  if(rising(0)){const el=document.activeElement;if(items.includes(el)){if(el.tagName==='INPUT'&&el.type==='text'){$('#nameKeyboard').parentElement.open=true;$('#nameKeyboard button')?.focus()}else if(el.tagName==='SELECT'){el.selectedIndex=(el.selectedIndex+1)%el.options.length;el.dispatchEvent(new Event('change',{bubbles:true}))}else if(el.type==='range'){el.value=Number(el.value)+Number(el.step||5)>Number(el.max)?el.min:Number(el.value)+Number(el.step||5);el.dispatchEvent(new Event('input',{bubbles:true}))}else el.click()}else items[0]?.focus()}
  if(rising(1)){if(activeReward?.preview)$('#cards').lastElementChild?.click();else if(overlay)closePanel();else if(mode==='pause')pause();else if(mode==='menu'||mode==='dead')setDeathMode(false)}
  if(rising(9)&&mode==='pause')pause();
 }else if(mode==='play'){
  const dead=v=>Math.abs(v)>.16?v:0;gamepadAim={x:dead(p.axes[2]||0),y:dead(p.axes[3]||0)};
  if(!p.buttons[7]?.pressed)padFireLocked=false;gamepadFire=!padFireLocked&&!!p.buttons[7]?.pressed;
  if(rising(0))dash();if(rising(2))interact();if(rising(4))equip(selected-1);if(rising(5))equip(selected+1);if(rising(9))pause();
 }
 prevPad=p.buttons.map(b=>b.pressed);
}
// Gamepad-only username entry is always available; native keyboard/touch typing still works.
for(const char of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789','SPACE','DELETE']){
 const b=document.createElement('button');b.type='button';b.textContent=char;b.onclick=()=>{const el=$('#playerName');el.value=char==='DELETE'?el.value.slice(0,-1):(el.value+(char==='SPACE'?' ':char)).slice(0,16)};$('#nameKeyboard').appendChild(b);
}
function inputMovement(){if(demoActive)return demoInput;let x=(held('right')?1:0)-(held('left')?1:0),y=(held('back')?1:0)-(held('forward')?1:0);if(Math.hypot(moveStick.x,moveStick.y)>.05){x=moveStick.x;y=moveStick.y}const p=navigator.getGamepads?.()[0];if(p&&Math.hypot(p.axes[0],p.axes[1])>.17){x=p.axes[0];y=p.axes[1]}return movementVector(x,y,cameraYaw)}
function moveWithCollision(o,dx,dz,r){terrain.move(o,dx,dz,r)}
// ENEMY SPAWNING — base stats come from rules.js; training and run difficulty apply here.
function spawnEnemy(kind,near=null){
 const unlocked=enemyPool(STAGES[stage-1]?.pool||Object.keys(ENEMY_TYPES),runDeath,stage);
 kind=kind||unlocked[Math.floor(rand(0,unlocked.length))];const def=tutorial?{...ENEMY_TYPES[kind],hp:24,speed:1,damage:3,score:0,xp:0}:kind==='warden'?{hp:1300,speed:1.8,radius:1.35,damage:24,score:5000,xp:0,color:'#c78dff'}:(ENEMY_TYPES[kind]||DEATH_TYPES[kind]),a=rand(0,Math.PI*2),r=rand(17,23);
 const location=near?terrain.safeNear(near.x,near.z,def.radius):terrain.spawn(player.x,player.z,def.radius,runRandom);let {x,z}=location;
 const c=character(kind);actors.add(c.g);c.g.position.set(x,height(x,z),z);
 const difficulty=(1+(stage-1)*.22+Math.min(wave-1,20)*.05)*difficultyScale();
 const bar=document.createElement('div'),fill=document.createElement('i');bar.className='enemy-health';bar.appendChild(fill);$('#damageNumbers').appendChild(bar);
 recordEnemy(profile,kind,false,realProgress());
 enemies.push({bar,fill,warning:null,attackIndex:0,enraged:false,id:crypto.randomUUID(),kind,def,c,x,z,hp:def.hp*difficulty,max:def.hp*difficulty,cool:rand(1,2.5),state:'approach',timer:0,ax:0,az:1,hit:0,spawn:.4,phase:rand(0,10)});
 ring(x,z,'#bda3ff',1.5,.45);return enemies.at(-1);
}
function removeEnemy(e){actors.remove(e.c.g);e.bar?.remove();clearWarning(e)}
function clearWarning(e){if(e.warning){disposeMarker(e.warning);e.warning=null}}
function warnLine(e,length,color){
 clearWarning(e);let path;
 const charging=e.miniboss||['charger','revenant'].includes(e.kind);
 if(charging){const speed=(e.miniboss?CHALLENGE.quarrySpeed:e.kind==='revenant'?16:18)*runTuning.speed*difficultyScale(),duration=e.miniboss?CHALLENGE.quarryCharge:e.kind==='revenant'?.38:.68;
  path=chargePath(e,speed,duration,terrain,e.miniboss?(p,dx,dz)=>!!traceWorld({x:p.x,y:height(p.x,p.z)+1,z:p.z},{x:p.x+dx,y:height(p.x,p.z)+1,z:p.z+dz},{height:()=>-10000,covers:stageWorld.covers},e.def.radius*.8):undefined);
 }else{if(e.kind==='sniper'){const y=height(e.x,e.z)+1.47*e.c.g.scale.y;e.attackPitch=pitchTo(e.x,y,e.z,player.x,height(player.x,player.z)+1.2,player.z);const from={x:e.x,y,z:e.z},to={x:e.x+e.ax*length*Math.cos(e.attackPitch),y:y+length*Math.sin(e.attackPitch),z:e.z+e.az*length*Math.cos(e.attackPitch)};length*=Math.cos(e.attackPitch)*(traceWorld(from,to,shotWorld())?.t??1)}path=[];for(let d=0;d<=length;d+=.5)path.push([e.x+e.ax*d,e.z+e.az*d])}
 e.warning=dangerMarker(height,e.x,e.z,0,'line',path,charging?e.def.radius:.085);effects.add(e.warning);audio.fx(charging?'warnCharge':'warnAim');
}
function warnArea(e,x,z,radius,kind){clearWarning(e);e.warning=dangerMarker(height,x,z,radius,kind);effects.add(e.warning);audio.fx(kind==='warden-ring'?'warnRing':'warnAim')}
function warnLanding(e,duration=.6){const path=chargePath(e,25*runTuning.speed*difficultyScale()*dashEffects.slow(e),duration,terrain),p=path.at(-1);clearWarning(e);e.warning=dangerMarker(height,p[0],p[1],3.6,'leap');effects.add(e.warning)}
function summonBoss(){
 if(bossSpawned||(mode!=='play'&&!demoActive))return;bossSpawned=true;
 for(const e of enemies)removeEnemy(e);enemies=[];clearObjects(shots);clearObjects(hazards);shots=[];hazards=[];
 const boss=spawnEnemy('warden');boss.cool=2.5;player.inv=2;toast('THE RIFT WARDEN · FINAL ENCOUNTER');audio.fx('level');
}
// FINAL BOSS — alternate warned projectile rings and ground blasts; below half health, shorten recovery.
function bossUpdate(e,dt){
 if(updateNodeEvent(e,dt))return;
 const dx=player.x-e.x,dz=player.z-e.z,d=Math.hypot(dx,dz)||1;
 if(e.hp<e.max*.5&&!e.enraged){e.enraged=true;toast('WARDEN ENRAGED · KEEP MOVING');ring(e.x,e.z,'#ff7979',6,1)}
 if(e.state==='bossWindup'){
  e.timer-=dt;
  if(e.timer<=0){
   if(e.attackIndex%2===0){for(let i=0;i<14;i++)projectile(e.x,e.z,i*Math.PI*2/14,{color:'#d18aff',speed:e.enraged?12:9,range:24,damage:14,pierce:0},true,{emitter:e,source:e.kind})}
   else for(let i=-1;i<=1;i++)hazard(e.tx+i*2.8,e.tz,2.3,25,.9,'warden');
   e.attackIndex++;e.state='approach';e.cool=e.enraged?1.5:2.4;clearWarning(e);
  }
 }else{
  if(d>8){const v=terrain.steer(e.x,e.z,player.x,player.z,e);moveWithCollision(e,v.x*e.def.speed*runTuning.speed*difficultyScale()*dt,v.z*e.def.speed*runTuning.speed*difficultyScale()*dt,e.def.radius)}
  if(e.cool<=0){e.state='bossWindup';e.timer=e.enraged?.75:1.1;e.tx=player.x;e.tz=player.z;e.ax=dx/d;e.az=dz/d;
   if(e.attackIndex%2===0)warnArea(e,e.x,e.z,4,'warden-ring');else warnLine(e,d,'#ffab74');
  }
 }
 if(d<e.def.radius+.45)hurtPlayer(e.def.damage,e.kind);
 e.c.g.position.set(e.x,height(e.x,e.z),e.z);e.c.g.rotation.y=Math.atan2(dx,dz);animateCharacter(e.c,elapsed,.4);
}
// COMBAT HUD — position enemy health bars in screen space and update boss health/phase.
function updateCombatUI(dt){
 for(const o of encounterObjects)if(o.link&&o.hp>0){const e=enemies.find(e=>e.trialElite&&e.hp>0&&e.trialId===o.owner);o.link.visible=!!e;if(e)updateEffectLine(o.link,{x:o.x,y:height(o.x,o.z)+1.3,z:o.z},{x:e.x,y:height(e.x,e.z)+1.3,z:e.z})}
 hitMarker=Math.max(0,hitMarker-dt);$('#crosshair').classList.toggle('confirmed',hitMarker>0);
 for(const e of enemies){
  const p=new T.Vector3(e.x,height(e.x,e.z)+e.c.g.scale.y*2.25,e.z).project(camera);
  e.bar.style.display=e.hp>0&&e.hp<e.max&&p.z<1&&Math.abs(p.x)<1.1&&Math.abs(p.y)<1.1&&mode==='play'?'block':'none';
  e.bar.style.left=(p.x*.5+.5)*innerWidth+'px';e.bar.style.top=(-p.y*.5+.5)*innerHeight+'px';e.fill.style.width=clamp(e.hp/e.max*100,0,100)+'%';
 }
 const boss=enemies.find(e=>(e.kind==='warden'||e.miniboss)&&e.hp>0);$('#bossHUD').classList.toggle('hidden',!boss||mode!=='play');
 if(boss){$('#bossFill').style.width=100*boss.hp/boss.max+'%';$('#bossPhase').textContent=boss.miniboss?(boss.state==='stagger'?'IRON MAW · STAGGERED':'IRON MAW'):nodeCharge?'RIFT NODES '+nodeCharge.nodes.size+' · '+Math.ceil(nodeCharge.remaining)+'s':boss.recovery>0?'WARDEN · EXPOSED':boss.enraged?'ENRAGED':'RIFT WARDEN'}
 $('#stageObjective').textContent=stage===STAGES.length&&!bossSpawned?Math.min(stageKills,stageGoal)+' / '+stageGoal+' KILLS TO SUMMON THE WARDEN':'';
}
function burst(x,y,z,color,count=12,speed=4){y+=height(x,z);for(let i=0;i<count;i++){if(particles.length>360)break;const m=mesh('box',color,x,y,z,rand(.055,.17),undefined,undefined,effects,.8);m.castShadow=false;particles.push({m,vx:rand(-1,1)*speed,vy:rand(.3,1.7)*speed,vz:rand(-1,1)*speed,life:rand(.25,.65),max:.65})}}
function ring(x,z,color,size=3,life=.4){const mat=new T.MeshBasicMaterial({color,transparent:true,opacity:.7,side:T.DoubleSide,depthWrite:false});const m=new T.Mesh(geo.ring,mat);m.rotation.x=-Math.PI/2;m.position.set(x,height(x,z)+.12,z);effects.add(m);rings.push({m,life,max:life,size,ownMat:true})}
// ACTOR HITBOXES — player bullets use at least standing height; terrain/cover stays fully 3D.
function bodyBounds(e,bullet=false){const base=e?e.c.g.position.y:height(player.x,player.z),scale=e?e.c.g.scale.y:1;return {x:e?e.x:player.x,z:e?e.z:player.z,radius:e?e.def.radius:.45,bottom:base+.08,top:base+2.3*(bullet?Math.max(1,scale):scale)}}
function shotWorld(){return {height,covers:stageWorld.covers}}
function pitchTo(x,y,z,tx,ty,tz){return Math.atan2(ty-y,Math.hypot(tx-x,tz-z))}
// STICK AIM — choose vertical aim from a nearby target without curving bullets in flight.
function assistedPitch(angle){let best=null,distance=Infinity;for(const e of combatTargets()){const dx=e.x-player.x,dz=e.z-player.z,d=Math.hypot(dx,dz),delta=Math.atan2(Math.sin(Math.atan2(dx,dz)-angle),Math.cos(Math.atan2(dx,dz)-angle));if(e.hp>0&&Math.abs(delta)<.18&&d<distance){best=e;distance=d}}return best?pitchTo(player.x,height(player.x,player.z)+1.47,player.z,best.x,best.c.g.position.y+1.25*best.c.g.scale.y,best.z):0}
// PROJECTILE CREATION — save world position and velocity once. Never resample bullet altitude.
function projectile(x,z,a,w,enemy=false,source={}){
 if(shots.length>=320)return null;
 const emitter=enemy?source.emitter:null;
 const y=source.y??(height(x,z)+1.47*(emitter?.c.g.scale.y||1));
 const pitch=source.pitch??(enemy?pitchTo(x,y,z,player.x,height(player.x,player.z)+1.2,player.z):aimPitch);
 const speed=w.speed,horizontal=Math.cos(pitch)*speed,m=mesh(w.rocket?'ico':'box',w.color,x,y,z,w.rocket?.16:.065,w.rocket?.16:.065,w.rocket?.35:.6,effects,2.4);
 m.rotation.set(-pitch,a,0,'YXZ');m.castShadow=false;
 shots.push({m,x,y,z,px:x,py:y,pz:z,vx:Math.sin(a)*horizontal,vy:Math.sin(pitch)*speed,vz:Math.cos(a)*horizontal,life:w.range/speed,damage:enemy?w.damage:shotStats(player,w,boons).damage,pierce:enemy?w.pierce:shotStats(player,w,boons).pierce,hitIds:new Set(),enemy,rocket:w.rocket||false,radius:w.radius||0,color:w.color,sourceWeapon:enemy?null:selected,shotId:shotSerial,generation:0,group:{},origin:{x,y,z},source:emitter?.kind||'Projectile',...source});return shots.at(-1);
}
// PLAYER FIRING — weapon spread, pellets and feedback. Cadence is controlled in update().
function fire(){shotSerial++;tutorialEvent('shoot',selected);const w=WEAPONS[selected],originX=player.x,originZ=player.z,group={};const count=shotStats(player,w,boons).count;
 for(let i=0;i<count;i++){const offset=count===1?rand(-w.spread,w.spread):(i-(count-1)/2)*w.spread;projectile(originX,originZ,aim+offset,w,false,{group})}
 const origin={x:originX,y:height(originX,originZ)+1.47,z:originZ},target=mouse.moved&&!demoActive&&Math.hypot(aimStick.x,aimStick.y)<.15&&Math.hypot(gamepadAim.x,gamepadAim.y)<.18?{x:aimPoint.x,y:aimPoint.y,z:aimPoint.z}:{x:origin.x+Math.sin(aim)*Math.cos(aimPitch)*w.range,y:origin.y+Math.sin(aimPitch)*w.range,z:origin.z+Math.cos(aim)*Math.cos(aimPitch)*w.range};
 dashEffects?.shot(target,{weapon:selected,count,shotId:shotSerial,damage:player.damage,group});
 const feel=WEAPON_FEEDBACK[selected];recoil=reduced?feel.recoil*.35:feel.recoil;flashLight.position.set(originX,height(originX,originZ)+1.47,originZ);flashLight.color.set(w.color);flashLight.intensity=reduced?0:feel.flash;burst(originX,1.47,originZ,w.color,feel.particles,2);audio.fx(w.sound);if(!reduced)shake=Math.max(shake,feel.shake);
}
// PROJECTILE UPDATE — sweep the full segment; hit actors only before the nearest terrain/cover impact.
function updateShots(dt){
 for(const b of shots){
  const travelDt=Math.min(dt,Math.max(0,b.life)),from={x:b.x,y:b.y,z:b.z},to={x:b.x+b.vx*travelDt,y:b.y+b.vy*travelDt,z:b.z+b.vz*travelDt};b.px=b.x;b.py=b.y;b.pz=b.z;b.life-=dt;
  const wall=traceWorld(from,to,shotWorld()),limit=wall?.t??1,hits=[];
  if(b.enemy){const t=hitBody(from,to,bodyBounds());if(t!==null&&t<limit)hits.push({t,e:null})}
  else for(const e of combatTargets()){if(e.hp<=0||b.hitIds.has(e.id))continue;const t=hitBody(from,to,bodyBounds(e,true));if(t!==null&&t<limit)hits.push({t,e})}
  hits.sort((a,b)=>a.t-b.t);let stop=null;
  for(const {t,e} of hits){const p=pointAt(from,to,t);if(b.enemy){hurtPlayer(b.damage,b.source);stop=p;b.life=0;break}b.hitIds.add(e.id);
   if(b.rocket){combatEffects.impact(b,p);stop=p;b.life=0;break}
   const critical=runRandom()<player.crit;hurtEnemy(e,b.damage*(critical?2:1),critical,b);combatEffects.hit(b,e,p,e.hp<=0);if(--b.pierce<0){stop=p;b.life=0;break}
  }
  if(!stop&&wall){stop=pointAt(from,to,Math.max(0,wall.t-.015));b.life=0;if(b.rocket)combatEffects.impact(b,stop);else burst(stop.x,stop.y-height(stop.x,stop.z),stop.z,'#b6a184',5,1.5)}
  const end=stop||to;if(!b.enemy)combatEffects.travel(b,from,end);b.x=end.x;b.y=end.y;b.z=end.z;b.m.position.set(b.x,b.y,b.z);
  if(b.rocket&&b.life>0&&Math.random()<.5)burst(b.x,b.y-height(b.x,b.z),b.z,'#ffbd65',1,.7);
  if(b.life<=0){if(!stop&&b.rocket)combatEffects.impact(b,b);effects.remove(b.m)}
 }
 shots=shots.filter(b=>b.life>0);
}
function damageText(x,z,damage,critical){if(numbers.length>25)return;const el=document.createElement('span');el.className='damage'+(critical?' critical':'');el.textContent=Math.round(damage);$('#damageNumbers').appendChild(el);numbers.push({el,x,z,y:height(x,z)+2.2,life:.7})}
// ENEMY DAMAGE — apply temporary execution bonus, count kills, drop rewards and open the rift.
function hurtEnemy(e,damage,critical=false,source={}){if(e.hp<=0||victory)return false;if(e.fixed)return hurtObject(e,damage,source);damage*=e.trialElite?anchorMultiplier(encounterObjects.filter(o=>o.hp>0&&o.owner===e.trialId).length):1;if(e.state==='stagger'||e.recovery>0)damage*=CHALLENGE.quarryVulnerability;if(boons.execution>0&&!source.environment)damage=(e.kind==='warden'||e.miniboss||e.trialElite)?damage*1.5:Math.max(damage,e.hp);if(Number.isInteger(source.sourceWeapon))runDamage[source.sourceWeapon]+=Math.min(e.hp,damage);hitMarker=.12;e.hp-=damage;e.hit=.12;e.hitStrength=WEAPON_FEEDBACK[source.sourceWeapon]?.recoil||.5;burst(e.x,1.2,e.z,critical?'#e8d28a':(WEAPONS[source.sourceWeapon]?.color||'#c9fffe'),WEAPON_FEEDBACK[source.sourceWeapon]?.hit||3,2);damageText(e.x,e.z,damage,critical);if(e.hp<=0){recordEnemy(profile,e.miniboss?'ironmaw':e.kind,true,realProgress());score+=e.def.score;kills++;stageKills++;tutorialEvent('kill');burst(e.x,1.2,e.z,e.def.color,e.kind==='brute'?32:18,4);ring(e.x,e.z,e.def.color,1.4,.3);audio.fx('kill');removeEnemy(e);if(!tutorial&&e.kind!=='warden'&&e.def.xp>0)dropPowerup(e.x,e.z);if(e.miniboss){milestone('quarry');quarryState='defeated';quarryRewarded=true;rewards.add('quarry','major',()=>{quarryState='rewarded';activatePortal()})}if(e.kind==='warden'){milestone('warden');clearChallenges();victory=true;finishRun(false);return}const m=mesh('gem','#80ffde',e.x,height(e.x,e.z)+.4,e.z,.16,.26,.16,effects,1.5);gems.push({m,x:e.x,z:e.z,v:e.def.xp});if(e.kind==='splitter'&&stage>=3){for(let i=0;i<2;i++){const child=spawnEnemy('skitter',{x:e.x+rand(-2,2),z:e.z+rand(-2,2)});inheritTrial(e,child);child.hp*=.45;child.max=child.hp}}if(trial&&e.trialId===trial.id&&trial.defeat(e.id)){trialCount++;milestone('trial');clearTrialObjects();rewards.add(trial.id,'trial');toast('TRIAL COMPLETE')}if(kills%12===0){player.hp=Math.min(player.max,player.hp+5)}if(stageKills>=stageGoal)activatePortal()}}
// PLAYER DAMAGE — apply mode/statue multipliers, then absorb damage with Bone Ward.
function hurtPlayer(amount,source='Unknown hazard'){if(player.inv>0||(mode!=='play'&&!demoActive))return;player.hp=Math.max(0,player.hp-absorbDamage(boons,amount*runTuning.damage*difficultyScale()));player.inv=.6;hit=1;shake=.22;burst(player.x,1,player.z,'#ff7193',15,3);audio.fx('hurt');if(player.hp<=0){lethalSource=source;finishRun(true)}}
// EXPLOSIONS — use real vertical distance and cover; a blast cannot pass through a ridge.
function explode(x,z,radius,damage,enemy=false,y=height(x,z)+.5,source={}){const critical=!enemy&&runRandom()<player.crit;if(critical)damage*=2;burst(x,y-height(x,z),z,enemy?'#ff855f':'#ffd774',38,7);ring(x,z,'#ffe7ad',radius,.45);shake=.23;audio.fx('explosion');const affects=e=>{const bounds=bodyBounds(e),ty=clamp(y,bounds.bottom,bounds.top),target={x:bounds.x,y:ty,z:bounds.z};return Math.hypot(target.x-x,target.y-y,target.z-z)<radius+bounds.radius&&!traceWorld({x,y:y+.08,z},target,shotWorld(),0)};if(enemy){if(affects(null))hurtPlayer(damage,source.source||'Blast');if(source.friendlyFire)for(const e of enemies)if(e.hp>0&&affects(e))hurtEnemy(e,damage,false,source)}else for(const e of combatTargets())if(e.hp>0&&affects(e))hurtEnemy(e,damage,critical,source)}

// ATTACK TELEGRAPHS — a delayed ground marker resolves into an explosion when its timer expires.
function hazard(x,z,radius,damage,delay,kind,owner=null){const m=dangerMarker(height,x,z,radius,kind);effects.add(m);hazards.push({m,x,z,radius,damage,life:delay,max:delay,kind,owner,ownMat:true});audio.fx(['mortar','hex','warden-node'].includes(kind)?'warnAim':'warnGround')}
// DEATH MONSTERS — Revenant rush, Hexer cross-blast and Broodmother crawler summons.
function deathEnemyUpdate(e,dt,dx,dz,d,speed){
 const nx=dx/d,nz=dz/d;
 if(e.state==='deathWindup'){
  e.timer-=dt;if(e.timer<=0){
   if(e.kind==='revenant'){e.state='deathRush';e.timer=.38;if(e.warning)e.warning.material.opacity=.3}
   else if(e.kind==='hexer'){for(const [ox,oz] of [[0,0],[-2.5,0],[2.5,0],[0,-2.5],[0,2.5]])hazard(e.tx+ox,e.tz+oz,1.65,18,.75,'hex',e.trialId);e.state='approach';e.cool=3.8;clearWarning(e)}
   else{const children=enemies.filter(m=>m.kind==='skitter'&&m.hp>0).length;for(let i=0;i<Math.min(3,8-children)&&enemies.length<55;i++)inheritTrial(e,spawnEnemy('skitter',{x:e.x+(i-1)*2,z:e.z+2}));e.state='approach';e.cool=6;clearWarning(e)}
  }
 }else if(e.state==='deathRush'){
  moveWithCollision(e,e.ax*16*runTuning.speed*difficultyScale()*dashEffects.slow(e)*dt,e.az*16*runTuning.speed*difficultyScale()*dashEffects.slow(e)*dt,e.def.radius);e.timer-=dt;if(e.timer<=0){e.state='approach';e.cool=1.6;clearWarning(e)}
 }else if(e.cool<=0&&(e.kind!=='revenant'||d<13)){
  e.state='deathWindup';e.timer=e.kind==='revenant'?.55:e.kind==='hexer'?1:1.2;e.ax=nx;e.az=nz;e.tx=player.x+player.vx*.3;e.tz=player.z+player.vz*.3;
  if(e.kind==='revenant')warnLine(e,9,'#e76464');else ring(e.x,e.z,'#d75b76',e.kind==='hexer'?2:3,e.timer);
 }else{
  let dir=e.kind==='hexer'?(d<7?-.65:d<14?0:1):e.kind==='broodmother'?(d<6?0:1):1;
  const v=dir>0?terrain.steer(e.x,e.z,player.x,player.z,e):{x:nx,z:nz},side=e.kind==='hexer'&&d<14?.55:0;
  moveWithCollision(e,(v.x*dir-nz*side)*speed*dt,(v.z*dir+nx*side)*speed*dt,e.def.radius);
 }
 if(Math.hypot(player.x-e.x,player.z-e.z)<e.def.radius+.48)hurtPlayer(e.def.damage,e.kind);
 e.c.g.position.set(e.x,height(e.x,e.z),e.z);e.c.g.rotation.y=Math.atan2(dx,dz);animateCharacter(e.c,elapsed+e.phase,e.state==='deathWindup'?0:1);
 e.c.body.scale.set(1+(reduced?0:e.hit*(e.hitStrength||.5)*.4),1-(reduced?0:e.hit*.25),1);e.c.g.visible=e.spawn<=0||Math.floor(elapsed*20)%2===0;
}
// ENEMY AI — each state machine owns telegraphs, movement and attacks for its monster type.
function enemyUpdate(e,dt){
 if(e.hp<=0)return;e.cool-=dt;e.hit=Math.max(0,e.hit-dt);e.spawn=Math.max(0,e.spawn-dt);
 if(e.miniboss){quarryUpdate(e,dt);return}
 if(e.kind==='warden'){bossUpdate(e,dt);return}
 const dx=player.x-e.x,dz=player.z-e.z,d=Math.hypot(dx,dz)||1,nx=dx/d,nz=dz/d;let speed=e.def.speed*runTuning.speed*difficultyScale()*dashEffects.slow(e)*(1+Math.min(wave-1,10)*.025),moving=0;
 if(e.kind==='runner')speed*=.8+.2*Math.sin(elapsed*5+e.phase);
 if(DEATH_TYPES[e.kind]){deathEnemyUpdate(e,dt,dx,dz,d,speed);return}
 if(e.state==='snipe'){e.timer-=dt;if(e.timer<=0){projectile(e.x,e.z,Math.atan2(e.ax,e.az),{color:'#cd85a8',damage:29,speed:24,range:42,pierce:0},true,{emitter:e,source:e.kind,pitch:e.attackPitch});e.state='approach';e.cool=2.6;clearWarning(e)}}
 else if(e.state==='windup'){e.timer-=dt;e.c.body.rotation.z=Math.sin(elapsed*40)*.035;if(e.kind==='leaper')e.c.g.position.y=height(e.x,e.z)+1+Math.max(0,1-e.timer)*2;if(e.timer<=0){if(e.warning)e.warning.material.opacity=.3;e.state=e.kind==='leaper'?'leap':'charge';e.timer=e.kind==='leaper'?.6:.68;audio.fx('charge')}}
 else if(e.state==='charge'){moveWithCollision(e,e.ax*18*runTuning.speed*difficultyScale()*dashEffects.slow(e)*dt,e.az*18*runTuning.speed*difficultyScale()*dashEffects.slow(e)*dt,e.def.radius);moving=2;e.timer-=dt;if(Math.random()<.4)burst(e.x,.5,e.z,'#ffb171',2,1);if(e.timer<=0){e.state='approach';e.cool=3.5;e.c.body.rotation.z=0;clearWarning(e)}}
 else if(e.state==='leap'){moveWithCollision(e,e.ax*25*runTuning.speed*difficultyScale()*dashEffects.slow(e)*dt,e.az*25*runTuning.speed*difficultyScale()*dashEffects.slow(e)*dt,e.def.radius);moving=2;e.timer-=dt;e.landingTick=(e.landingTick||0)-dt;if(e.landingTick<=0){e.landingTick=.1;warnLanding(e,Math.max(0,e.timer))}if(e.timer<=0){clearWarning(e);hazard(e.x,e.z,3.6,e.def.damage*1.3,.35,'leap',e.trialId);e.state='approach';e.cool=3.5}}
 else{
  if(['gunner','stormer'].includes(e.kind)){if(e.cool<=.35&&(e.kind==='stormer'||d<18)){e.cueElapsed=(e.cueElapsed||0)+dt;e.cueTick=(e.cueTick||0)-dt;if(e.cueTick<=0){e.cueTick=.1;const was=!!e.warning;clearWarning(e);e.warning=dangerMarker(height,e.x,e.z,1.8,'salvo');effects.add(e.warning);if(!was)audio.fx(e.kind==='stormer'?'warnRing':'warnAim')}}else{clearWarning(e);e.cueElapsed=0;e.cueTick=0}}
  if(e.kind==='charger'&&d<12&&d>3&&e.cool<0){e.state='windup';e.timer=.85;e.ax=nx;e.az=nz;e.c.g.rotation.y=Math.atan2(nx,nz);ring(e.x,e.z,'#ff5656',2,.85);warnLine(e,12,'#ff6d63');}
  else if(e.kind==='brute'&&d<3.8&&e.cool<0){hazard(e.x,e.z,4.2,25,.95,'slam',e.trialId);e.cool=3.5;e.timer=.95;}
  else if(e.kind==='mortar'&&e.cool<0){hazard(player.x+player.vx*.25,player.z+player.vz*.25,2.5,21,1.35,'mortar',e.trialId);e.cool=3.1;audio.fx('mortar')}
  else if(e.kind==='gunner'&&d<18&&e.cool<0&&e.cueElapsed>=.25){const a=Math.atan2(nx,nz);for(let i=-1;i<=1;i++)projectile(e.x,e.z,a+i*.17,{color:'#c1cb6f',damage:11,speed:10,range:26,pierce:0},true,{emitter:e,source:e.kind});e.cool=1.8;clearWarning(e);burst(e.x,1.3,e.z,'#ffe484',6,1)}
  else if(e.kind==='sniper'&&d>8&&d<32&&e.cool<0){e.state='snipe';e.timer=.95;e.ax=nx;e.az=nz;warnLine(e,42,'#ff4eae')}
  else if(e.kind==='stormer'&&e.cool<0&&e.cueElapsed>=.25){for(let i=0;i<8;i++)projectile(e.x,e.z,i*Math.PI/4+elapsed*.15,{color:'#7db3ff',damage:10,speed:9,range:18,pierce:0},true,{emitter:e,source:e.kind});e.cool=3.8;clearWarning(e);burst(e.x,1.4,e.z,'#9fcbff',13,2)}
  else if(e.kind==='leaper'&&d<15&&e.cool<0){e.state='windup';e.timer=.75;e.ax=nx;e.az=nz;warnLanding(e);audio.fx('warnGround')}
  e.timer=Math.max(0,e.timer-dt);
  if(e.timer<=0){let dir=1;if(e.kind==='gunner'||e.kind==='mortar'||e.kind==='sniper'){if(d<8)dir=-.7;else if(d<18)dir=0}let strafe=e.kind==='skitter'&&d<9?Math.sin(elapsed*3+e.phase)*.9:e.kind==='stormer'&&d<12?.65:0;if(e.kind==='stormer'&&d<8)dir=.15;const v=dir>0&&d>3?terrain.steer(e.x,e.z,player.x,player.z,e):{x:nx,z:nz};const mx=(v.x*dir-nz*strafe)*speed*dt,mz=(v.z*dir+nx*strafe)*speed*dt;moveWithCollision(e,mx,mz,e.def.radius);moving=Math.abs(dir);e.c.g.rotation.y=Math.atan2(nx,nz)}
 }
 if(d<e.def.radius+.48)hurtPlayer(e.state==='charge'?24:e.def.damage,e.kind);
 e.c.g.position.set(e.x,height(e.x,e.z)+(e.state==='leap'?Math.sin(clamp(e.timer/.6,0,1)*Math.PI)*3:0),e.z);animateCharacter(e.c,elapsed+e.phase,moving);e.c.body.scale.set(1+(reduced?0:e.hit*(e.hitStrength||.5)*.4),1-(reduced?0:e.hit*.25),1);e.c.g.visible=e.spawn<=0||Math.floor(elapsed*20)%2===0;
}
// LEVEL-UP REWARDS — permanent bonuses for this run; freshPlayer() clears them on restart.
const UPGRADES=UPGRADE_INFO.map((u,i)=>[...u,()=>applyUpgrade(player,i)]);
// PERMANENT RUN UPGRADES — distinct from short-lived powerups in encounters.js.
function levelUp(){
 player.xp-=player.next;player.level++;player.next=Math.floor(player.next*1.3+3);
 if(demoActive){UPGRADES[Math.floor(Math.random()*UPGRADES.length)][3]();return}
 rewards.add('xp:'+player.level,'ordinary');showReward();
}
function ordinaryOptions(){return shuffled(UPGRADES,runRandom).slice(0,3).map(u=>({name:u[0],text:u[2],detail:upgradePreview(player,UPGRADES.indexOf(u),WEAPONS[selected],boons),apply(){u[3]();build.ordinary[u[0]]=(build.ordinary[u[0]]||0)+1}}))}
function showReward(){
 if(activeReward||overlay||demoActive||tutorial||mode!=='play')return;
 const event=rewards.next();if(!event)return;activeReward=event;clearInput();mode='upgrade';
 let options,title='CHOOSE AN UPGRADE';
 if(event.type==='major'){
  const offer=modOffer(build,runRandom);title=offer.length?'MAJOR WEAPON MOD':'ALL MODS OWNED · UPGRADE';
  options=offer.length?offer.map(i=>({name:MODS[i].name,text:MODS[i].weapon+' · '+MODS[i].text,weapon:i,apply(){build.mods.push(i)}})):ordinaryOptions();
 }else if(event.type==='dash'){title='CHOOSE YOUR DASH';options=DASH_TRAITS.map(d=>({name:d.name,text:d.text,apply(){build.dash=d.id}}));
 }else if(event.type==='trial'){
  title='SKULL TRIAL · CHOOSE A REWARD';const claim=()=>trial?.claim(),hasMods=modOffer(build).length>0;options=[];
  if(hasMods)options.push({name:'Major weapon mod',text:'Choose one of up to three unowned modifications.',apply(){rewards.add(event.key+':mod','major',claim)}});
  options.push({name:hasMods?'Ordinary upgrade':'All mods owned · ordinary upgrade',text:'Choose one of three ordinary run upgrades.',apply(){rewards.add(event.key+':upgrade','ordinary',claim)}},{name:'Mend & Bone Ward',text:'Heal 35 and gain a 30-point ward for 10s.',apply(){player.hp=Math.min(player.max,player.hp+35);collectBoon(boons,'ward',player);claim()}});
 }else options=ordinaryOptions();
 renderChoice(title,options,()=>{event.done?.();activeReward=null;mode='play';$('#choice').classList.add('hidden');clearInput();showReward();updateHUD()});
}
function renderChoice(title,options,done){
 $('#choiceTitle').textContent=title;$('#cards').replaceChildren();
 options.forEach(o=>{const b=document.createElement('button');b.className='card';
  if(Number.isInteger(o.weapon)){const icon=document.createElement('span');icon.className='weapon-sprite sprite-'+o.weapon;b.appendChild(icon)}
  const heading=document.createElement('strong');heading.textContent=o.name.toUpperCase();const copy=document.createElement('p');copy.textContent=o.text;b.appendChild(heading);b.appendChild(copy);if(o.detail){const detail=document.createElement('small');detail.className='upgrade-comparison';detail.textContent=o.detail;b.appendChild(detail)}
  let chosen=false;b.onclick=()=>{if(chosen)return;chosen=true;o.apply();done()};$('#cards').appendChild(b);
 });$('#choice').classList.remove('hidden');$('#cards button').focus();audio.fx('level');updateHUD();
}
function buildText(details=false){const dash=DASH_TRAITS.find(d=>d.id===build.dash);return [Object.entries(build.ordinary).map(([k,v])=>k+(v>1?' ×'+v:'')+(details?' — '+(UPGRADES.find(u=>u[0]===k)?.[2]||''):'' )).join(details?'\n':' · ')||'No ordinary upgrades',build.mods.map(i=>MODS[i].weapon+' · '+MODS[i].name+(details?' — '+MODS[i].text:'')).join(details?'\n':' · ')||'No major mods',dash?dash.name+(details?' — '+dash.text:''):'Phase Dash'].join('\n')}
function toast(text){if(demoActive)return;$('#waveToast').textContent=text;$('#waveToast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#waveToast').classList.remove('show'),2200)}
// HUD — reflects game state only; tutorial hints and optional difficulty/powerup rows update last.
function updateHUD(){if(demoActive)return;
 $('#healthText').textContent=`${Math.ceil(player.hp)} / ${player.max}`;$('#healthBar').style.width=100*player.hp/player.max+'%';$('#xpBar').style.width=Math.min(100,100*player.xp/player.next)+'%';$('#level').textContent=player.level;$('#score').textContent=score.toLocaleString()+' SCORE';
 $('#sector').textContent=tutorial?'TUTORIAL · RIFT CLOISTER':`STAGE ${stage} · ${STAGES[stage-1]?.name||'VOID'}`;$('#clock').textContent=String(Math.floor(elapsed/60)).padStart(2,'0')+':'+String(Math.floor(elapsed%60)).padStart(2,'0');$('#hostiles').textContent=enemies.filter(e=>e.hp>0).length+' HOSTILES';$('#dashStatus').textContent=player.dashCD>0?'DASH '+player.dashCD.toFixed(1)+'s':'PHASE DASH READY';$('#crosshair').style.display=mode==='play'&&mouse.moved?'block':'none';
 const c=$('#portalCompass');if(mode==='play'&&stage<STAGES.length&&(!tutorial||tutorial.step==='rift')){c.classList.remove('hidden');const {x:px,z:pz}=stagePortal.position,dx=px-player.x,dz=pz-player.z;const distance=Math.hypot(dx,dz);const viewYaw=Math.atan2(camera.position.x-player.x,camera.position.z-player.z),delta=portalBearing(dx,dz,viewYaw);$('.compass-arrow').style.transform=`rotate(${delta*180/Math.PI}deg)`;$('#portalLabel').textContent=quarryState==='waiting'?'COMPLETE OR ABANDON TRIAL':stage===2&&quarryState==='active'?'DEFEAT IRON MAW':portalActive?'RIFT PORTAL OPEN':'RIFT PORTAL LOCKED';$('#portalDistance').textContent=portalActive?`${Math.round(distance)}m · ${tutorial?'ENTER TO FINISH':'ENTER TO DESCEND'}`:`${stageKills} / ${stageGoal} KILLS TO OPEN`}else c.classList.add('hidden');renderTutorial();updateEncounterHUD();
}

// SIMULATION — dt is seconds. Pausing stops combat, powerup timers and tutorial progress.
function update(dt){
 if((mode!=='play'&&!demoActive)||overlay||demoFinished)return;
 if(debugScenario)player.inv=2;
 elapsed+=dt;dashEffects.tick(dt);tickBoons(boons,dt);player.inv=Math.max(0,player.inv-dt);player.dashCD=Math.max(0,player.dashCD-dt);player.dashing=Math.max(0,player.dashing-dt);player.hp=Math.min(player.max,player.hp+player.regen*dt);
 if(!demoActive&&held('orbitLeft'))cameraYaw+=dt*1.6;if(!demoActive&&held('orbitRight'))cameraYaw-=dt*1.6;
 const beforeX=player.x,beforeZ=player.z;const input=inputMovement(),smooth=1-Math.exp(-dt*16);player.vx=lerp(player.vx,input.x*player.speed*(boons.speed?1.3:1),smooth);player.vz=lerp(player.vz,input.z*player.speed*(boons.speed?1.3:1),smooth);
 if(player.dashing>0){moveWithCollision(player,player.dx*27*dt,player.dz*27*dt,.45);burst(player.x,.6,player.z,profile.cosmetics.trail==='ember'?'#f2af78':'#81ffff',3,1)}else moveWithCollision(player,player.vx*dt,player.vz*dt,.45);
 if(player.dashing>0)dashEffects.record({x:beforeX,y:height(beforeX,beforeZ)+.15,z:beforeZ},{x:player.x,y:height(player.x,player.z)+.15,z:player.z});
 tutorialEvent('move',Math.hypot(player.x-beforeX,player.z-beforeZ));
 let manual=demoActive,shooting=demoActive?demoFiring:held('fire')||touchFire||gamepadFire;
 const stick=Math.hypot(aimStick.x,aimStick.y)>.15?aimStick:gamepadAim;
 if(!demoActive&&Math.hypot(stick.x,stick.y)>.18){const v=movementVector(stick.x,stick.y,cameraYaw);aim=Math.atan2(v.x,v.z);aimPitch=assistedPitch(aim);manual=true}
 else if(!demoActive&&mouse.moved){
  floorPlane.constant=-(height(player.x,player.z)+1.2);raycaster.setFromCamera(new T.Vector2(mouse.x/innerWidth*2-1,-mouse.y/innerHeight*2+1),camera);
  const actor=raycaster.intersectObjects(combatTargets().filter(e=>e.hp>0).map(e=>e.c.g),true)[0],surface=raycaster.intersectObject(stageWorld.surface,false)[0];
  if(actor)aimPoint.copy(actor.point);else if(surface){aimPoint.copy(surface.point);aimPoint.y+=1.2}else raycaster.ray.intersectPlane(floorPlane,aimPoint);
  aim=Math.atan2(aimPoint.x-player.x,aimPoint.z-player.z);aimPitch=pitchTo(player.x,height(player.x,player.z)+1.47,player.z,aimPoint.x,aimPoint.y,aimPoint.z);manual=true;
 }

 if(!manual&&!shooting&&Math.hypot(input.x,input.z)>.1)aim=Math.atan2(input.x,input.z);
 hero.gunMount.rotation.x=-aimPitch;hero.g.rotation.y=aim;hero.g.position.set(player.x,height(player.x,player.z),player.z);animateCharacter(hero,elapsed,Math.min(1,Math.hypot(player.vx,player.vz)/5),recoil);hero.g.visible=!!debugScenario||player.inv<=0||Math.floor(elapsed*24)%2===0;
 fireTimer-=dt;if(shooting&&fireTimer<=0){fire();fireTimer=shotStats(player,WEAPONS[selected],boons).interval}
 if(portalActive&&Math.hypot(player.x-stagePortal.position.x,player.z-stagePortal.position.z)<PORTAL_RADIUS){enterStage();return}
 spawnTimer-=dt;if(!tutorial&&!bossSpawned&&spawnTimer<=0&&enemies.length<(quarryState==='active'?8:55)){spawnEnemy();spawnTimer=(quarryState==='active'?4:Math.max(.3,1.5-wave*.12))/difficultyScale()}
 const nextWave=1+Math.floor(elapsed/30);if(!tutorial&&nextWave>wave){wave=nextWave;if(!bossSpawned&&quarryState!=='active'){toast('RIFT SURGE · STAY MOVING');audio.fx('level');player.hp=Math.min(player.max,player.hp+12);for(let i=0;i<Math.min(wave,6);i++)spawnEnemy()}}
 for(const e of enemies)enemyUpdate(e,dt);
 if((mode!=='play'&&!demoActive)||demoFinished)return;
 updateShots(dt);combatEffects.tick(dt);updateVents(dt);enemies=enemies.filter(e=>e.hp>0);if((mode!=='play'&&!demoActive)||demoFinished)return;
 for(const h of hazards){h.life-=dt;h.m.material.opacity=.45+(1-h.life/h.max)*.5;if(h.life<=0){explode(h.x,h.z,h.radius,h.damage,true,undefined,{source:h.kind});disposeMarker(h.m)}}
 hazards=hazards.filter(h=>h.life>0);if((mode!=='play'&&!demoActive)||demoFinished)return;
 for(const g of gems){const dx=player.x-g.x,dz=player.z-g.z,d=Math.hypot(dx,dz);if(d<player.magnet){const speed=Math.min(d,dt*(4+16/(d+.2)));g.x+=dx/(d||1)*speed;g.z+=dz/(d||1)*speed}g.m.position.set(g.x,height(g.x,g.z)+.45+Math.sin(elapsed*4+g.x)*.12,g.z);g.m.rotation.y+=dt*2;if(d<.65){player.xp+=g.v;g.dead=true;effects.remove(g.m);audio.fx('gem')}}gems=gems.filter(g=>!g.dead);
 updatePowerups(dt);if(!tutorial&&player.xp>=player.next){clearInput();levelUp()}showReward();updateHUD();
}
// EFFECTS — animate bounded particles, rift sparks, hit flashes and floating damage numbers.
function updateEffects(dt){buildFeedback.tick(dt);$('#buildCue').textContent=buildFeedback.text;for(const p of particles){p.life-=dt;p.vy-=12*dt;p.m.position.x+=p.vx*dt;p.m.position.y+=p.vy*dt;p.m.position.z+=p.vz*dt;p.m.rotation.x+=dt*5;p.m.rotation.z+=dt*3;p.m.scale.multiplyScalar(Math.exp(-dt*1.5));if(p.life<=0)effects.remove(p.m)}particles=particles.filter(p=>p.life>0);
 if(stagePortal){stagePortal.children[1].rotation.z+=dt*.72;stagePortal.scale.setScalar(1+Math.sin(elapsed*4)*.08);if(portalLight){portalLight.intensity=portalActive?19+Math.sin(elapsed*9)*6:0;portalLight.color.set('#9e5cff')}if(portalActive&&Math.random()<dt*9){const [x,z]=tutorial?TUTORIAL_PORTAL:STAGES[stage-1].portal;burst(x+rand(-2.5,2.5),rand(1,6),z+rand(-2.5,2.5),'#b974ff',1,1.8)}}
 for(const r of rings){r.life-=dt;if(r.line){if(r.life<=0)effects.remove(r.m);continue}r.m.scale.setScalar(r.size*(1-r.life/r.max));r.m.material.opacity=Math.max(0,r.life/r.max)*.7;if(r.life<=0){effects.remove(r.m);r.m.material.dispose()}}rings=rings.filter(r=>r.life>0);
 for(const n of numbers){n.life-=dt;n.y+=dt*1.7;const v=new T.Vector3(n.x,n.y,n.z).project(camera);n.el.style.left=(v.x*.5+.5)*innerWidth+'px';n.el.style.top=(-v.y*.5+.5)*innerHeight+'px';n.el.style.opacity=Math.min(1,n.life*3);if(n.life<=0)n.el.remove()}numbers=numbers.filter(n=>n.life>0);
 recoil=Math.max(0,recoil-dt*9);flashLight.intensity*=Math.exp(-dt*22);shake*=Math.exp(-dt*14);hit=Math.max(0,hit-dt*4);$('#hitflash').style.opacity=hit*.6;
}
// CAMERA — screen-relative movement uses the same yaw; geometry supplies the target elevation.
function cameraUpdate(dt,time){const target=new T.Vector3(player.x,height(player.x,player.z)+1,player.z);let yaw=cameraYaw,dist=cameraDistance;
 if(demoActive){yaw=.4;dist=29;target.x+=Math.cos(yaw)*7;target.z-=Math.sin(yaw)*7}
 const desired=target.clone().add(new T.Vector3(Math.sin(yaw)*dist,dist*.85,Math.cos(yaw)*dist));camera.position.lerp(desired,1-Math.exp(-dt*7));camera.lookAt(target);if(!reduced){camera.position.x+=rand(-shake,shake);camera.position.y+=rand(-shake,shake)}
 const cutStart=debugScenario?performance.now():0;updateCutaway(camera,{x:player.x,y:height(player.x,player.z),z:player.z},dt,mode!=='dead'&&!(debugScenario&&devCutawayOff));if(debugScenario){devCosts.camera.push(performance.now()-cutStart);if(devCosts.camera.length>120)devCosts.camera.shift()}
 heroRing.position.set(player.x,height(player.x,player.z)+.05,player.z);heroRing.visible=mode!=='dead';
 sun.position.set(player.x-24,height(player.x,player.z)+45,player.z+18);sun.target.position.set(player.x,height(player.x,player.z),player.z);sun.target.updateMatrixWorld();
}
camera.position.set(10,22,25);camera.lookAt(0,1,0);
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();const r=retroSize();composer.setSize(r.w,r.h)});

// RUN MODIFIERS — statue difficulty persists across stages, then resets in start().
function difficultyScale(){return 1+difficultyBonus/100}
function applyCurse(statue){
 if(!statueWorld?.activate(statue))return false;
 const previous=difficultyScale();difficultyBonus+=STATUE_BONUS;statueCount++;const ratio=difficultyScale()/previous;
 for(const e of enemies)if(e.hp>0){e.hp*=ratio;e.max*=ratio}
 ring(statue.x,statue.z,'#bc565a',3,.7);audio.fx('charge');updateEncounterHUD();return true;
}
function decision(title,options){
 if(activeReward||mode!=='play')return;activeReward={key:'decision:'+decisionSerial++,preview:true};clearInput();mode='upgrade';
 renderChoice(title,options,()=>{activeReward=null;mode='play';$('#choice').classList.add('hidden');clearInput();showReward();updateHUD()});
}
function interact(){
 if(mode!=='play'||overlay||tutorial||demoActive)return;
 const statue=statueWorld?.nearby(player);if(!statue)return;
 const rewarded=statue.rewarded&&trial?.state==='available';if(rewarded&&quarryState==='active'){toast('DEFEAT IRON MAW BEFORE STARTING A TRIAL');return}
 decision(rewarded?'SKULL TRIAL · '+TRIAL_NAMES[stage-1]:'CHALLENGE-ONLY STATUE',[
  {name:rewarded?'Accept trial':'Accept curse',text:rewarded?'+5% persistent statue curse. '+(stage===3?'Marked hunt with storming vents.':stage===4?'Three anchors shield the marked elite.':'Defeat the marked hunt.')+' Reward: major mod, upgrade, or heal + ward.':'+5% persistent statue curse. No encounter reward.',apply(){if(rewarded)beginTrial(statue);else applyCurse(statue)}},
  {name:'Leave',text:'Keep your current difficulty.',apply(){}}
 ]);
}
function beginTrial(statue){
 if(!trial||trial.state!=='available'||statue.used)return false;
 const places=trialLocations(terrain,statue);if(!places.length){toast('NO SAFE TRIAL SPACE · STATUE NOT USED');return false}
 const roster=(stage===4?places.slice(0,1):places).map((p,i)=>{const e=spawnEnemy(i===0?'brute':stage>2?'splitter':'runner',p);e.hp*=i===0?2:1.25;e.max=e.hp;e.trialId=trial.id;const mark=mesh('torus','#dfb276',0,.12,0,1.25,1.25,1.25,e.c.g,1);mark.rotation.x=Math.PI/2;return e});
 if(stage===4){roster[0].trialElite=true;for(const p of places.slice(1))addEncounterObject('anchor',p,CHALLENGE.anchorHP,trial.id)}
 if(stage===3)for(const p of places.slice(0,3))addVent(p);
 trial.statue=statue;trial.activate(roster.map(e=>e.id),()=>applyCurse(statue));toast('TRIAL STARTED · DEFEAT THE MARKED HUNT');return true;
}
function inheritTrial(parent,child){if(trial&&parent.trialId===trial.id&&trial.state==='active'){child.trialId=trial.id;trial.descendant(parent.id,child.id)}return child}
function abandonTrial(){
 if(!trial?.abandon())return false;
 for(const e of enemies)if(e.trialId===trial.id){removeEnemy(e);e.hp=0}
 enemies=enemies.filter(e=>e.hp>0);clearTrialObjects();if(quarryState==='waiting')quarryState='dormant';toast('TRIAL ABANDONED · CURSE REMAINS');return true;
}
$('#abandonTrial').onclick=()=>{abandonTrial();$('#abandonTrial').classList.add('hidden');if(stage===2&&stageKills>=stageGoal){mode='play';activatePortal();mode='pause'}};
// Pickups are separate from XP gems. Their clocks stop while the game is paused.
function dropPowerup(x,z,kind=rollPowerup(runRandom)){
 if(!kind||powerups.length>=MAX_DROPS||tutorial)return;const spec=POWERUPS[kind],m=mesh(spec.shape,spec.color,x,height(x,z)+.6,z,.36,.5,.36,effects,1);
 powerups.push({kind,x,z,m,life:DROP_LIFETIME});
}
function updatePowerups(dt){
 for(const p of powerups){p.life-=dt;p.m.position.y=height(p.x,p.z)+.6+Math.sin(elapsed*4)*.12;p.m.rotation.y+=dt*1.5;
  if(Math.hypot(player.x-p.x,player.z-p.z)<1.35){collectBoon(boons,p.kind,player);p.life=0;toast(POWERUPS[p.kind].label+(p.kind==='execution'?' · '+POWERUPS.execution.duration+' SECONDS':''));audio.fx('level')}
  if(p.life<=0)effects.remove(p.m);
 }powerups=powerups.filter(p=>p.life>0);
}
function updateEncounterHUD(){
 $('#difficultyMeter').classList.toggle('hidden',difficultyBonus===0||demoActive);$('#difficultyMeter').textContent='Statue curse: '+(100+difficultyBonus)+'%';
 $('#trialStatus').textContent=trial?.state==='active'?'SKULL TRIAL · '+trial.roster.size+' MARKED HOSTILES'+(stage===4?' · '+encounterObjects.filter(o=>o.owner===trial.id&&o.hp>0).length+' ANCHORS · 20% PROTECTION EACH':'')+' · PAUSE TO ABANDON':'';
 $('#modStatus').textContent=build.mods.includes(1)&&selected===1?'STORM NEEDLE '+build.charge+' / '+BALANCE.stormHits:'';
 const active=Object.keys(POWERUPS).filter(k=>boons[k]>0);$('#powerupStatus').textContent=active.map(k=>POWERUPS[k].label+' '+Math.ceil(boons[k])+'s').join(' · ');
 const nearby=mode==='play'&&!tutorial?statueWorld?.nearby(player):null;$('#interactPrompt').classList.toggle('hidden',!nearby);$('#interactTouch').classList.toggle('hidden',!nearby);
 $('#interactPrompt').textContent=nearby?(mobile?'INTERACT':navigator.getGamepads?.()[0]?'X':keyLabel(prefs.bindings.interact))+(nearby.rewarded?' · SKULL TRIAL · PREVIEW':' · CHALLENGE ONLY · +5% · NO REWARD'):'';
}

// TUTORIAL EVENTS — only the expected action advances a step; the combat step spawns five weak enemies.
function tutorialEvent(action,value){
 if(!tutorial||mode!=='play')return;
 if(tutorial.advance(action,value)&&tutorial.step==='combat')for(let i=0;i<TUTORIAL_GOAL;i++){const a=i*Math.PI*2/TUTORIAL_GOAL;spawnEnemy(i===2?'skitter':'runner',{x:player.x+Math.sin(a)*11,z:player.z+Math.cos(a)*11})}
}
// TUTORIAL GUIDE — reflects current keybindings, input device and selected weapon.
function renderTutorial(){
 if(!tutorial)return;const input=navigator.getGamepads?.()[0]?'pad':mobile?'touch':'keyboard',copy=tutorialCopy(tutorial,{bindings:prefs.bindings,keyLabel,input,weapon:WEAPONS[selected]});
 for(const [id,text] of [['tutorialStep',tutorial.number+' / 6'],['tutorialTitle',copy.title],['tutorialHint',copy.hint],['tutorialWeapon',copy.weapon]])if($('#'+id).textContent!==text)$('#'+id).textContent=text;
}
// TUTORIAL EXIT — return to the demo without submitting a score or carrying practice bonuses.
function finishTutorial(completed){
 clearInput();mode='menu';document.body.classList.remove('in-run','tutorial-active');document.body.classList.add('menu-open');$('#pauseMenu').classList.add('hidden');$('#menu').classList.remove('hidden');$('#portalCompass').classList.add('hidden');$('#tutorialGuide').classList.add('hidden');$('#stageObjective').textContent='';$('#waveToast').classList.remove('show');
 $('.menu-card h1').classList.add('brand-title');$('.menu-card h1').innerHTML='RIFT<span>BORN</span>';$('.menu-card .edition').textContent='';$('#runSummary').textContent=completed?'TUTORIAL COMPLETE':'';$('#scoreSave').textContent='';$('#retryScore').classList.add('hidden');$('#start').textContent='START RUN';$('#runReport').classList.add('hidden');start(true);$('#start').focus();
}

function formatTime(seconds){return Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0')}
// DIALOGS — settings, leaderboard and username entry own focus and pause active gameplay.
function openPanel(id){if(mode==='play')pause();overlayReturn=mode;overlay=id;clearInput();document.body.classList.add('menu-open');$(id).classList.remove('hidden');$('#menu').inert=true;$('#pauseMenu').inert=true;if(id==='#runSetup'){$('#playerName').value=profile.lastUsername;$('#usernameError').textContent='';$('#playerName').setAttribute('aria-invalid','false');$('#playerName').focus()}else if(id==='#settings'){renderBindings();syncSettings();$('#closeSettings').focus()}else if(id==='#profile'){renderProfile();$('#closeProfile').focus()}else{loadLeaderboard();$('#closeLeaderboard').focus()}}
function closePanel(){if(!overlay)return;$(overlay).classList.add('hidden');overlay=null;bindingAction=null;$('#menu').inert=false;$('#pauseMenu').inert=false;clearInput();if(overlayReturn==='pause')$('#resume').focus();else $('#start').focus()}
function captureBinding(code){if(!bindingAction)return;if(['Escape','MetaLeft','MetaRight','F5','F11','F12'].includes(code)){ $('#bindStatus').textContent='That key is reserved. Choose another key.';return}const action=bindingAction;const swap=assignBinding(prefs.bindings,action,code);bindingAction=null;savePrefs();renderBindings();refreshHelp();$('#bindStatus').textContent=ACTION_LABELS[action]+' → '+keyLabel(code)+(swap?' · Swapped with '+ACTION_LABELS[swap]:'')}
// REBINDING UI — labels and defaults live in preferences.js, including Interact.
function renderBindings(){$('#bindings').replaceChildren();for(const [action,label] of Object.entries(ACTION_LABELS)){const row=document.createElement('div');row.className='bind-row';const name=document.createElement('span');name.textContent=label;const b=document.createElement('button');b.textContent=bindingAction===action?'PRESS A KEY…':keyLabel(prefs.bindings[action]);b.classList.toggle('listening',bindingAction===action);b.setAttribute('aria-label','Change '+label+' binding');b.onclick=()=>{bindingAction=action;renderBindings();$('#bindStatus').textContent='Press a key or mouse button. Escape cancels.'};row.appendChild(name);row.appendChild(b);$('#bindings').appendChild(row)}}
document.addEventListener('pointerdown',e=>{if(!bindingAction||e.pointerType==='touch')return;e.preventDefault();e.stopImmediatePropagation();captureBinding('Mouse'+e.button)},true);
document.addEventListener('contextmenu',e=>{if(overlay==='#settings')e.preventDefault()});
document.addEventListener('keydown',e=>{if(e.code!=='Tab'||bindingAction)return;const root=overlay?$(overlay):mode==='pause'?$('#pauseMenu'):mode==='upgrade'?$('#choice'):null;if(!root)return;const list=[...root.querySelectorAll('button:not(:disabled),input,select,summary')].filter(el=>el.tabIndex!==-1&&el.getClientRects().length);const first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}});
function refreshHelp(){const b=prefs.bindings;document.querySelectorAll('.weapon').forEach((el,i)=>{el.querySelector('.num').textContent=keyLabel(b['weapon'+(i+1)])})}
function selectSettingsTab(name,focus=false){
  bindingAction=null;for(const tab of ['Graphics','Audio','Controls']){const active=tab===name;$('#tab'+tab).setAttribute('aria-selected',String(active));$('#tab'+tab).tabIndex=active?0:-1;$('#panel'+tab).hidden=!active}if(focus)$('#tab'+name).focus();if(name==='Controls')renderBindings();
 }
 for(const [index,name] of ['Graphics','Audio','Controls'].entries()){
  $('#tab'+name).onclick=()=>selectSettingsTab(name);
  $('#tab'+name).onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.code)){e.preventDefault();const next=e.code==='Home'?0:e.code==='End'?2:(index+(e.code==='ArrowRight'?1:2))%3;selectSettingsTab(['Graphics','Audio','Controls'][next],true)}};
 }
 $('#pixelation').onchange=e=>{const value=e.target.value;prefs.pixelation=value==='auto'?'auto':Number(value);qualityReduced=false;savePrefs();const r=retroSize();composer.setSize(r.w,r.h);syncSettings()};
 $('#fogAmount').oninput=e=>{prefs.fog=clamp(Number(e.target.value),0,100);savePrefs();applyLighting();syncSettings()};
 $('#fpsCap').onchange=e=>{prefs.fpsCap=Number(e.target.value);savePrefs();syncSettings()};
 $('#muteAudio').onchange=e=>{prefs.muted=e.target.checked;savePrefs();if(!prefs.muted)audio.unlock();audio.apply();syncSettings()};
 function syncSettings(){for(const [id,key] of [['master','master'],['music','music'],['effects','effects']]){$('#'+id+'Volume').value=prefs[key];$('#'+id+'Value').textContent=prefs[key]+'%'}$('#sound').textContent=soundIsSilent()?'SOUND OFF':'SOUND ON';$('#muteAudio').checked=prefs.muted;$('#pixelation').value=String(prefs.pixelation);$('#fogAmount').value=prefs.fog;$('#fogValue').textContent=prefs.fog?prefs.fog+'%':'OFF';$('#fpsCap').value=String(prefs.fpsCap);$('#nightmare').checked=prefs.nightmare}
for(const [id,key] of [['master','master'],['music','music'],['effects','effects']])$('#'+id+'Volume').oninput=e=>{prefs[key]=clamp(Number(e.target.value),0,100);if(key==='master'&&prefs.master>0)prefs.muted=false;savePrefs();syncSettings();audio.apply()};
$('#resetBindings').onclick=()=>{prefs.bindings={...DEFAULT_BINDINGS};bindingAction=null;savePrefs();renderBindings();refreshHelp();$('#bindStatus').textContent='Default controls restored.'};
$('#menuSettings').onclick=$('#pauseSettings').onclick=()=>openPanel('#settings');$('#menuLeaderboard').onclick=$('#pauseLeaderboard').onclick=()=>openPanel('#leaderboard');$('#closeSettings').onclick=$('#closeLeaderboard').onclick=closePanel;$('#refreshLeaderboard').onclick=loadLeaderboard;$('#endRun').onclick=()=>finishRun(false);$('#retryScore').onclick=()=>saveScores(true);
$('#cancelRun').onclick=closePanel;
$('#runForm').onsubmit=e=>{e.preventDefault();if(!$('#playerName').value.trim()){$('#usernameError').textContent='Enter a username.';$('#playerName').setAttribute('aria-invalid','true');$('#playerName').focus();return}closePanel();start()};
function setNightmare(value){prefs.nightmare=!!value;savePrefs();$('#nightmare').checked=prefs.nightmare;applyLighting()}
$('#nightmare').onchange=e=>setNightmare(e.target.checked);
// RUN COMPLETION — capture immutable name/mode/date for retryable score submission.
function finishRun(defeated){if(demoActive){demoFinished=true;return}if(tutorial){finishTutorial(false);return}if(!['play','pause'].includes(mode))return;captureSummary(defeated);abandonTrial();clearChallenges();combatEffects?.clear();dashEffects?.clear();buildFeedback.clear();clearInput();mode='dead';hero.g.visible=!defeated;document.body.classList.remove('in-run');document.body.classList.add('menu-open');$('#pauseMenu').classList.add('hidden');$('#menu').classList.remove('hidden');$('#bossHUD').classList.add('hidden');$('#portalCompass').classList.add('hidden');$('#stageObjective').textContent='';$('.menu-card h1').classList.remove('brand-title');$('.menu-card h1').innerHTML=victory?'RIFT<br><span>CONQUERED</span>':defeated?'RUN<br><span>SEVERED</span>':'RUN<br><span>COMPLETE</span>';$('.menu-card .edition').textContent=`STAGE ${stage} · ${score.toLocaleString()} SCORE`;$('#runSummary').textContent=`${kills} KILLS · ${formatTime(elapsed)}`;renderRunSummary();$('#start').textContent='PLAY AGAIN';$('#start').focus();if(runId&&elapsed>=1){pendingScores.set(runId,{id:runId,name:runName,score,kills,wave,seconds:Math.floor(elapsed),stage,played_at:Date.now(),death_mode:runDeath,statue_count:statueCount,statue_modifier:100+difficultyBonus,outcome:victory?'victory':defeated?'defeat':'ended',gameplay_version:GAMEPLAY_VERSION});if(realProgress()){rememberRun(profile,pendingScores.get(runId));persistProfile()}runId=null;saveScores()}else $('#scoreSave').textContent=''}
// Durable outbox is disabled in tutorial/practice/test flows; tests use the mock API.
const scoreOutbox=debugScenario||window.__RIFTBORN_TEST__?null:new ScoreOutbox({send:run=>fetch('/api/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(run),signal:AbortSignal.timeout(8000)})});
async function saveScores(manual=false){
 if(savingScores)return;savingScores=true;
 try{
  if(scoreOutbox){
   for(const [id,run] of pendingScores){await scoreOutbox.add(run);pendingScores.delete(id)}
   if(manual===true)await scoreOutbox.retry();await scoreOutbox.flush();const rows=await scoreOutbox.list();
   const failed=rows.some(r=>r.status==='failed');
   $('#scoreSave').textContent=rows.length?(scoreOutbox.storageFailed?'Storage unavailable — keep this tab open. ':'')+rows.length+(failed?' score upload failed. Retry saving.':' score pending. Retrying automatically.'):(scoreOutbox.saved?'Score saved.'+(scoreOutbox.storageFailed?' Local retry storage unavailable.':''):scoreOutbox.storageFailed?'Score storage unavailable. Keep this tab open.':'');
   $('#retryScore').classList.toggle('hidden',!rows.length);return;
  }
  if(!pendingScores.size)return;
  for(const [id,run] of pendingScores){const r=await fetch('/api/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(run)});if(!r.ok)throw Error('Save unavailable');pendingScores.delete(id)}
  $('#scoreSave').textContent='Score saved.';$('#retryScore').classList.add('hidden');
 }catch{$('#scoreSave').textContent='Score not saved. Retry when connected.';$('#retryScore').classList.remove('hidden')}finally{savingScores=false}
}
if(scoreOutbox){window.addEventListener('online',()=>saveScores());setInterval(()=>{if(!document.hidden)saveScores()},15000);saveScores()}
// LEADERBOARD READ — render names as text and only mark explicitly recorded Death Mode scores.
function scoreRows(root,rows){
 root.replaceChildren();for(const s of rows){const tr=document.createElement('tr');for(const value of [s.name,Number(s.score).toLocaleString(),Number.isInteger(s.stage)?s.stage:'—',Number.isFinite(s.played_at)?new Date(s.played_at).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'—']){const td=document.createElement('td');td.textContent=String(value);tr.appendChild(td)}
  if(s.death_mode===true){const skull=document.createElement('img');skull.src='assets/death-skull.png';skull.alt='Death Mode';skull.title='Death Mode run';skull.className='death-run-mark';skull.width=24;skull.height=24;tr.firstElementChild.appendChild(skull)}
  const meta=document.createElement('small');meta.className='score-meta';meta.textContent=(s.gameplay_version||'Unknown version')+' · '+(s.outcome||'Unknown outcome')+' · Curse '+(Number.isInteger(s.statue_modifier)?s.statue_modifier+'%':'unknown');tr.firstElementChild.appendChild(meta);root.appendChild(tr);
 }
}
function localRanking(){return profile.runs.filter(s=>(boardMode==='unknown'?s.death_mode==null:s.death_mode===(boardMode==='death'))&&(boardVersion==='all'||s.gameplay_version===GAMEPLAY_VERSION)).sort((a,b)=>b.score-a.score||b.wave-a.wave||b.seconds-a.seconds).slice(0,25)}
async function loadLeaderboard(){
 const request=++boardRequest;$('#leaderboardRows').replaceChildren();$('#leaderboardStatus').textContent='Loading scores…';
 for(const key of ['normal','death','unknown'])$('#board'+key).setAttribute('aria-pressed',String(key===boardMode));
 scoreRows($('#personalRows'),localRanking());$('#personalStatus').textContent=localRanking().length?'':'No personal results for this filter.';
 try{let r=await fetch('/api/scores?mode='+boardMode+'&version='+(boardVersion==='all'?'all':GAMEPLAY_VERSION),{cache:'no-store'});if(!r.ok)throw new Error('Unavailable');let data=await r.json();if(request!==boardRequest)return;if(!Array.isArray(data.scores))throw new Error('Invalid scores');
  const supported=data.capabilities?.modeFilter===true&&data.capabilities?.versionFilter===true;
  if(!supported){r=await fetch('/api/scores',{cache:'no-store'});if(!r.ok)throw new Error('Unavailable');data=await r.json();if(request!==boardRequest)return;if(!Array.isArray(data.scores))throw new Error('Invalid scores')}
  $('#leaderboardStatus').textContent=supported?(data.scores.length?'Unverified player-reported scores. Versions may not be comparable.':'No scores for this mode/version yet.'):'Legacy combined top 25 · server does not support mode/version filtering. Separated personal results below.';
  scoreRows($('#leaderboardRows'),data.scores);
 }catch{if(request===boardRequest)$('#leaderboardStatus').textContent='Remote leaderboard unavailable. Personal results below; Refresh to retry.'}
}
for(const key of ['normal','death','unknown'])$('#board'+key).onclick=()=>{boardMode=key;loadLeaderboard()};
$('#boardVersion').onchange=e=>{boardVersion=e.target.value;loadLeaderboard()};

// PROFILE & RUN FEEDBACK — safe local records, never permanent gameplay stats.
function captureSummary(defeated){lastSummary={comparisons:compareRun({id:runId,score,stage,seconds:Math.floor(elapsed),outcome:victory?'victory':defeated?'defeat':'ended',death_mode:runDeath,gameplay_version:GAMEPLAY_VERSION},profile.runs,profile.scoreBests),outcome:victory?'VICTORY':defeated?'DEFEATED':'RUN ENDED',stage,seconds:elapsed,build:buildText(),damage:[...runDamage],statues:statueCount,trials:trialCount,modifier:100+difficultyBonus,cause:victory?'Rift Warden defeated':defeated?(BESTIARY[lethalSource]?.[0]||lethalSource||'Unknown source'):'Voluntary end',earned:[...newMilestones]};if(realProgress())persistProfile()}
function renderRunSummary(){
 const box=$('#runDetails');box.replaceChildren();if(!lastSummary)return;const r=lastSummary;
 const lines=[...(r.comparisons||[]),r.outcome+' · STAGE '+r.stage+' · '+formatTime(r.seconds),r.build,'Damage dealt: '+r.damage.map((d,i)=>WEAPONS[i].label+' '+Math.round(d).toLocaleString()).join(' · '),r.statues+' statues · '+r.trials+' trials · Statue curse '+r.modifier+'%','Cause: '+r.cause];
 if(r.earned.length)lines.push('New: '+r.earned.map(k=>k==='trial'?'Trial complete + Skull badge':k==='quarry'?'Iron Maw defeated':'Warden defeated + Ember trail').join(' · '));
 for(const line of lines){const p=document.createElement('p');p.textContent=line;box.appendChild(p)}$('#runReport').classList.remove('hidden');
}
function renderProfile(){
 $('#profileProgress').textContent=['trial','quarry','warden'].map(k=>(profile.milestones.includes(k)?'DONE · ':'LOCKED · ')+(k==='trial'?'Complete a Skull Trial':k==='quarry'?'Defeat Iron Maw':'Defeat the Warden')).join('\n');
 $('#bestiaryRows').replaceChildren();for(const [key,[name,copy]] of Object.entries(BESTIARY)){const e=profile.enemies[key];if(!e?.seen)continue;const item=document.createElement('p'),strong=document.createElement('strong');strong.textContent=name+' · '+e.defeated+' defeated';item.appendChild(strong);const body=document.createElement('span');body.textContent=copy;item.appendChild(body);$('#bestiaryRows').appendChild(item)}
 if(!Object.keys(profile.enemies).length)$('#bestiaryRows').textContent='Encounter monsters in a run to discover them.';
 for(const [id,slot,value] of [['badgeNone','badge','none'],['badgeSkull','badge','skull'],['trailNormal','trail','normal'],['trailEmber','trail','ember']]){const button=$('#'+id);button.disabled=value==='skull'&&!profile.milestones.includes('trial')||value==='ember'&&!profile.milestones.includes('warden');button.setAttribute('aria-pressed',String(profile.cosmetics[slot]===value));button.onclick=()=>{equipCosmetic(profile,slot,value);persistProfile();renderProfile();applyCosmetics()}}
 $('#profileStorage').textContent=debugScenario?'Practice · progress is not saved.':profileSaved?'Saved on this device.':'Storage unavailable · progress lasts this session.';
}
function applyCosmetics(){$('#profileBadge').classList.toggle('hidden',profile.cosmetics.badge!=='skull')}
$('#menuProfile').onclick=$('#pauseProfile').onclick=()=>openPanel('#profile');$('#closeProfile').onclick=closePanel;

// Original horror-synth arrangements; effects retain their independent volume bus.
// AUDIO LIFECYCLE — create/resume from a user gesture; music and effects have separate gain buses.
const audio={ctx:null,master:null,music:null,sfx:null,bus:null,score:null,intensity:new MusicIntensity(),sfxVoices:0,fxTimes:{},silenced:false,step:0,next:0,timer:null,
 apply(){if(!this.master)return;this.master.gain.value=prefs.muted?0:.22*prefs.master/100;this.music.gain.value=prefs.music/100;this.sfx.gain.value=prefs.effects/100},
 start(){this.score?.stop?.();this.intensity.reset();this.step=0;this.fxTimes={};this.unlock();if(this.ctx)this.next=this.ctx.currentTime+.02},
 unlock(){try{
  if(!this.ctx||this.ctx.state==='closed'){
   this.ctx=new (window.AudioContext||window.webkitAudioContext)();this.master=this.ctx.createGain();this.music=this.ctx.createGain();this.sfx=this.ctx.createGain();
   this.master.connect(this.ctx.destination);this.music.connect(this.master);this.sfx.connect(this.master);this.score=createMusicPlayer(this.ctx,this.music);this.apply();this.next=this.ctx.currentTime+.02;
   this.ctx.onstatechange=()=>{if(this.ctx.state==='running')this.next=this.ctx.currentTime+.02};
   if(!this.timer)this.tick();
  }
  // Calling resume on the first creation is essential on browsers that start suspended.
  const resumed=this.ctx.resume();resumed?.catch?.(()=>{$('#audioStatus').textContent='Press Test sound to enable audio.'});
 }catch(error){console.error('Audio startup failed',error);this.ctx?.close?.();this.ctx=null;this.master=this.music=this.sfx=null;$('#audioStatus').textContent='Audio could not start. Press Test sound to retry.'}},
 test(){if(prefs.muted||prefs.master===0||prefs.effects===0){$('#audioStatus').textContent='Unmute and raise Master and Effects to test.';return}this.unlock();if(!this.ctx)return;this.ctx.resume().then(()=>{const n=this.ctx.currentTime+.03;[440,554,660].forEach((f,i)=>this.tone(f,n+i*.13,.24,'triangle',.35));$('#audioStatus').textContent='Playing test tones.'}).catch(()=>{$('#audioStatus').textContent='Audio is blocked by this browser.'})},
 thunder(){if(demoActive||mode!=='play'||!this.ctx||this.ctx.state!=='running'||prefs.muted)return;
  const ctx=this.ctx,source=ctx.createBufferSource(),filter=ctx.createBiquadFilter(),gain=ctx.createGain(),n=ctx.currentTime;
  if(!this.thunderBuffer){this.thunderBuffer=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate);const d=this.thunderBuffer.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1}
  source.buffer=this.thunderBuffer;filter.type='lowpass';filter.frequency.value=350;gain.gain.setValueAtTime(.001,n);gain.gain.linearRampToValueAtTime(.7,n+.12);gain.gain.exponentialRampToValueAtTime(.001,n+1.8);
  source.connect(filter);filter.connect(gain);gain.connect(this.sfx);source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect()};source.start(n);source.stop(n+1.9);this.tone(52,n,1.2,'sine',.25,27);
 },
 tone(f,time,duration,type='triangle',volume=.12,end){if(!this.ctx||this.sfxVoices>=32)return;this.sfxVoices++;const o=this.ctx.createOscillator(),g=this.ctx.createGain();o.type=type;o.frequency.setValueAtTime(f,time);if(end)o.frequency.exponentialRampToValueAtTime(end,time+duration);g.gain.setValueAtTime(.0001,time);g.gain.linearRampToValueAtTime(volume,time+.005);g.gain.exponentialRampToValueAtTime(.0001,time+duration);o.connect(g);g.connect(this.bus||this.sfx);o.onended=()=>{this.sfxVoices=Math.max(0,this.sfxVoices-1);o.disconnect();g.disconnect()};o.start(time);o.stop(time+duration)},
 tick(){if(!this.ctx){this.timer=null;return}
  const audible=this.ctx.state==='running'&&!document.hidden&&!demoActive&&!prefs.muted&&prefs.master>0&&prefs.music>0;
  if(audible){this.silenced=false;this.next=Math.max(this.next,this.ctx.currentTime);
   const target=mode!=='play'||overlay?'quiet':bossSpawned||quarryState==='active'?'boss':trial?.state==='active'?'trial':'normal';
   const gain=prefs.music/100*(target==='quiet'?.35:1);if(this.music.gain.setTargetAtTime)this.music.gain.setTargetAtTime(gain,this.ctx.currentTime,.12);else this.music.gain.value=gain;
   while(this.next<this.ctx.currentTime+.12){this.score.schedule(this.step,this.next,runDeath,.85,this.intensity.at(this.step,target));this.step++;this.next+=60/runTuning.bpm/4}
  }else{this.next=this.ctx.currentTime+.02;if(!this.silenced){this.score?.stop?.();this.silenced=true}}
  this.timer=setTimeout(()=>this.tick(),40);
 },
 fx(type){if(demoActive||!this.ctx||this.ctx.state!=='running'||prefs.muted)return;const n=this.ctx.currentTime,minGap=type.startsWith('warn')?.3:type==='kill'||type==='gem'?.065:.03;if(n-(this.fxTimes[type]??-100)<minGap)return;this.fxTimes[type]=n;const tones={warnCharge:[125,.21,'sawtooth',.055,280],warnAim:[720,.1,'triangle',.045,420],warnGround:[180,.24,'triangle',.06,95],warnRing:[450,.2,'sine',.055,650],proc:[680,.09,'triangle',.045,980],rifle:[600,.065,'sawtooth',.09,130],smg:[850,.045,'square',.045,230],shotgun:[180,.14,'sawtooth',.23,40],rail:[1600,.23,'sawtooth',.1,130],rocket:[120,.25,'sawtooth',.2,35],explosion:[90,.3,'sawtooth',.25,24],hurt:[140,.17,'sawtooth',.15,45],kill:[180,.06,'triangle',.06,65],gem:[1100,.07,'sine',.06,1600],dash:[220,.18,'sawtooth',.12,880],charge:[160,.35,'sawtooth',.1,500],mortar:[350,.12,'triangle',.07,130],switch:[350,.05,'triangle',.1,600]};if(type==='level'){[440,554,660,880].forEach((f,i)=>this.tone(f,n+i*.08,.25,'triangle',.13));return}const a=tones[type];if(a){this.tone(a[0],n,a[1],a[2],a[3],a[4]);if(type==='rifle')this.tone(1800,n,.02,'triangle',.035,700);if(type==='shotgun')this.tone(62,n,.19,'triangle',.08,30);if(type==='rail')this.tone(2600,n,.12,'sine',.045,320);if(type==='rocket')this.tone(58,n,.22,'triangle',.08,26)}}
};
function soundIsSilent(){return prefs.muted||prefs.master===0||(prefs.music===0&&prefs.effects===0)}
$('#sound').onclick=()=>{if(soundIsSilent()){prefs.muted=false;if(prefs.master===0)prefs.master=100;if(prefs.music===0&&prefs.effects===0){prefs.music=70;prefs.effects=100}audio.unlock()}else prefs.muted=true;savePrefs();audio.apply();syncSettings()};
$('#testSound').onclick=()=>audio.test();
for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>{if(!demoActive&&!prefs.muted&&audio.ctx?.state!=='running')audio.unlock()},{capture:true});

// Attract mode uses the same simulation as a run; only its input comes from a CPU.
// It never starts audio, creates a score submission, or reads the user's controls.
// ATTRACT DEMO — CPU input drives real gameplay while the main menu is open.
function updateDemo(dt){
 if(document.hidden||overlay)return;
 if(!demoActive||demoFinished||demoAge>80){demoStage=demoActive?demoStage%STAGES.length+1:1;start(true)}
 const steps=3,step=dt*1.5/steps;
 for(let i=0;i<steps;i++){
  demoAge+=step;demoWeaponTime-=step;
  if(demoWeaponTime<=0){equip((selected+1)%WEAPONS.length);demoWeaponTime=7}
  let target=null,distance=Infinity;
  for(const e of enemies){const d=Math.hypot(e.x-player.x,e.z-player.z);if(e.hp>0&&d<distance){target=e;distance=d}}
  demoFiring=!!target;
  if(target){aim=Math.atan2(target.x-player.x,target.z-player.z);aimPitch=pitchTo(player.x,height(player.x,player.z)+1.47,player.z,target.x,target.c.g.position.y+1.2*target.c.g.scale.y,target.z);
   if(distance>10)demoInput=terrain.steer(player.x,player.z,target.x,target.z,player);
   else{const a=aim+Math.PI/2;demoInput={x:Math.sin(a)*.85-Math.sin(aim)*(distance<5?.7:0),z:Math.cos(a)*.85-Math.cos(aim)*(distance<5?.7:0)};const n=Math.max(1,Math.hypot(demoInput.x,demoInput.z));demoInput.x/=n;demoInput.z/=n}
   if(distance<4&&player.dashCD<=0)dash();
  }else demoInput={x:0,z:0};
  if(portalActive)demoInput=terrain.steer(player.x,player.z,stagePortal.position.x,stagePortal.position.z,player);
  update(step);updateEffects(step);
  if(demoFinished)break;
 }
}

let last=performance.now(),slowFrames=0;const framePacer=new FramePacer(),simulationClock=new SimulationClock();
// Rendering is capped separately; combat, weather and effect lifetimes share fixed steps.
function frame(now){
 requestAnimationFrame(frame);const raw=(now-last)/1000;last=now;pollPad();if(debugScenario)updateDevMetrics(raw);
 simulationClock.advance(raw,!document.hidden,dt=>{
  updateSkull(dt);
  if(mode==='menu'||mode==='dead')updateDemo(dt);
  else if(mode==='play'&&!overlay){update(dt);updateEffects(dt)}
  cameraUpdate(dt,elapsed);statueWorld?.face(camera);
  if(prefs.nightmare&&(mode==='play'||demoActive)&&!overlay){Object.assign(scene.fog,fogRange(prefs.fog,true,camera.position.distanceTo(hero.g.position)));if(storm.update(dt,elapsed,player,height(player.x,player.z)))audio.thunder()}
  updateCombatUI(dt);if(mode==='play')updateHUD();
  return !['pause','upgrade'].includes(mode)&&!overlay;
 });
 if(framePacer.ready(now,prefs.fpsCap)){const renderStart=debugScenario?performance.now():0;renderer.info.reset();composer.render();if(debugScenario){devRenders++;devCosts.render.push(performance.now()-renderStart);if(devCosts.render.length>120)devCosts.render.shift()}}
 if(raw>.045)slowFrames++;else slowFrames=Math.max(0,slowFrames-1);if(slowFrames>100&&!qualityReduced&&prefs.pixelation==='auto'){qualityReduced=true;const r=retroSize();composer.setSize(r.w,r.h)}
}
// ENCOUNTER OBJECTS — anchors/nodes accept all weapon damage, but award no kills/XP/drops.
function combatTargets(){return [...enemies,...encounterObjects]}
function addEncounterObject(kind,p,hp,owner){
 const g=new T.Group();g.position.set(p.x,height(p.x,p.z),p.z);actors.add(g);
 mesh('box','#625c76',0,.25,0,1.25,.5,1.25,g);mesh('gem',kind==='anchor'?'#b887bc':'#e1ae74',0,1.3,0,.65,1.1,.65,g,1);
 const o={fixed:true,kind,owner,id:crypto.randomUUID(),x:p.x,z:p.z,hp,max:hp,def:{radius:.85},c:{g}};if(kind==='anchor'){o.link=effectLine({x:p.x,y:height(p.x,p.z)+1.3,z:p.z},{x:p.x,y:height(p.x,p.z)+1.3,z:p.z},'#b887bc')}encounterObjects.push(o);return o;
}
function hurtObject(o,damage,source){
 if(o.hp<=0)return;const actual=Math.min(o.hp,damage);o.hp-=actual;if(Number.isInteger(source.sourceWeapon))runDamage[source.sourceWeapon]+=actual;damageText(o.x,o.z,actual,false);hitMarker=.12;
 if(o.hp<=0){actors.remove(o.c.g);if(o.link)effects.remove(o.link);nodeCharge?.destroy(o.id);burst(o.x,1,o.z,'#e4bc84',15,3)}
}
function clearTrialObjects(){for(const b of shots)if(b.emitter?.trialId===trial?.id&&trial)effects.remove(b.m);shots=shots.filter(b=>!trial||b.emitter?.trialId!==trial.id);for(const h of hazards)if(trial&&h.owner===trial.id){disposeMarker(h.m)}hazards=hazards.filter(h=>!trial||h.owner!==trial.id);for(const o of encounterObjects)if(o.owner===trial?.id){actors.remove(o.c.g);if(o.link)effects.remove(o.link)};encounterObjects=encounterObjects.filter(o=>o.owner!==trial?.id);for(const v of vents)disposeMarker(v.m);vents=[]}
function clearChallenges(){for(const o of encounterObjects){actors.remove(o.c.g);if(o.link)effects.remove(o.link)};encounterObjects=[];for(const v of vents)disposeMarker(v.m);vents=[];nodeCharge=null;for(const h of hazards||[])if(h.kind==='warden-node'){h.life=0;disposeMarker(h.m)}if(typeof hazards!=='undefined')hazards=hazards.filter(h=>h.kind!=='warden-node')}
function startQuarry(){
 if(!['dormant','waiting'].includes(quarryState))return;
 if(trial?.state==='active'){quarryState='waiting';toast('IRON MAW AWAITS · COMPLETE OR ABANDON TRIAL IN PAUSE');return}
 quarryState='active';for(const e of enemies.filter(e=>e.hp>0).slice(6)){removeEnemy(e);e.hp=0}enemies=enemies.filter(e=>e.hp>0);
 const e=spawnEnemy('charger',terrain.safeNear(10,-8,1.35));e.miniboss=true;e.def={...e.def,radius:1.35,damage:28,score:1400,xp:18};e.hp=e.max=CHALLENGE.quarryHP*difficultyScale();e.c.g.scale.multiplyScalar(1.35);e.cool=1.5;e.state='approach';player.inv=2;toast('IRON MAW · BAIT ITS CHARGE INTO SOLID COVER');
}
function quarryUpdate(e,dt){
 const dx=player.x-e.x,dz=player.z-e.z,d=Math.hypot(dx,dz)||1;
 if(e.state==='stagger'){e.timer-=dt;if(e.timer<=0){e.state='approach';e.cool=1.8}}
 else if(e.state==='windup'){e.timer-=dt;if(e.timer<=0){e.state='charge';e.timer=CHALLENGE.quarryCharge;if(e.warning)e.warning.material.opacity=.3}}
 else if(e.state==='charge'){
  const from={x:e.x,y:height(e.x,e.z)+1,z:e.z},distance=CHALLENGE.quarrySpeed*runTuning.speed*difficultyScale()*dt,to={x:e.x+e.ax*distance,y:from.y,z:e.z+e.az*distance};
  const cover=traceWorld(from,to,{height:()=>-10000,covers:stageWorld.covers},e.def.radius*.8);
  if(quarryImpact(e.state,cover)){e.state='stagger';e.timer=CHALLENGE.quarryStagger;clearWarning(e);ring(e.x,e.z,'#e8cc80',3,.5);toast('IRON MAW STAGGERED')}
  else{moveWithCollision(e,e.ax*distance,e.az*distance,e.def.radius);e.timer-=dt;if(e.timer<=0){e.state='approach';e.cool=2.2;clearWarning(e)}}
 }else if(e.cool<=0&&d<24){e.state='windup';e.timer=CHALLENGE.quarryWindup;e.ax=dx/d;e.az=dz/d;warnLine(e,18,'#eabf73')}
 else{const v=terrain.steer(e.x,e.z,player.x,player.z,e);moveWithCollision(e,v.x*3*runTuning.speed*difficultyScale()*dt,v.z*3*runTuning.speed*difficultyScale()*dt,e.def.radius)}
 if(d<e.def.radius+.45)hurtPlayer(e.state==='charge'?34:18,'Iron Maw');e.c.g.position.set(e.x,height(e.x,e.z),e.z);e.c.g.rotation.y=['windup','charge'].includes(e.state)?Math.atan2(e.ax,e.az):Math.atan2(dx,dz);animateCharacter(e.c,elapsed,e.state==='stagger'?0:1);
}
function addVent(p){const m=dangerMarker(height,p.x,p.z,2.2,'vent');effects.add(m);vents.push({m,x:p.x,z:p.z,phase:'warning',timer:CHALLENGE.ventWarning,tick:0})}
function updateVents(dt){for(const v of vents){if(trial?.state!=='active')break;v.timer-=dt;if(v.timer<=0){v.phase=v.phase==='warning'?'active':v.phase==='active'?'recovery':'warning';v.timer=v.phase==='active'?CHALLENGE.ventActive:v.phase==='recovery'?CHALLENGE.ventRecovery:CHALLENGE.ventWarning;if(v.phase==='active')v.tick=0;if(v.phase==='warning')audio.fx('warnGround')}
 v.m.material.opacity=v.phase==='active'?.95:v.phase==='recovery'?.18:.45+.4*(1-v.timer/CHALLENGE.ventWarning);v.m.material.wireframe=v.phase==='recovery';
 if(v.phase==='active'){v.tick-=dt;if(v.tick<=0){v.tick=.5;explode(v.x,v.z,2.2,CHALLENGE.ventDamage,true,undefined,{source:'Trial vent',environment:true,friendlyFire:true})}}}}
function updateNodeEvent(e,dt){
 if(e.recovery>0){e.recovery-=dt;return true}
 if(nodeCharge){
  const result=nodeCharge.tick(dt);if(result==='charging')return true;
  const interrupted=result==='interrupted';for(const o of encounterObjects)if(o.owner==='warden')actors.remove(o.c.g);encounterObjects=encounterObjects.filter(o=>o.owner!=='warden');nodeCharge=null;
  if(interrupted){e.recovery=2.5;toast('RIFT INTERRUPTED · WARDEN EXPOSED')}
  else{const a=Math.atan2(player.x-e.x,player.z-e.z);for(const side of [-1,0,1])hazard(player.x+Math.cos(a)*side*4,player.z-Math.sin(a)*side*4,2.6,42,1.5,'warden-node');toast('RIFT COLLAPSE · LEAVE THE MARKED GROUND')}
  e.state='approach';e.cool=3;e.nodeCooldown=CHALLENGE.nodeCooldown;return true;
 }
 if(!e.enraged)return false;e.nodeCooldown=(e.nodeCooldown??4)-dt;
 if(e.nodeCooldown<=0&&(e.nodeEvents||0)<CHALLENGE.nodeEvents&&e.state==='approach'&&!hazards.length){
  const origin={x:player.x,y:height(player.x,player.z)+1.47,z:player.z},candidates=[[-5,3],[5,-3],...Array.from({length:12},(_,i)=>[Math.sin(i*Math.PI/6)*6,Math.cos(i*Math.PI/6)*6])],sites=[];
  for(const [dx,dz] of candidates){const p=terrain.safeNear(e.x+dx,e.z+dz,1);if(Math.hypot(p.x-player.x,p.z-player.z)>30||sites.some(s=>Math.hypot(s.x-p.x,s.z-p.z)<3)||traceWorld(origin,{x:p.x,y:height(p.x,p.z)+1.3,z:p.z},shotWorld(),0))continue;sites.push(p);if(sites.length===2)break}
  // Retry later while normal attacks continue if no fair pair is visible.
  if(sites.length<2){e.nodeCooldown=2;return false}
  const nodes=sites.map(p=>addEncounterObject('node',p,CHALLENGE.nodeHP,'warden'));nodeCharge=new NodeCharge(nodes.map(o=>o.id));e.nodeEvents=(e.nodeEvents||0)+1;clearWarning(e);toast('RIFT NODES · BREAK BOTH TO INTERRUPT');return true;
 }return false;
}

// SCENE ADAPTER — secondary effects cannot bypass the existing 3D sweep or damage path.
function effectLine(from,to,color){const m=mesh('box',color,0,0,0,.09,.09,1,effects,1);updateEffectLine(m,from,to);return m}
function updateEffectLine(m,a,b){m.position.set((a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2);m.scale.z=Math.max(.05,Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z));m.lookAt(b.x,b.y,b.z)}
combatEffects=new CombatEffects({
 event:buildCue,build:()=>build,targets:combatTargets,center:e=>({x:e.x,y:height(e.x,e.z)+1.2,z:e.z}),
 clear:(a,b)=>!traceWorld(a,b,shotWorld(),0),damage:hurtEnemy,move:(e,x,z)=>moveWithCollision(e,x,z,e.def.radius),
 hit:(a,b,e)=>hitBody(a,b,bodyBounds(e,true))!==null,
 line:effectLine,lineUpdate:updateEffectLine,remove:m=>effects.remove(m),
 flash(a,b,c){const m=effectLine(a,b,c);rings.push({m,life:.18,max:.18,size:1,ownMat:false,line:true})},
 orb(p,r,c){const m=mesh('torus',c,p.x,p.y,p.z,r,.4,r,effects,1);m.rotation.x=Math.PI/2;return m},
 explode:(p,b)=>explode(p.x,p.z,b.radius,b.damage,false,p.y,b),
 secondary(b,p,angle,factor,range){
  const origin={x:p.x+Math.sin(angle)*.12,y:p.y,z:p.z+Math.cos(angle)*.12};if(traceWorld(p,origin,shotWorld(),0))return;
  return projectile(origin.x,origin.z,angle,{...WEAPONS[b.sourceWeapon],damage:1,range,rocket:false,pierce:0},false,{y:p.y,pitch:Math.atan2(b.vy,Math.hypot(b.vx,b.vz)),damage:b.damage*factor,sourceWeapon:b.sourceWeapon,shotId:b.shotId,generation:1,group:b.group,hitIds:new Set(b.hitIds),pierce:player.pierce});
 }
});
dashEffects=new DashEffects({
 event:buildCue,trait:()=>build.dash,
 valid:(a,b)=>terrain.walkable(a.x,a.z,.45)&&terrain.canMove(a.x,a.z,b.x,b.z,.45)&&!traceWorld(a,b,shotWorld(),0),
 line:(a,b)=>effectLine(a,b,profile.cosmetics.trail==='ember'?'#f2af78':'#9dacc7'),
 ghost(p){const g=hero.g.clone(true);g.position.set(p.x,p.y-1.47,p.z);g.traverse(m=>{if(m.isMesh){m.material=m.material.clone();m.material.transparent=true;m.material.opacity=.4;if(profile.cosmetics.trail==='ember')m.material.color?.set('#f2af78')}});effects.add(g);g.userData.ghost=true;return g},
 remove(g){effects.remove(g);if(g.userData?.ghost)g.traverse(m=>{if(m.isMesh)m.material.dispose()})},
 fire(origin,target,volley){
  const w=WEAPONS[volley.weapon],angle=Math.atan2(target.x-origin.x,target.z-origin.z),pitch=pitchTo(origin.x,origin.y,origin.z,target.x,target.y,target.z);
  let made=0;for(let i=0;i<volley.count;i++){const offset=(i-(volley.count-1)/2)*w.spread;if(projectile(origin.x,origin.z,angle+offset,w,false,{y:origin.y,pitch,damage:w.damage*volley.damage*BALANCE.echoDamage,sourceWeapon:volley.weapon,shotId:volley.shotId,generation:1,group:volley.group}))made++}return made;
 }
});
applyCosmetics();window.gameReady=true;$('#tutorial').disabled=false;$('#start').disabled=false;$('#start').textContent='START RUN';$('#loadNote').textContent='';refreshHelp();syncSettings();start(true);requestAnimationFrame(frame);

// DEVELOPER PRACTICE — only loopback + explicit scenario query enables these controls.
// Scores and profile storage are disabled for the entire page, including retries.
let devFrames=0,devRenders=0,devSeconds=0,devCutawayOff=false;const devCosts={camera:[],render:[]};
function updateDevMetrics(dt){devFrames++;devSeconds+=dt;if(devSeconds>=1){$('#devMetrics').textContent=Math.round(devRenders/devSeconds)+' rendered FPS · '+shots.length+' shots · '+combatEffects.scars.length+' scars · '+combatEffects.pulls.length+' pulls · '+(devCosts.camera.reduce((a,b)=>a+b,0)/(devCosts.camera.length||1)).toFixed(3)+'ms cutaway CPU · '+(devCosts.render.reduce((a,b)=>a+b,0)/(devCosts.render.length||1)).toFixed(2)+'ms render submit · '+renderer.info.render.calls+' calls';devFrames=devRenders=devSeconds=0}}
function startScenario(name=debugScenario){
 runRandom=randomSource(Number(new URLSearchParams(window.location.search).get('seed'))||7361);closePanel();mode='menu';setDeathMode($('#devDeath').checked);$('#playerName').value='Developer';start();runSeed=Number(new URLSearchParams(window.location.search).get('seed'))||7361;
 stage=({quarry:2,caldera:3,citadel:4,warden:5})[name]||1;stageKills=0;stageGoal=STAGES[stage-1].goal;setStageDecor();player.hp=player.max=1000;player.inv=10000;
 if(name==='mods'){build.mods=[0,1,2,3,4];player.extra=2;player.pierce=2;player.damage=2;player.rate=1.5}
 if(name==='quarry'||name==='warden'){stageKills=stageGoal;activatePortal()}
 if(name==='caldera'||name==='citadel'){beginTrial(statueWorld.statues[0]);const p=terrain.safeNear(trial.statue.x+3,trial.statue.z, .45);player.x=p.x;player.z=p.z}
 if(name==='rewards'){rewards.add('dev-mod','major');rewards.add('dev-upgrade','ordinary');rewards.add('dev-dash','dash');showReward()}
 $('#modeBadge').textContent='PRACTICE · '+(runDeath?'DEATH':'NORMAL')+' · NO SCORES';updateHUD();
}
if(debugScenario){
 $('#devTools').classList.remove('hidden');$('#devScenario').value=debugScenario;$('#devReset').onclick=()=>startScenario($('#devScenario').value);
 $('#devTrial').onclick=()=>{if(mode==='play'&&trial?.state==='available')beginTrial(statueWorld.statues[0])};
 $('#devObjective').onclick=()=>{if(mode!=='play')return;if(trial?.state==='active'){for(let n=0;n<8&&trial.state==='active';n++)for(const e of [...enemies])if(e.trialId===trial.id)hurtEnemy(e,1e8)}else{const boss=enemies.find(e=>e.miniboss||e.kind==='warden');if(boss)hurtEnemy(boss,1e8);else{for(let n=0;n<stageGoal&&stageKills<stageGoal;n++)hurtEnemy(spawnEnemy('runner'),1e8)}}showReward()};
 $('#devPortal').onclick=()=>{if(portalActive&&mode==='play'){player.x=stagePortal.position.x;player.z=stagePortal.position.z}};
 $('#devNodes').onclick=()=>{for(const o of encounterObjects)hurtEnemy(o,1e8)};
 $('#devPhase').onclick=()=>{const boss=enemies.find(e=>e.kind==='warden');if(boss){boss.hp=boss.max*.4;boss.nodeCooldown=0}};
 $('#devCamera').onclick=()=>{const c=stageWorld.covers.find(c=>c.sy>4&&Math.hypot(c.x,c.z)<50);if(c){const p=terrain.safeNear(c.x,c.z-4,.45);player.x=p.x;player.z=p.z;cameraYaw=Math.atan2(c.x-p.x,c.z-p.z)}};
 $('#devZoom').onclick=()=>{cameraDistance=cameraDistance<25?40:16};
 $('#devCutaway').onclick=()=>{devCutawayOff=!devCutawayOff;$('#devCutaway').textContent=devCutawayOff?'Enable cutaway':'Disable cutaway'};
 $('#devCosmetics').onclick=()=>{profile.milestones=['trial','quarry','warden'];equipCosmetic(profile,'badge','skull');equipCosmetic(profile,'trail','ember');applyCosmetics()};
 startScenario();
}
