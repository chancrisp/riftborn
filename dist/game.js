import {POWERUPS,DROP_LIFETIME,MAX_DROPS,STATUE_BONUS,rollPowerup,createBoons,collectBoon,tickBoons,absorbDamage,createStatues} from './encounters.js?v=13';
import {createTutorial,tutorialCopy,TUTORIAL_PORTAL,TUTORIAL_GOAL} from './tutorial.js?v=13';
import {createStorm} from './storm.js?v=13';
import {createMusicPlayer} from './soundtrack.js?v=13';
import {renderHeight,fogRange,FramePacer} from './graphics.js?v=13';
import * as T from 'three';
import {traceWorld,hitBody,pointAt} from './ballistics.js?v=13';
import {retroMaterial,retroCharacter,retroResolution,RetroShader} from './retro.js?v=13';
import {ShaderPass} from './vendor/postprocessing/ShaderPass.js';
import { createTerrain } from './terrain.js?v=13';
import { buildStageWorld } from './scenery.js?v=13';
import { EffectComposer } from './vendor/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/postprocessing/RenderPass.js';
import { OutputPass } from './vendor/postprocessing/OutputPass.js';
import { WEAPONS, ENEMY_TYPES, DEATH_TYPES, RUN_MODES, enemyPool, segmentHit, movementVector } from './rules.js?v=13';
import { DEFAULT_BINDINGS, ACTION_LABELS, keyLabel, loadPreferences, assignBinding } from './preferences.js?v=13';

const $ = s => document.querySelector(s);
let prefs;try{prefs=loadPreferences(window.localStorage)}catch{prefs=loadPreferences(null)}
function savePrefs(){try{window.localStorage.setItem('neon-crypt-preferences-v1',JSON.stringify(prefs))}catch{}}
const rand = (a,b) => a + Math.random()*(b-a);
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
 statueWorld?.dispose();statueWorld=null;stageWorld?.dispose();terrain=createTerrain(stage,runSeed,{tutorial:!!tutorial});stageWorld=buildStageWorld(terrain);world.add(stageWorld.group);if(!tutorial){statueWorld=createStatues(terrain,stageWorld,runSeed+stage*107);world.add(statueWorld.group)}
 const [px,pz]=tutorial?TUTORIAL_PORTAL:STAGES[stage-1].portal;stagePortal.position.set(px,height(px,pz)+2.7,pz);stagePortal.rotation.set(0,0,0);stagePortal.visible=portalActive;
 applyLighting();
}
// PROGRESSION — called when the kill goal is reached; the final stage summons the boss.
function activatePortal(){if(stage===STAGES.length){summonBoss();return}if(portalActive)return;portalActive=true;stagePortal.visible=true;toast(tutorial?'TRAINING RIFT OPEN':'RIFT PORTAL OPEN · '+STAGES[stage-1].name);for(let i=0;i<90;i++){const [x,z]=tutorial?TUTORIAL_PORTAL:STAGES[stage-1].portal;burst(x,rand(.8,6),z,'#b974ff',1,3)}audio.fx('level');updateHUD()}
// RIFT ENTRY — tutorials finish here; normal runs retain upgrades and statue difficulty.
function enterStage(){if(!portalActive)return;if(tutorial){finishTutorial(true);return}if(stage>=STAGES.length)return;for(const g of gems)player.xp+=g.v;for(const p of powerups)effects.remove(p.m);powerups=[];clearInput();player.vx=player.vz=0;player.dashing=0;player.inv=2;stage=Math.min(stage+1,STAGES.length);stageKills=0;stageGoal=STAGES[stage-1]?.goal||stageGoal+18;portalActive=false;for(const e of enemies)removeEnemy(e);clearObjects(shots);clearObjects(hazards);clearObjects(gems);clearObjects(particles);clearObjects(rings);particles=[];rings=[];numbers.forEach(n=>n.el.remove());numbers=[];enemies=[];shots=[];hazards=[];gems=[];player.x=0;player.z=0;player.hp=Math.min(player.max,player.hp+25);setStageDecor();toast('STAGE '+stage+' · '+STAGES[stage-1].name+' · SHARDS COLLECTED · +25 HEALTH');audio.fx('level');burst(0,1,0,'#d3a0ff',40,5);updateHUD()}

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
function escapeMenu(){if(['menu','dead'].includes(mode)&&(!overlay||overlay==='#runSetup')&&menuDeath){if(overlay)closePanel();setDeathMode(false);return}pause()}
function updateSkull(dt){if(!['menu','dead'].includes(mode)||overlay)return;if(!reduced&&!skullHeld)skullTime+=dt;const x=.5+Math.sin(skullTime*.23+.8)*.39,y=.5+Math.cos(skullTime*.23+.8)*.38;$('#deathSkull').style.left=Math.round(12+x*Math.max(0,innerWidth-104))+'px';$('#deathSkull').style.top=Math.round(12+y*Math.max(0,innerHeight-104))+'px'}
$('#deathSkull').onclick=()=>setDeathMode(!menuDeath);
$('#deathSkull').onpointerenter=$('#deathSkull').onfocus=()=>skullHeld=true;
$('#deathSkull').onpointerleave=$('#deathSkull').onblur=()=>skullHeld=false;
let enemies=[],shots=[],particles=[],gems=[],hazards=[],rings=[],numbers=[];
let selected=0,cameraYaw=.35,cameraDistance=25,aim=0,aimPitch=0,fireTimer=0,toastTimer;
let touchFire=false,overlay=null,overlayReturn='menu',bindingAction=null,runId=null,runName='Player',pendingScores=new Map(),savingScores=false,padFireLocked=false;
let keys={},mouse={x:0,y:0,moved:false,down:false,orbit:false},moveStick={x:0,y:0},aimStick={x:0,y:0},gamepadAim={x:0,y:0},gamepadFire=false,prevPad=[];
const raycaster=new T.Raycaster(),floorPlane=new T.Plane(new T.Vector3(0,1,0),-1),aimPoint=new T.Vector3();
// PLAYER DEFAULTS — health, movement, weapon bonuses and dash timers reset for each run.
function freshPlayer(){return {x:0,z:0,vx:0,vz:0,hp:100,max:100,xp:0,next:10,level:1,speed:6.4,damage:1,rate:1,pierce:0,extra:0,crit:.1,magnet:3.8,dashCD:0,dashing:0,inv:0,dx:0,dz:1,regen:0}}
player=freshPlayer();
function clearObjects(list){for(const o of list)if(o.m){effects.remove(o.m);if(o.ownMat)o.m.material.dispose()}}
// RUN RESET — demo and tutorial never receive leaderboard run IDs. Clear temporary bonuses here.
function start(demo=false,training=false){
 for(const p of powerups)effects.remove(p.m);powerups=[];boons=createBoons();difficultyBonus=0;
 tutorial=training?createTutorial():null;document.body.classList.toggle('tutorial-active',training);$('#tutorialGuide').classList.toggle('hidden',!training);$('#endRun').textContent=training?'EXIT TUTORIAL':'END RUN & SAVE SCORE';
 runDeath=!training&&menuDeath;runTuning=runDeath?RUN_MODES.death:RUN_MODES.normal;
 demoActive=demo===true;demoFinished=false;demoAge=0;demoWeaponTime=0;demoInput={x:0,z:0};demoFiring=false;
 clearInput();runId=demoActive||tutorial?null:crypto.randomUUID();runName=demoActive?'CPU':($('#playerName').value||'').trim().slice(0,16)||'Player';
 for(const e of enemies)removeEnemy(e);clearObjects(shots);clearObjects(particles);clearObjects(gems);clearObjects(hazards);clearObjects(rings);numbers.forEach(n=>n.el.remove());
 enemies=[];shots=[];particles=[];gems=[];hazards=[];rings=[];numbers=[];runSeed=(Math.random()*4294967296)>>>0;player=freshPlayer();elapsed=0;wave=1;score=0;kills=0;bossSpawned=false;victory=false;hitMarker=0;stage=1;stageKills=0;stageGoal=tutorial?TUTORIAL_GOAL:STAGES[0].goal;portalActive=false;spawnTimer=.8;fireTimer=0;selected=0;aimPitch=0;mode='play';cameraYaw=.35;cameraDistance=25;shake=hit=recoil=0;if(demoActive){stage=demoStage;stageGoal=STAGES[stage-1].goal;mode='menu';player.damage=1.6;player.rate=1.25;player.regen=3;player.hp=player.max=160}setStageDecor();if(tutorial)player.regen=20;
 if(demoActive){hero.g.visible=true;equip(0);for(let i=0;i<8;i++){const a=i*Math.PI/4;spawnEnemy(null,{x:Math.sin(a)*14,z:Math.cos(a)*14})}return}
 $('#menu').classList.add('hidden');$('#choice').classList.add('hidden');$('#pauseMenu').classList.add('hidden');hero.g.visible=true;
 document.body.classList.add('in-run');document.body.classList.remove('menu-open');
 equip(0);audio.start();if(!tutorial)toast('STAGE 1 · MEADOWS');updateHUD();
}
// WEAPON SELECTION — changes the model, highlighted slot and tutorial progress.
function equip(i){selected=(i+WEAPONS.length)%WEAPONS.length;hero.gunMount.remove(hero.weapon);hero.weapon=weaponModel(selected,hero.gunMount);document.querySelectorAll('.weapon').forEach((b,n)=>{b.classList.toggle('active',n===selected);b.setAttribute('aria-pressed',String(n===selected))});fireTimer=Math.min(fireTimer,.16);if(mode==='play')audio.fx('switch');tutorialEvent('weapon',selected)}
WEAPONS.forEach((w,i)=>{const b=document.createElement('button');b.className='weapon';b.style.setProperty('--rarity',w.color);b.title=`${i+1}: ${w.label} — ${w.description}`;b.setAttribute('aria-label',b.title);b.innerHTML=`<span class="num">${i+1}</span><span class="weapon-sprite sprite-${i}" aria-hidden="true"></span><span class="name">${w.label}</span><span class="kind">${w.kind}</span>`;b.onclick=()=>equip(i);$('#weapons').appendChild(b)});equip(0);
function clearInput(){keys={};mouse.down=false;mouse.orbit=false;touchFire=false;gamepadFire=false;padFireLocked=true;moveStick.x=moveStick.y=aimStick.x=aimStick.y=0;for(const id of ['#moveStick','#aimStick'])$(id).querySelector('span').style.transform='none'}
function held(action){return !!keys[prefs.bindings[action]]}
// PAUSE — clear held inputs so resume cannot accidentally fire or keep moving.
function pause(){if(overlay){closePanel();return}if(mode==='play'){clearInput();mode='pause';document.body.classList.add('menu-open');$('#pauseStats').textContent=`STAGE ${stage} · ${score.toLocaleString()} SCORE · ${formatTime(elapsed)}`;$('#pauseMenu').classList.remove('hidden');$('#resume').focus()}else if(mode==='pause'){clearInput();mode='play';document.body.classList.remove('menu-open');$('#pauseMenu').classList.add('hidden')}}
// DASH — duration, cooldown and invulnerability are in seconds; movement still checks collision.
function dash(){if((mode!=='play'&&!demoActive)||player.dashCD>0)return;const v=inputMovement();let l=Math.hypot(v.x,v.z);player.dx=l>.1?v.x/l:Math.sin(aim);player.dz=l>.1?v.z/l:Math.cos(aim);player.dashing=.22;player.dashCD=1.8;player.inv=.35;tutorialEvent('dash');burst(player.x,1,player.z,'#98ffff',25,5);audio.fx('dash')}
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
function pollPad(){const p=navigator.getGamepads?.()[0];gamepadAim={x:0,y:0};gamepadFire=false;if(!p)return;const dead=v=>Math.abs(v)>.16?v:0;gamepadAim={x:dead(p.axes[2]||0),y:dead(p.axes[3]||0)};if(!p.buttons[7]?.pressed)padFireLocked=false;gamepadFire=!padFireLocked&&!!p.buttons[7]?.pressed;const rising=i=>p.buttons[i]?.pressed&&!prevPad[i];if(mode==='play'&&!overlay){if(rising(0))dash();if(rising(2))interact();if(rising(4))equip(selected-1);if(rising(5))equip(selected+1)}if(rising(9))pause();prevPad=p.buttons.map(b=>b.pressed)}
function inputMovement(){if(demoActive)return demoInput;let x=(held('right')?1:0)-(held('left')?1:0),y=(held('back')?1:0)-(held('forward')?1:0);if(Math.hypot(moveStick.x,moveStick.y)>.05){x=moveStick.x;y=moveStick.y}const p=navigator.getGamepads?.()[0];if(p&&Math.hypot(p.axes[0],p.axes[1])>.17){x=p.axes[0];y=p.axes[1]}return movementVector(x,y,cameraYaw)}
function moveWithCollision(o,dx,dz,r){terrain.move(o,dx,dz,r)}
// ENEMY SPAWNING — base stats come from rules.js; training and run difficulty apply here.
function spawnEnemy(kind,near=null){
 const unlocked=enemyPool(STAGES[stage-1]?.pool||Object.keys(ENEMY_TYPES),runDeath,stage);
 kind=kind||unlocked[Math.floor(rand(0,unlocked.length))];const def=tutorial?{...ENEMY_TYPES[kind],hp:24,speed:1,damage:3,score:0,xp:0}:kind==='warden'?{hp:1300,speed:1.8,radius:1.35,damage:24,score:5000,xp:0,color:'#c78dff'}:(ENEMY_TYPES[kind]||DEATH_TYPES[kind]),a=rand(0,Math.PI*2),r=rand(17,23);
 const location=near?terrain.safeNear(near.x,near.z,def.radius):terrain.spawn(player.x,player.z,def.radius);let {x,z}=location;
 const c=character(kind);actors.add(c.g);c.g.position.set(x,height(x,z),z);
 const difficulty=(1+(stage-1)*.22+Math.min(wave-1,20)*.05)*difficultyScale();
 const bar=document.createElement('div'),fill=document.createElement('i');bar.className='enemy-health';bar.appendChild(fill);$('#damageNumbers').appendChild(bar);
 enemies.push({bar,fill,warning:null,attackIndex:0,enraged:false,id:crypto.randomUUID(),kind,def,c,x,z,hp:def.hp*difficulty,max:def.hp*difficulty,cool:rand(1,2.5),state:'approach',timer:0,ax:0,az:1,hit:0,spawn:.4,phase:rand(0,10)});
 ring(x,z,'#bda3ff',1.5,.45);return enemies.at(-1);
}
function removeEnemy(e){actors.remove(e.c.g);e.bar?.remove();clearWarning(e)}
function clearWarning(e){if(e.warning){effects.remove(e.warning);e.warning.material.dispose();e.warning=null}}
function warnLine(e,length,color){
 clearWarning(e);const m=new T.Mesh(geo.box,new T.MeshBasicMaterial({color,transparent:true,opacity:.5,depthWrite:false}));
 m.position.set(e.x+e.ax*length/2,height(e.x,e.z)+.08,e.z+e.az*length/2);m.rotation.y=Math.atan2(e.ax,e.az);m.scale.set(.22,.04,length);effects.add(m);e.warning=m;
}
function summonBoss(){
 if(bossSpawned||(mode!=='play'&&!demoActive))return;bossSpawned=true;
 for(const e of enemies)removeEnemy(e);enemies=[];clearObjects(shots);clearObjects(hazards);shots=[];hazards=[];
 const boss=spawnEnemy('warden');boss.cool=2.5;player.inv=2;toast('THE RIFT WARDEN · FINAL ENCOUNTER');audio.fx('level');
}
// FINAL BOSS — alternate warned projectile rings and ground blasts; below half health, shorten recovery.
function bossUpdate(e,dt){
 const dx=player.x-e.x,dz=player.z-e.z,d=Math.hypot(dx,dz)||1;
 if(e.hp<e.max*.5&&!e.enraged){e.enraged=true;toast('WARDEN ENRAGED · KEEP MOVING');ring(e.x,e.z,'#ff7979',6,1)}
 if(e.state==='bossWindup'){
  e.timer-=dt;
  if(e.timer<=0){
   if(e.attackIndex%2===0){for(let i=0;i<14;i++)projectile(e.x,e.z,i*Math.PI*2/14,{color:'#d18aff',speed:e.enraged?12:9,range:24,damage:14,pierce:0},true)}
   else for(let i=-1;i<=1;i++)hazard(e.tx+i*2.8,e.tz,2.3,25,.9,'warden');
   e.attackIndex++;e.state='approach';e.cool=e.enraged?1.5:2.4;clearWarning(e);
  }
 }else{
  if(d>8){const v=terrain.steer(e.x,e.z,player.x,player.z,e);moveWithCollision(e,v.x*e.def.speed*runTuning.speed*difficultyScale()*dt,v.z*e.def.speed*runTuning.speed*difficultyScale()*dt,e.def.radius)}
  if(e.cool<=0){e.state='bossWindup';e.timer=e.enraged?.75:1.1;e.tx=player.x;e.tz=player.z;e.ax=dx/d;e.az=dz/d;
   if(e.attackIndex%2===0)ring(e.x,e.z,'#d18aff',4,1.1);else warnLine(e,d,'#ffab74');
  }
 }
 if(d<e.def.radius+.45)hurtPlayer(e.def.damage);
 e.c.g.position.set(e.x,height(e.x,e.z),e.z);e.c.g.rotation.y=Math.atan2(dx,dz);animateCharacter(e.c,elapsed,.4);
}
// COMBAT HUD — position enemy health bars in screen space and update boss health/phase.
function updateCombatUI(dt){
 hitMarker=Math.max(0,hitMarker-dt);$('#crosshair').classList.toggle('confirmed',hitMarker>0);
 for(const e of enemies){
  const p=new T.Vector3(e.x,height(e.x,e.z)+e.c.g.scale.y*2.25,e.z).project(camera);
  e.bar.style.display=e.hp>0&&e.hp<e.max&&p.z<1&&Math.abs(p.x)<1.1&&Math.abs(p.y)<1.1&&mode==='play'?'block':'none';
  e.bar.style.left=(p.x*.5+.5)*innerWidth+'px';e.bar.style.top=(-p.y*.5+.5)*innerHeight+'px';e.fill.style.width=clamp(e.hp/e.max*100,0,100)+'%';
 }
 const boss=enemies.find(e=>e.kind==='warden'&&e.hp>0);$('#bossHUD').classList.toggle('hidden',!boss||mode!=='play');
 if(boss){$('#bossFill').style.width=100*boss.hp/boss.max+'%';$('#bossPhase').textContent=boss.enraged?'ENRAGED':'RIFT WARDEN'}
 $('#stageObjective').textContent=stage===STAGES.length&&!bossSpawned?Math.min(stageKills,stageGoal)+' / '+stageGoal+' KILLS TO SUMMON THE WARDEN':'';
}
function burst(x,y,z,color,count=12,speed=4){y+=height(x,z);for(let i=0;i<count;i++){if(particles.length>360)break;const m=mesh('box',color,x,y,z,rand(.055,.17),undefined,undefined,effects,.8);m.castShadow=false;particles.push({m,vx:rand(-1,1)*speed,vy:rand(.3,1.7)*speed,vz:rand(-1,1)*speed,life:rand(.25,.65),max:.65})}}
function ring(x,z,color,size=3,life=.4){const mat=new T.MeshBasicMaterial({color,transparent:true,opacity:.7,side:T.DoubleSide,depthWrite:false});const m=new T.Mesh(geo.ring,mat);m.rotation.x=-Math.PI/2;m.position.set(x,height(x,z)+.12,z);effects.add(m);rings.push({m,life,max:life,size,ownMat:true})}
// ACTOR HITBOXES — player bullets use at least standing height; terrain/cover stays fully 3D.
function bodyBounds(e,bullet=false){const base=e?e.c.g.position.y:height(player.x,player.z),scale=e?e.c.g.scale.y:1;return {x:e?e.x:player.x,z:e?e.z:player.z,radius:e?e.def.radius:.45,bottom:base+.08,top:base+2.3*(bullet?Math.max(1,scale):scale)}}
function shotWorld(){return {height,covers:stageWorld.covers}}
function pitchTo(x,y,z,tx,ty,tz){return Math.atan2(ty-y,Math.hypot(tx-x,tz-z))}
// STICK AIM — choose vertical aim from a nearby target without curving bullets in flight.
function assistedPitch(angle){let best=null,distance=Infinity;for(const e of enemies){const dx=e.x-player.x,dz=e.z-player.z,d=Math.hypot(dx,dz),delta=Math.atan2(Math.sin(Math.atan2(dx,dz)-angle),Math.cos(Math.atan2(dx,dz)-angle));if(e.hp>0&&Math.abs(delta)<.18&&d<distance){best=e;distance=d}}return best?pitchTo(player.x,height(player.x,player.z)+1.47,player.z,best.x,best.c.g.position.y+1.25*best.c.g.scale.y,best.z):0}
// PROJECTILE CREATION — save world position and velocity once. Never resample bullet altitude.
function projectile(x,z,a,w,enemy=false){
 const emitter=enemy?enemies.find(e=>Math.hypot(e.x-x,e.z-z)<.1):null;
 const y=enemy?height(x,z)+1.47*(emitter?.c.g.scale.y||1):height(player.x,player.z)+1.47;
 const pitch=enemy?pitchTo(x,y,z,player.x,height(player.x,player.z)+1.2,player.z):aimPitch;
 const speed=w.speed,horizontal=Math.cos(pitch)*speed,m=mesh(w.rocket?'ico':'box',w.color,x,y,z,w.rocket?.16:.065,w.rocket?.16:.065,w.rocket?.35:.6,effects,2.4);
 m.rotation.set(-pitch,a,0,'YXZ');m.castShadow=false;
 shots.push({m,x,y,z,px:x,py:y,pz:z,vx:Math.sin(a)*horizontal,vy:Math.sin(pitch)*speed,vz:Math.cos(a)*horizontal,life:w.range/speed,damage:w.damage*(enemy?1:player.damage),pierce:w.pierce+(enemy?0:player.pierce),hitIds:new Set(),enemy,rocket:w.rocket||false,radius:w.radius||0,color:w.color});
}
// PLAYER FIRING — weapon spread, pellets and feedback. Cadence is controlled in update().
function fire(){tutorialEvent('shoot',selected);const w=WEAPONS[selected],originX=player.x,originZ=player.z;const count=w.count+player.extra;
 for(let i=0;i<count;i++){const offset=count===1?rand(-w.spread,w.spread):(i-(count-1)/2)*w.spread;projectile(originX,originZ,aim+offset,w)}
 recoil=1;flashLight.position.set(originX,height(originX,originZ)+1.47,originZ);flashLight.color.set(w.color);flashLight.intensity=9;burst(originX,1.47,originZ,'#ffeca6',w.rocket?10:4,2);audio.fx(w.sound);if(w.rocket||selected===2)shake=.08;
}
// PROJECTILE UPDATE — sweep the full segment; hit actors only before the nearest terrain/cover impact.
function updateShots(dt){
 for(const b of shots){
  const from={x:b.x,y:b.y,z:b.z},to={x:b.x+b.vx*dt,y:b.y+b.vy*dt,z:b.z+b.vz*dt};b.px=b.x;b.py=b.y;b.pz=b.z;b.life-=dt;
  const wall=traceWorld(from,to,shotWorld()),limit=wall?.t??1,hits=[];
  if(b.enemy){const t=hitBody(from,to,bodyBounds());if(t!==null&&t<limit)hits.push({t,e:null})}
  else for(const e of enemies){if(e.hp<=0||b.hitIds.has(e.id))continue;const t=hitBody(from,to,bodyBounds(e,true));if(t!==null&&t<limit)hits.push({t,e})}
  hits.sort((a,b)=>a.t-b.t);let stop=null;
  for(const {t,e} of hits){const p=pointAt(from,to,t);if(b.enemy){hurtPlayer(b.damage);stop=p;b.life=0;break}b.hitIds.add(e.id);
   if(b.rocket){explode(p.x,p.z,b.radius,b.damage,false,p.y);stop=p;b.life=0;break}
   const critical=Math.random()<player.crit;hurtEnemy(e,b.damage*(critical?2:1),critical);if(--b.pierce<0){stop=p;b.life=0;break}
  }
  if(!stop&&wall){stop=pointAt(from,to,Math.max(0,wall.t-.015));b.life=0;if(b.rocket)explode(stop.x,stop.z,b.radius,b.damage,b.enemy,stop.y);else burst(stop.x,stop.y-height(stop.x,stop.z),stop.z,'#b6a184',5,1.5)}
  const end=stop||to;b.x=end.x;b.y=end.y;b.z=end.z;b.m.position.set(b.x,b.y,b.z);
  if(b.rocket&&b.life>0&&Math.random()<.5)burst(b.x,b.y-height(b.x,b.z),b.z,'#ffbd65',1,.7);
  if(b.life<=0){if(!stop&&b.rocket)explode(b.x,b.z,b.radius,b.damage,b.enemy,b.y);effects.remove(b.m)}
 }
 shots=shots.filter(b=>b.life>0);
}
function damageText(x,z,damage,critical){if(numbers.length>25)return;const el=document.createElement('span');el.className='damage'+(critical?' critical':'');el.textContent=Math.round(damage);$('#damageNumbers').appendChild(el);numbers.push({el,x,z,y:height(x,z)+2.2,life:.7})}
// ENEMY DAMAGE — apply temporary execution bonus, count kills, drop rewards and open the rift.
function hurtEnemy(e,damage,critical=false){if(e.hp<=0||victory)return;if(boons.execution>0)damage=e.kind==='warden'?damage*1.5:Math.max(damage,e.hp);hitMarker=.12;e.hp-=damage;e.hit=.1;burst(e.x,1.2,e.z,critical?'#ffe668':'#c9fffe',5,2);damageText(e.x,e.z,damage,critical);if(e.hp<=0){score+=e.def.score;kills++;stageKills++;tutorialEvent('kill');burst(e.x,1.2,e.z,e.def.color,e.kind==='brute'?32:18,4);ring(e.x,e.z,e.def.color,1.4,.3);audio.fx('kill');removeEnemy(e);if(!tutorial&&e.kind!=='warden'&&e.def.xp>0)dropPowerup(e.x,e.z);if(e.kind==='warden'){victory=true;finishRun(false);return}const m=mesh('gem','#80ffde',e.x,height(e.x,e.z)+.4,e.z,.16,.26,.16,effects,1.5);gems.push({m,x:e.x,z:e.z,v:e.def.xp});if(e.kind==='splitter'&&stage>=3){for(let i=0;i<2;i++){const child=spawnEnemy('skitter',{x:e.x+rand(-2,2),z:e.z+rand(-2,2)});child.hp*=.45;child.max=child.hp}}if(kills%12===0){player.hp=Math.min(player.max,player.hp+5)}if(stageKills>=stageGoal)activatePortal()}}
// PLAYER DAMAGE — apply mode/statue multipliers, then absorb damage with Bone Ward.
function hurtPlayer(amount){if(player.inv>0||(mode!=='play'&&!demoActive))return;player.hp=Math.max(0,player.hp-absorbDamage(boons,amount*runTuning.damage*difficultyScale()));player.inv=.6;hit=1;shake=.22;burst(player.x,1,player.z,'#ff7193',15,3);audio.fx('hurt');if(player.hp<=0)finishRun(true)}
// EXPLOSIONS — use real vertical distance and cover; a blast cannot pass through a ridge.
function explode(x,z,radius,damage,enemy=false,y=height(x,z)+.5){burst(x,y-height(x,z),z,enemy?'#ff855f':'#ffd774',38,7);ring(x,z,'#ffe7ad',radius,.45);shake=.23;audio.fx('explosion');const affects=e=>{const bounds=bodyBounds(e),ty=clamp(y,bounds.bottom,bounds.top),target={x:bounds.x,y:ty,z:bounds.z};return Math.hypot(target.x-x,target.y-y,target.z-z)<radius+bounds.radius&&!traceWorld({x,y:y+.08,z},target,shotWorld(),0)};if(enemy){if(affects(null))hurtPlayer(damage)}else for(const e of enemies)if(e.hp>0&&affects(e))hurtEnemy(e,damage)}

// ATTACK TELEGRAPHS — a delayed ground marker resolves into an explosion when its timer expires.
function hazard(x,z,radius,damage,delay,kind){const mat=new T.MeshBasicMaterial({color:'#ff6257',transparent:true,opacity:.45,side:T.DoubleSide,depthWrite:false});const m=new T.Mesh(new T.CircleGeometry(1,40),mat);m.rotation.x=-Math.PI/2;m.position.set(x,height(x,z)+.09,z);m.scale.setScalar(radius);effects.add(m);hazards.push({m,x,z,radius,damage,life:delay,max:delay,kind,ownMat:true});ring(x,z,'#ffad55',radius,delay)}
// DEATH MONSTERS — Revenant rush, Hexer cross-blast and Broodmother crawler summons.
function deathEnemyUpdate(e,dt,dx,dz,d,speed){
 const nx=dx/d,nz=dz/d;
 if(e.state==='deathWindup'){
  e.timer-=dt;if(e.timer<=0){
   if(e.kind==='revenant'){e.state='deathRush';e.timer=.38;clearWarning(e)}
   else if(e.kind==='hexer'){for(const [ox,oz] of [[0,0],[-2.5,0],[2.5,0],[0,-2.5],[0,2.5]])hazard(e.tx+ox,e.tz+oz,1.65,18,.75,'hex');e.state='approach';e.cool=3.8;clearWarning(e)}
   else{const children=enemies.filter(m=>m.kind==='skitter'&&m.hp>0).length;for(let i=0;i<Math.min(3,8-children)&&enemies.length<55;i++)spawnEnemy('skitter',{x:e.x+(i-1)*2,z:e.z+2});e.state='approach';e.cool=6;clearWarning(e)}
  }
 }else if(e.state==='deathRush'){
  moveWithCollision(e,e.ax*16*runTuning.speed*difficultyScale()*dt,e.az*16*runTuning.speed*difficultyScale()*dt,e.def.radius);e.timer-=dt;if(e.timer<=0){e.state='approach';e.cool=1.6}
 }else if(e.cool<=0&&(e.kind!=='revenant'||d<13)){
  e.state='deathWindup';e.timer=e.kind==='revenant'?.55:e.kind==='hexer'?1:1.2;e.ax=nx;e.az=nz;e.tx=player.x+player.vx*.3;e.tz=player.z+player.vz*.3;
  if(e.kind==='revenant')warnLine(e,9,'#e76464');else ring(e.x,e.z,'#d75b76',e.kind==='hexer'?2:3,e.timer);
 }else{
  let dir=e.kind==='hexer'?(d<7?-.65:d<14?0:1):e.kind==='broodmother'?(d<6?0:1):1;
  const v=dir>0?terrain.steer(e.x,e.z,player.x,player.z,e):{x:nx,z:nz},side=e.kind==='hexer'&&d<14?.55:0;
  moveWithCollision(e,(v.x*dir-nz*side)*speed*dt,(v.z*dir+nx*side)*speed*dt,e.def.radius);
 }
 if(Math.hypot(player.x-e.x,player.z-e.z)<e.def.radius+.48)hurtPlayer(e.def.damage);
 e.c.g.position.set(e.x,height(e.x,e.z),e.z);e.c.g.rotation.y=Math.atan2(dx,dz);animateCharacter(e.c,elapsed+e.phase,e.state==='deathWindup'?0:1);
 e.c.body.scale.setScalar(e.hit>0?1.08:1);e.c.g.visible=e.spawn<=0||Math.floor(elapsed*20)%2===0;
}
// ENEMY AI — each state machine owns telegraphs, movement and attacks for its monster type.
function enemyUpdate(e,dt){
 if(e.hp<=0)return;e.cool-=dt;e.hit=Math.max(0,e.hit-dt);e.spawn=Math.max(0,e.spawn-dt);
 if(e.kind==='warden'){bossUpdate(e,dt);return}
 const dx=player.x-e.x,dz=player.z-e.z,d=Math.hypot(dx,dz)||1,nx=dx/d,nz=dz/d;let speed=e.def.speed*runTuning.speed*difficultyScale()*(1+Math.min(wave-1,10)*.025),moving=0;
 if(e.kind==='runner')speed*=.8+.2*Math.sin(elapsed*5+e.phase);
 if(DEATH_TYPES[e.kind]){deathEnemyUpdate(e,dt,dx,dz,d,speed);return}
 if(e.state==='snipe'){e.timer-=dt;if(e.timer<=0){projectile(e.x,e.z,Math.atan2(e.ax,e.az),{color:'#cd85a8',damage:29,speed:24,range:42,pierce:0},true);e.state='approach';e.cool=2.6;clearWarning(e)}}
 else if(e.state==='windup'){e.timer-=dt;e.c.body.rotation.z=Math.sin(elapsed*40)*.035;if(e.kind==='leaper')e.c.g.position.y=height(e.x,e.z)+1+Math.max(0,1-e.timer)*2;if(e.timer<=0){clearWarning(e);e.state=e.kind==='leaper'?'leap':'charge';e.timer=e.kind==='leaper'?.6:.68;audio.fx('charge')}}
 else if(e.state==='charge'){moveWithCollision(e,e.ax*18*runTuning.speed*difficultyScale()*dt,e.az*18*runTuning.speed*difficultyScale()*dt,e.def.radius);moving=2;e.timer-=dt;if(Math.random()<.4)burst(e.x,.5,e.z,'#ffb171',2,1);if(e.timer<=0){e.state='approach';e.cool=3.5;e.c.body.rotation.z=0}}
 else if(e.state==='leap'){moveWithCollision(e,e.ax*25*runTuning.speed*difficultyScale()*dt,e.az*25*runTuning.speed*difficultyScale()*dt,e.def.radius);moving=2;e.timer-=dt;if(e.timer<=0){hazard(e.x,e.z,3.6,e.def.damage*1.3,.2,'leap');e.state='approach';e.cool=3.5}}
 else{
  if(e.kind==='charger'&&d<12&&d>3&&e.cool<0){e.state='windup';e.timer=.85;e.ax=nx;e.az=nz;e.c.g.rotation.y=Math.atan2(nx,nz);ring(e.x,e.z,'#ff5656',2,.85);warnLine(e,12,'#ff6d63');}
  else if(e.kind==='brute'&&d<3.8&&e.cool<0){hazard(e.x,e.z,4.2,25,.95,'slam');e.cool=3.5;e.timer=.95;}
  else if(e.kind==='mortar'&&e.cool<0){hazard(player.x+player.vx*.25,player.z+player.vz*.25,2.5,21,1.35,'mortar');e.cool=3.1;audio.fx('mortar')}
  else if(e.kind==='gunner'&&d<18&&e.cool<0){const a=Math.atan2(nx,nz);for(let i=-1;i<=1;i++)projectile(e.x,e.z,a+i*.17,{color:'#c1cb6f',damage:11,speed:10,range:26,pierce:0},true);e.cool=1.8;burst(e.x,1.3,e.z,'#ffe484',6,1)}
  else if(e.kind==='sniper'&&d>8&&d<32&&e.cool<0){e.state='snipe';e.timer=.95;e.ax=nx;e.az=nz;warnLine(e,42,'#ff4eae')}
  else if(e.kind==='stormer'&&e.cool<0){for(let i=0;i<8;i++)projectile(e.x,e.z,i*Math.PI/4+elapsed*.15,{color:'#7db3ff',damage:10,speed:9,range:18,pierce:0},true);e.cool=3.8;burst(e.x,1.4,e.z,'#9fcbff',13,2)}
  else if(e.kind==='leaper'&&d<15&&e.cool<0){e.state='windup';e.timer=.75;e.ax=nx;e.az=nz;ring(e.x,e.z,'#ffca66',2,.75)}
  e.timer=Math.max(0,e.timer-dt);
  if(e.timer<=0){let dir=1;if(e.kind==='gunner'||e.kind==='mortar'||e.kind==='sniper'){if(d<8)dir=-.7;else if(d<18)dir=0}let strafe=e.kind==='skitter'&&d<9?Math.sin(elapsed*3+e.phase)*.9:e.kind==='stormer'&&d<12?.65:0;if(e.kind==='stormer'&&d<8)dir=.15;const v=dir>0&&d>3?terrain.steer(e.x,e.z,player.x,player.z,e):{x:nx,z:nz};const mx=(v.x*dir-nz*strafe)*speed*dt,mz=(v.z*dir+nx*strafe)*speed*dt;moveWithCollision(e,mx,mz,e.def.radius);moving=Math.abs(dir);e.c.g.rotation.y=Math.atan2(nx,nz)}
 }
 if(d<e.def.radius+.48)hurtPlayer(e.state==='charge'?24:e.def.damage);
 e.c.g.position.set(e.x,height(e.x,e.z)+(e.state==='leap'?Math.sin(clamp(e.timer/.6,0,1)*Math.PI)*3:0),e.z);animateCharacter(e.c,elapsed+e.phase,moving);e.c.body.scale.setScalar(e.hit>0?1.08:1);e.c.g.visible=e.spawn<=0||Math.floor(elapsed*20)%2===0;
}
// LEVEL-UP REWARDS — permanent bonuses for this run; freshPlayer() clears them on restart.
const UPGRADES=[
 ['Overclock','ϟ','Fire every weapon 18% faster.',()=>player.rate*=1.18],
 ['Heavy rounds','✦','Deal 25% more weapon damage.',()=>player.damage*=1.25],
 ['Forked chamber','⑂','One extra projectile per shot.',()=>player.extra++],
 ['Phase armor','⬡','Gain 20 max integrity and heal 45.',()=>{player.max+=20;player.hp=Math.min(player.max,player.hp+45)}],
 ['Gravity well','◎','Collect shards from farther away.',()=>player.magnet+=2],
 ['Ghost rounds','➜','Bullets pierce one extra enemy.',()=>player.pierce++],
 ['Rush circuit','»','Move 14% faster in every direction.',()=>player.speed*=1.14],
 ['Deadeye','◇','Add 15% chance for double damage.',()=>player.crit=Math.min(.9,player.crit+.15)],
 ['Repair field','✚','Recover 1 integrity each second.',()=>player.regen+=1]
];
// PERMANENT RUN UPGRADES — distinct from short-lived powerups in encounters.js.
function levelUp(){if(demoActive){player.xp-=player.next;player.level++;player.next=Math.floor(player.next*1.3+3);UPGRADES[Math.floor(Math.random()*UPGRADES.length)][3]();return}player.xp-=player.next;player.level++;player.next=Math.floor(player.next*1.3+3);mode='upgrade';$('#cards').replaceChildren();const pool=[...UPGRADES];for(let i=pool.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]]}pool.slice(0,3).forEach((u,i)=>{const b=document.createElement('button');b.className='card';b.innerHTML=`<span class="symbol">${i+1}</span><strong>${u[0].toUpperCase()}</strong><p>${u[2]}</p>`;b.onclick=()=>{u[3]();mode='play';$('#choice').classList.add('hidden');toast(u[0].toUpperCase());updateHUD()};$('#cards').appendChild(b)});$('#choice').classList.remove('hidden');$('#cards button').focus();audio.fx('level')}
function toast(text){if(demoActive)return;$('#waveToast').textContent=text;$('#waveToast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#waveToast').classList.remove('show'),2200)}
// HUD — reflects game state only; tutorial hints and optional difficulty/powerup rows update last.
function updateHUD(){if(demoActive)return;
 $('#healthText').textContent=`${Math.ceil(player.hp)} / ${player.max}`;$('#healthBar').style.width=100*player.hp/player.max+'%';$('#xpBar').style.width=Math.min(100,100*player.xp/player.next)+'%';$('#level').textContent=player.level;$('#score').textContent=score.toLocaleString()+' SCORE';
 $('#sector').textContent=tutorial?'TUTORIAL · RIFT CLOISTER':`STAGE ${stage} · ${STAGES[stage-1]?.name||'VOID'}`;$('#clock').textContent=String(Math.floor(elapsed/60)).padStart(2,'0')+':'+String(Math.floor(elapsed%60)).padStart(2,'0');$('#hostiles').textContent=enemies.filter(e=>e.hp>0).length+' HOSTILES';$('#dashStatus').textContent=player.dashCD>0?'DASH '+player.dashCD.toFixed(1)+'s':'PHASE DASH READY';$('#crosshair').style.display=mode==='play'&&mouse.moved?'block':'none';
 const c=$('#portalCompass');if(mode==='play'&&stage<STAGES.length&&(!tutorial||tutorial.step==='rift')){c.classList.remove('hidden');const {x:px,z:pz}=stagePortal.position,dx=px-player.x,dz=pz-player.z;const distance=Math.hypot(dx,dz);const viewYaw=Math.atan2(camera.position.x-player.x,camera.position.z-player.z),delta=portalBearing(dx,dz,viewYaw);$('.compass-arrow').style.transform=`rotate(${delta*180/Math.PI}deg)`;$('#portalLabel').textContent=portalActive?'RIFT PORTAL OPEN':'RIFT PORTAL LOCKED';$('#portalDistance').textContent=portalActive?`${Math.round(distance)}m · ${tutorial?'ENTER TO FINISH':'ENTER TO DESCEND'}`:`${stageKills} / ${stageGoal} KILLS TO OPEN`}else c.classList.add('hidden');renderTutorial();updateEncounterHUD();
}

// SIMULATION — dt is seconds. Pausing stops combat, powerup timers and tutorial progress.
function update(dt){
 if((mode!=='play'&&!demoActive)||overlay||demoFinished)return;
 elapsed+=dt;tickBoons(boons,dt);player.inv=Math.max(0,player.inv-dt);player.dashCD=Math.max(0,player.dashCD-dt);player.dashing=Math.max(0,player.dashing-dt);player.hp=Math.min(player.max,player.hp+player.regen*dt);
 if(!demoActive&&held('orbitLeft'))cameraYaw+=dt*1.6;if(!demoActive&&held('orbitRight'))cameraYaw-=dt*1.6;
 const beforeX=player.x,beforeZ=player.z;const input=inputMovement(),smooth=1-Math.exp(-dt*16);player.vx=lerp(player.vx,input.x*player.speed*(boons.speed?1.3:1),smooth);player.vz=lerp(player.vz,input.z*player.speed*(boons.speed?1.3:1),smooth);
 if(player.dashing>0){moveWithCollision(player,player.dx*27*dt,player.dz*27*dt,.45);burst(player.x,.6,player.z,'#81ffff',3,1)}else moveWithCollision(player,player.vx*dt,player.vz*dt,.45);
 tutorialEvent('move',Math.hypot(player.x-beforeX,player.z-beforeZ));
 let manual=demoActive,shooting=demoActive?demoFiring:held('fire')||touchFire||gamepadFire;
 const stick=Math.hypot(aimStick.x,aimStick.y)>.15?aimStick:gamepadAim;
 if(!demoActive&&Math.hypot(stick.x,stick.y)>.18){const v=movementVector(stick.x,stick.y,cameraYaw);aim=Math.atan2(v.x,v.z);aimPitch=assistedPitch(aim);manual=true}
 else if(!demoActive&&mouse.moved){
  floorPlane.constant=-(height(player.x,player.z)+1.2);raycaster.setFromCamera(new T.Vector2(mouse.x/innerWidth*2-1,-mouse.y/innerHeight*2+1),camera);
  const actor=raycaster.intersectObjects(enemies.filter(e=>e.hp>0).map(e=>e.c.g),true)[0],surface=raycaster.intersectObject(stageWorld.surface,false)[0];
  if(actor)aimPoint.copy(actor.point);else if(surface){aimPoint.copy(surface.point);aimPoint.y+=1.2}else raycaster.ray.intersectPlane(floorPlane,aimPoint);
  aim=Math.atan2(aimPoint.x-player.x,aimPoint.z-player.z);aimPitch=pitchTo(player.x,height(player.x,player.z)+1.47,player.z,aimPoint.x,aimPoint.y,aimPoint.z);manual=true;
 }

 if(!manual&&!shooting&&Math.hypot(input.x,input.z)>.1)aim=Math.atan2(input.x,input.z);
 hero.gunMount.rotation.x=-aimPitch;hero.g.rotation.y=aim;hero.g.position.set(player.x,height(player.x,player.z),player.z);animateCharacter(hero,elapsed,Math.min(1,Math.hypot(player.vx,player.vz)/5),recoil);hero.g.visible=player.inv<=0||Math.floor(elapsed*24)%2===0;
 fireTimer-=dt;if(shooting&&fireTimer<=0){fire();fireTimer=WEAPONS[selected].cooldown/player.rate/(boons.rapid?1.5:1)}
 if(portalActive&&Math.hypot(player.x-stagePortal.position.x,player.z-stagePortal.position.z)<PORTAL_RADIUS){enterStage();return}
 spawnTimer-=dt;if(!tutorial&&!bossSpawned&&spawnTimer<=0&&enemies.length<55){spawnEnemy();spawnTimer=Math.max(.3,1.5-wave*.12)/difficultyScale()}
 const nextWave=1+Math.floor(elapsed/30);if(!tutorial&&nextWave>wave){wave=nextWave;if(!bossSpawned){toast('RIFT SURGE · STAY MOVING');audio.fx('level');player.hp=Math.min(player.max,player.hp+12);for(let i=0;i<Math.min(wave,6);i++)spawnEnemy()}}
 for(const e of enemies)enemyUpdate(e,dt);
 if((mode!=='play'&&!demoActive)||demoFinished)return;
 updateShots(dt);enemies=enemies.filter(e=>e.hp>0);if((mode!=='play'&&!demoActive)||demoFinished)return;
 for(const h of hazards){h.life-=dt;h.m.material.opacity=.2+(1-h.life/h.max)*.5;h.m.scale.setScalar(h.radius*(.9+.1*Math.sin(elapsed*18)));if(h.life<=0){explode(h.x,h.z,h.radius,h.damage,true);effects.remove(h.m);h.m.material.dispose()}}
 hazards=hazards.filter(h=>h.life>0);if((mode!=='play'&&!demoActive)||demoFinished)return;
 for(const g of gems){const dx=player.x-g.x,dz=player.z-g.z,d=Math.hypot(dx,dz);if(d<player.magnet){const speed=Math.min(d,dt*(4+16/(d+.2)));g.x+=dx/(d||1)*speed;g.z+=dz/(d||1)*speed}g.m.position.set(g.x,height(g.x,g.z)+.45+Math.sin(elapsed*4+g.x)*.12,g.z);g.m.rotation.y+=dt*2;if(d<.65){player.xp+=g.v;g.dead=true;effects.remove(g.m);audio.fx('gem')}}gems=gems.filter(g=>!g.dead);
 updatePowerups(dt);if(!tutorial&&player.xp>=player.next){clearInput();levelUp()}updateHUD();
}
// EFFECTS — animate bounded particles, rift sparks, hit flashes and floating damage numbers.
function updateEffects(dt){for(const p of particles){p.life-=dt;p.vy-=12*dt;p.m.position.x+=p.vx*dt;p.m.position.y+=p.vy*dt;p.m.position.z+=p.vz*dt;p.m.rotation.x+=dt*5;p.m.rotation.z+=dt*3;p.m.scale.multiplyScalar(Math.exp(-dt*1.5));if(p.life<=0)effects.remove(p.m)}particles=particles.filter(p=>p.life>0);
 if(stagePortal){stagePortal.children[1].rotation.z+=dt*.72;stagePortal.scale.setScalar(1+Math.sin(elapsed*4)*.08);if(portalLight){portalLight.intensity=portalActive?19+Math.sin(elapsed*9)*6:0;portalLight.color.set('#9e5cff')}if(portalActive&&Math.random()<dt*9){const [x,z]=tutorial?TUTORIAL_PORTAL:STAGES[stage-1].portal;burst(x+rand(-2.5,2.5),rand(1,6),z+rand(-2.5,2.5),'#b974ff',1,1.8)}}
 for(const r of rings){r.life-=dt;r.m.scale.setScalar(r.size*(1-r.life/r.max));r.m.material.opacity=Math.max(0,r.life/r.max)*.7;if(r.life<=0){effects.remove(r.m);r.m.material.dispose()}}rings=rings.filter(r=>r.life>0);
 for(const n of numbers){n.life-=dt;n.y+=dt*1.7;const v=new T.Vector3(n.x,n.y,n.z).project(camera);n.el.style.left=(v.x*.5+.5)*innerWidth+'px';n.el.style.top=(-v.y*.5+.5)*innerHeight+'px';n.el.style.opacity=Math.min(1,n.life*3);if(n.life<=0)n.el.remove()}numbers=numbers.filter(n=>n.life>0);
 recoil=Math.max(0,recoil-dt*9);flashLight.intensity*=Math.exp(-dt*22);shake*=Math.exp(-dt*14);hit=Math.max(0,hit-dt*4);$('#hitflash').style.opacity=hit*.6;
}
// CAMERA — screen-relative movement uses the same yaw; geometry supplies the target elevation.
function cameraUpdate(dt,time){const target=new T.Vector3(player.x,height(player.x,player.z)+1,player.z);let yaw=cameraYaw,dist=cameraDistance;
 if(demoActive){yaw=.4;dist=29;target.x+=Math.cos(yaw)*7;target.z-=Math.sin(yaw)*7}
 const desired=target.clone().add(new T.Vector3(Math.sin(yaw)*dist,dist*.85,Math.cos(yaw)*dist));camera.position.lerp(desired,1-Math.exp(-dt*7));camera.lookAt(target);if(!reduced){camera.position.x+=rand(-shake,shake);camera.position.y+=rand(-shake,shake)}
 heroRing.position.set(player.x,height(player.x,player.z)+.05,player.z);heroRing.visible=mode!=='dead';
 sun.position.set(player.x-24,height(player.x,player.z)+45,player.z+18);sun.target.position.set(player.x,height(player.x,player.z),player.z);sun.target.updateMatrixWorld();
}
camera.position.set(10,22,25);camera.lookAt(0,1,0);
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();const r=retroSize();composer.setSize(r.w,r.h)});

// RUN MODIFIERS — statue difficulty persists across stages, then resets in start().
function difficultyScale(){return 1+difficultyBonus/100}
function interact(){
 if(mode!=='play'||overlay||tutorial||demoActive)return;
 const statue=statueWorld?.nearby(player);if(!statueWorld?.activate(statue))return;
 const previous=difficultyScale();difficultyBonus+=STATUE_BONUS;const ratio=difficultyScale()/previous;
 for(const e of enemies){e.hp*=ratio;e.max*=ratio}
 ring(statue.x,statue.z,'#bc565a',3,.7);audio.fx('charge');toast('DIFFICULTY '+(100+difficultyBonus)+'%');updateEncounterHUD();
}
// Pickups are separate from XP gems. Their clocks stop while the game is paused.
function dropPowerup(x,z,kind=rollPowerup()){
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
 $('#difficultyMeter').classList.toggle('hidden',difficultyBonus===0||demoActive);$('#difficultyMeter').textContent='Difficulty: '+(100+difficultyBonus)+'%';
 const active=Object.keys(POWERUPS).filter(k=>boons[k]>0);$('#powerupStatus').textContent=active.map(k=>POWERUPS[k].label+' '+Math.ceil(boons[k])+'s').join(' · ');
 const nearby=mode==='play'&&!tutorial?statueWorld?.nearby(player):null;$('#interactPrompt').classList.toggle('hidden',!nearby);$('#interactTouch').classList.toggle('hidden',!nearby);
 $('#interactPrompt').textContent=nearby?(mobile?'INTERACT':navigator.getGamepads?.()[0]?'X':keyLabel(prefs.bindings.interact))+' · SKULL STATUE · DIFFICULTY +'+STATUE_BONUS+'%':'';
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
 $('.menu-card h1').classList.add('brand-title');$('.menu-card h1').innerHTML='RIFT<span>BORN</span>';$('.menu-card .edition').textContent='';$('#runSummary').textContent=completed?'TUTORIAL COMPLETE':'';$('#scoreSave').textContent='';$('#retryScore').classList.add('hidden');$('#start').textContent='START RUN';start(true);$('#start').focus();
}

function formatTime(seconds){return Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0')}
// DIALOGS — settings, leaderboard and username entry own focus and pause active gameplay.
function openPanel(id){if(mode==='play')pause();overlayReturn=mode;overlay=id;clearInput();document.body.classList.add('menu-open');$(id).classList.remove('hidden');$('#menu').inert=true;$('#pauseMenu').inert=true;if(id==='#runSetup'){$('#playerName').value='';$('#usernameError').textContent='';$('#playerName').setAttribute('aria-invalid','false');$('#playerName').focus()}else if(id==='#settings'){renderBindings();syncSettings();$('#closeSettings').focus()}else{loadLeaderboard();$('#closeLeaderboard').focus()}}
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
$('#menuSettings').onclick=$('#pauseSettings').onclick=()=>openPanel('#settings');$('#menuLeaderboard').onclick=$('#pauseLeaderboard').onclick=()=>openPanel('#leaderboard');$('#closeSettings').onclick=$('#closeLeaderboard').onclick=closePanel;$('#refreshLeaderboard').onclick=loadLeaderboard;$('#endRun').onclick=()=>finishRun(false);$('#retryScore').onclick=saveScores;
$('#cancelRun').onclick=closePanel;
$('#runForm').onsubmit=e=>{e.preventDefault();if(!$('#playerName').value.trim()){$('#usernameError').textContent='Enter a username.';$('#playerName').setAttribute('aria-invalid','true');$('#playerName').focus();return}closePanel();start()};
function setNightmare(value){prefs.nightmare=!!value;savePrefs();$('#nightmare').checked=prefs.nightmare;applyLighting()}
$('#nightmare').onchange=e=>setNightmare(e.target.checked);
// RUN COMPLETION — capture immutable name/mode/date for retryable score submission.
function finishRun(defeated){if(demoActive){demoFinished=true;return}if(tutorial){finishTutorial(false);return}if(!['play','pause'].includes(mode))return;clearInput();mode='dead';hero.g.visible=!defeated;document.body.classList.remove('in-run');document.body.classList.add('menu-open');$('#pauseMenu').classList.add('hidden');$('#menu').classList.remove('hidden');$('#bossHUD').classList.add('hidden');$('#portalCompass').classList.add('hidden');$('#stageObjective').textContent='';$('.menu-card h1').classList.remove('brand-title');$('.menu-card h1').innerHTML=victory?'RIFT<br><span>CONQUERED</span>':defeated?'RUN<br><span>SEVERED</span>':'RUN<br><span>COMPLETE</span>';$('.menu-card .edition').textContent=`STAGE ${stage} · ${score.toLocaleString()} SCORE`;$('#runSummary').textContent=`${kills} KILLS · ${formatTime(elapsed)}`;$('#start').textContent='PLAY AGAIN';$('#start').focus();if(runId&&elapsed>=1){pendingScores.set(runId,{id:runId,name:runName,score,kills,wave,seconds:Math.floor(elapsed),stage,played_at:Date.now(),death_mode:runDeath});runId=null;saveScores()}else $('#scoreSave').textContent=''}
// LEADERBOARD WRITE — retries reuse the same run ID so failed saves cannot duplicate rows.
async function saveScores(){if(savingScores||!pendingScores.size)return;savingScores=true;$('#scoreSave').textContent='Saving your score…';$('#retryScore').classList.add('hidden');try{for(const [id,run] of pendingScores){const r=await fetch('/api/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(run)});if(!r.ok)throw new Error('Save unavailable');pendingScores.delete(id)}$('#scoreSave').textContent='Score saved.'}catch{$('#scoreSave').textContent='Score not saved. Retry when connected.';$('#retryScore').classList.remove('hidden')}finally{savingScores=false}}
// LEADERBOARD READ — render names as text and only mark explicitly recorded Death Mode scores.
async function loadLeaderboard(){$('#leaderboardRows').replaceChildren();$('#leaderboardStatus').textContent='Loading scores…';try{const r=await fetch('/api/scores',{cache:'no-store'});if(!r.ok)throw new Error('Unavailable');const data=await r.json();if(!Array.isArray(data.scores))throw new Error('Invalid scores');$('#leaderboardStatus').textContent=data.scores.length?'':'No scores yet.';data.scores.forEach((s,i)=>{const tr=document.createElement('tr');for(const value of [s.name,s.score.toLocaleString(),Number.isInteger(s.stage)?s.stage:'—',Number.isFinite(s.played_at)?new Date(s.played_at).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'—']){const td=document.createElement('td');td.textContent=String(value);tr.appendChild(td)}if(s.death_mode===true){const skull=document.createElement('img');skull.src='assets/death-skull.png';skull.alt='Death Mode';skull.title='Death Mode run';skull.className='death-run-mark';skull.width=24;skull.height=24;tr.firstElementChild.appendChild(skull)}$('#leaderboardRows').appendChild(tr)})}catch{$('#leaderboardStatus').textContent='Leaderboard unavailable right now. Press Refresh to try again.'}}

// Original horror-synth arrangements; effects retain their independent volume bus.
// AUDIO LIFECYCLE — create/resume from a user gesture; music and effects have separate gain buses.
const audio={ctx:null,master:null,music:null,sfx:null,bus:null,score:null,step:0,next:0,timer:null,
 apply(){if(!this.master)return;this.master.gain.value=prefs.muted?0:.22*prefs.master/100;this.music.gain.value=prefs.music/100;this.sfx.gain.value=prefs.effects/100},
 start(){this.step=0;this.unlock();if(this.ctx)this.next=this.ctx.currentTime+.02},
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
 tone(f,time,duration,type='triangle',volume=.12,end){if(!this.ctx)return;const o=this.ctx.createOscillator(),g=this.ctx.createGain();o.type=type;o.frequency.setValueAtTime(f,time);if(end)o.frequency.exponentialRampToValueAtTime(end,time+duration);g.gain.setValueAtTime(.0001,time);g.gain.linearRampToValueAtTime(volume,time+.005);g.gain.exponentialRampToValueAtTime(.0001,time+duration);o.connect(g);g.connect(this.bus||this.sfx);o.start(time);o.stop(time+duration)},
 tick(){if(!this.ctx){this.timer=null;return}if(this.ctx.state==='running'&&!demoActive&&!prefs.muted&&prefs.master>0&&prefs.music>0){this.next=Math.max(this.next,this.ctx.currentTime);while(this.next<this.ctx.currentTime+.12){this.score.schedule(this.step,this.next,runDeath,mode==='play'?1:.25);this.step++;this.next+=60/runTuning.bpm/4}}else this.next=this.ctx.currentTime;this.timer=setTimeout(()=>this.tick(),40)},
 fx(type){if(demoActive||!this.ctx||this.ctx.state!=='running'||prefs.muted)return;const n=this.ctx.currentTime;const tones={rifle:[600,.065,'sawtooth',.09,130],smg:[850,.045,'square',.045,230],shotgun:[180,.14,'sawtooth',.23,40],rail:[1600,.23,'sawtooth',.1,130],rocket:[120,.25,'sawtooth',.2,35],explosion:[90,.3,'sawtooth',.25,24],hurt:[140,.17,'sawtooth',.15,45],kill:[180,.06,'triangle',.06,65],gem:[1100,.07,'sine',.06,1600],dash:[220,.18,'sawtooth',.12,880],charge:[160,.35,'sawtooth',.1,500],mortar:[350,.12,'triangle',.07,130],switch:[350,.05,'triangle',.1,600]};if(type==='level'){[440,554,660,880].forEach((f,i)=>this.tone(f,n+i*.08,.25,'triangle',.13));return}const a=tones[type];if(a)this.tone(a[0],n,a[1],a[2],a[3],a[4])}
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

let last=performance.now(),slowFrames=0;const framePacer=new FramePacer();
// MAIN LOOP — simulate every animation tick; the FPS cap only gates rendering.
function frame(now){requestAnimationFrame(frame);const raw=(now-last)/1000,dt=Math.min(raw,.04);last=now;updateSkull(dt);if(mode==='menu'||mode==='dead')updateDemo(dt);else{pollPad();if(mode==='play')update(dt);if(mode!=='pause'&&mode!=='upgrade')updateEffects(dt)}cameraUpdate(dt,now/1000);statueWorld?.face(camera);if(prefs.nightmare){Object.assign(scene.fog,fogRange(prefs.fog,true,camera.position.distanceTo(hero.g.position)));if(storm.update(dt,now/1000,player,height(player.x,player.z)))audio.thunder()}updateCombatUI(dt);if(mode==='play')updateHUD();
 if(framePacer.ready(now,prefs.fpsCap))composer.render();if(raw>.045)slowFrames++;else slowFrames=Math.max(0,slowFrames-1);if(slowFrames>100&&!qualityReduced&&prefs.pixelation==='auto'){qualityReduced=true;const r=retroSize();composer.setSize(r.w,r.h)}}
window.gameReady=true;$('#tutorial').disabled=false;$('#start').disabled=false;$('#start').textContent='START RUN';$('#loadNote').textContent='';refreshHelp();syncSettings();start(true);requestAnimationFrame(frame);
