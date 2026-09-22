import * as T from 'three';
import { createTerrain } from './terrain.js';
import { buildStageWorld } from './scenery.js';
import { EffectComposer } from './vendor/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/postprocessing/OutputPass.js';
import { WEAPONS, ENEMY_TYPES, segmentHit, movementVector } from './rules.js';
import { DEFAULT_BINDINGS, ACTION_LABELS, keyLabel, loadPreferences, assignBinding } from './preferences.js';

const $ = s => document.querySelector(s);
let prefs;try{prefs=loadPreferences(window.localStorage)}catch{prefs=loadPreferences(null)}
function savePrefs(){try{window.localStorage.setItem('neon-crypt-preferences-v1',JSON.stringify(prefs))}catch{}}
const rand = (a,b) => a + Math.random()*(b-a);
const clamp = T.MathUtils.clamp, lerp = T.MathUtils.lerp;
const mobile = matchMedia('(pointer:coarse)').matches;
const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;
const canvas = $('#game');
const renderer = new T.WebGLRenderer({canvas, antialias:true, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio, mobile?1.25:1.65));
renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
const scene = new T.Scene();
scene.background = new T.Color('#89b4e2');
scene.fog = new T.Fog('#89b4e2',65,165);
const camera = new T.PerspectiveCamera(47,innerWidth/innerHeight,.1,230);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene,camera));
const bloom = new UnrealBloomPass(new T.Vector2(innerWidth,innerHeight),.38,.45,1.15);
composer.addPass(bloom);composer.addPass(new OutputPass());
const ambient=new T.HemisphereLight('#c9e5ff','#596651',2.6);scene.add(ambient);
const sun = new T.DirectionalLight('#ffe0ac',3.6);sun.position.set(-24,45,18);sun.castShadow=true;
sun.shadow.mapSize.set(mobile?1024:2048,mobile?1024:2048);
Object.assign(sun.shadow.camera,{left:-33,right:33,top:33,bottom:-33,near:1,far:100});
sun.shadow.bias=-.0004;sun.shadow.normalBias=.035;scene.add(sun,sun.target);
const rim = new T.DirectionalLight('#a791ff',1.8);rim.position.set(30,15,-40);scene.add(rim);
const flashLight = new T.PointLight('#ffcf67',0,11,2);scene.add(flashLight);
const world = new T.Group(), actors = new T.Group(), effects = new T.Group();scene.add(world,actors,effects);
const mats = new Map(), geo = {box:new T.BoxGeometry(1,1,1),ico:new T.IcosahedronGeometry(1,0),sphere:new T.SphereGeometry(1,10,7),gem:new T.OctahedronGeometry(1,0),ring:new T.RingGeometry(.9,1,48),torus:new T.TorusGeometry(1,.08,6,32),cylinder:new T.CylinderGeometry(1,1,1,8)};
function material(color,glow=0){let key=color+':'+glow;if(!mats.has(key))mats.set(key,new T.MeshStandardMaterial({color,roughness:.83,flatShading:true,emissive:color,emissiveIntensity:glow}));return mats.get(key)}
function mesh(shape,color,x,y,z,sx=1,sy=sx,sz=sx,parent=world,glow=0){const m = new T.Mesh(geo[shape],material(color,glow));m.position.set(x,y,z);m.scale.set(sx,sy,sz);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m}
let runSeed=7361, terrain=createTerrain(1,runSeed), stageWorld=null;
function height(x,z){return terrain.height(x,z)}

const PORTAL_RADIUS=3.5;
const flora=new T.Group(),floraPositions=[],floraLights=[];world.add(flora);
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
 stagePortal.add(new T.Mesh(new T.TorusGeometry(2.5,.08,5,48),material('#d9a7ff',4)));
 stagePortal.add(new T.Mesh(new T.IcosahedronGeometry(1.6,1),material('#812bff',3)));
 portalLight=new T.PointLight('#9e5cff',0,18,2);stagePortal.add(portalLight);
 for(let i=0;i<4;i++){const light=new T.PointLight(i%2?'#8978ff':'#60f9d4',0,6,2);world.add(light);floraLights.push(light)}
 setStageDecor();
}
buildWorld();

function buildFlora(){
 for(const child of [...flora.children]){flora.remove(child);child.dispose?.()}floraPositions.length=0;
 const count=165,stems=new T.InstancedMesh(geo.cylinder,material('#194a4a'),count*3);
 const caps=new T.InstancedMesh(geo.sphere,material('#60f9d4',2.5),count*3);
 const leaves=new T.InstancedMesh(geo.gem,material('#8978ff',1.7),count*3);
 const o=new T.Object3D();
 for(let i=0;i<count;i++){
  const angle=i*2.39996,r=5+Math.sqrt(i/count)*56,x=Math.cos(angle)*r,z=Math.sin(angle)*r;floraPositions.push({x,z});
  for(let j=0;j<3;j++){const px=x+Math.cos(j*2.1)*.45,pz=z+Math.sin(j*2.1)*.45,h=.3+j*.12,k=i*3+j;
   o.position.set(px,height(px,pz)+h/2,pz);o.rotation.set(0,0,0);o.scale.set(.045,h,.045);o.updateMatrix();stems.setMatrixAt(k,o.matrix);
   o.position.y=height(px,pz)+h;o.scale.set(.22+j*.025,.1,.2);o.updateMatrix();caps.setMatrixAt(k,o.matrix);
   o.position.set(x+Math.cos(j*2.1)*.25,height(x,z)+.25,z+Math.sin(j*2.1)*.25);o.rotation.set(.4,j*2.1,.35);o.scale.set(.07,.38,.12);o.updateMatrix();leaves.setMatrixAt(k,o.matrix);
  }
 }
 flora.add(stems,caps,leaves);
}
function applyLighting(){
 const s=STAGES[stage-1]||STAGES.at(-1),night=prefs.timeOfDay==='night';
 scene.background=new T.Color(night?'#030611':s.sky);scene.fog.color.set(night?'#080d21':s.fog);scene.fog.near=night?24:65;scene.fog.far=night?90:165;
 ambient.intensity=night?.32:2.6;ambient.color.set(night?'#7387be':'#c9e5ff');ambient.groundColor.set(night?'#15172f':'#596651');
 sun.color.set(night?'#869be3':'#ffe0ac');sun.intensity=night?.55:3.6;rim.color.set(night?'#7964cf':'#a791ff');rim.intensity=night?.5:1.8;
 renderer.toneMappingExposure=night?1.05:1.3;flora.visible=night;floraLights.forEach(l=>l.intensity=0);flashLight.intensity=0;
}
function updateFlora(time){
 if(!flora.visible)return;
 const nearby=[...floraPositions].sort((a,b)=>(a.x-player.x)**2+(a.z-player.z)**2-((b.x-player.x)**2+(b.z-player.z)**2)).slice(0,4);
 nearby.forEach((p,i)=>{const l=floraLights[i];l.position.set(p.x,height(p.x,p.z)+.65,p.z);l.intensity=2.2+Math.sin(time*1.1+i)*.25});
}

function setStageDecor(){
 stageWorld?.dispose();terrain=createTerrain(stage,runSeed);stageWorld=buildStageWorld(terrain);world.add(stageWorld.group);
 const [px,pz]=STAGES[stage-1].portal;stagePortal.position.set(px,height(px,pz)+2.7,pz);stagePortal.rotation.set(0,0,0);stagePortal.visible=portalActive;
 buildFlora();applyLighting();
}
function activatePortal(){if(stage===STAGES.length){summonBoss();return}if(portalActive)return;portalActive=true;stagePortal.visible=true;toast('RIFT PORTAL OPEN · '+STAGES[stage-1].name);for(let i=0;i<90;i++){const [x,z]=STAGES[stage-1].portal;burst(x,rand(.8,6),z,'#b974ff',1,3)}audio.fx('level');updateHUD()}
function enterStage(){if(!portalActive)return;if(stage>=STAGES.length)return;for(const g of gems)player.xp+=g.v;clearInput();player.vx=player.vz=0;player.dashing=0;player.inv=2;stage=Math.min(stage+1,STAGES.length);stageKills=0;stageGoal=STAGES[stage-1]?.goal||stageGoal+18;portalActive=false;for(const e of enemies)removeEnemy(e);clearObjects(shots);clearObjects(hazards);clearObjects(gems);clearObjects(particles);clearObjects(rings);particles=[];rings=[];numbers.forEach(n=>n.el.remove());numbers=[];enemies=[];shots=[];hazards=[];gems=[];player.x=0;player.z=0;player.hp=Math.min(player.max,player.hp+25);setStageDecor();toast('STAGE '+stage+' · '+STAGES[stage-1].name+' · SHARDS COLLECTED · +25 HEALTH');audio.fx('level');burst(0,1,0,'#d3a0ff',40,5);updateHUD()}

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
function character(kind='player'){
 const g=new T.Group(),body=new T.Group();g.add(body);
 const palette={player:['#33b7ba','#f1c89c','#ffba6f'],runner:['#bc6dd5','#e49ad1','#8946bd'],skitter:['#7ac777','#c1ed90','#467f6d'],gunner:['#e7ab57','#ffe1a2','#9265a1'],charger:['#e76568','#ffc2a0','#914564'],brute:['#9c80cf','#cfb5e7','#625e97'],mortar:['#668fe0','#bce4ff','#7162b9'],sniper:['#d4688e','#f8c7b8','#613f8c'],leaper:['#ed9d48','#ffe0a4','#8d5430'],splitter:['#55c8be','#b9fff0','#287e87'],stormer:['#4b86d7','#b5d3ff','#3d4fb0']}[kind]||['#bc6dd5','#e49ad1','#8946bd'];
 mesh('box',palette[0],0,1.12,0,.65,.7,.37,body);
 mesh('box',palette[2],0,1.38,.015,.76,.22,.44,body);
 mesh('box','#293b50',0,.76,0,.52,.19,.38,body);
 const head=mesh('box',palette[1],0,1.75,.025,.44,.46,.43,body);head.rotation.y=.04;
 mesh('box',kind==='player'?'#26334c':palette[2],0,1.96,-.035,.49,.16,.46,body);
 mesh('box',kind==='player'?'#bcffff':'#fff5a6',0,1.79,.252,.34,.1,.03,body,1.1);
 const legs=[],arms=[];
 for(let i=-1;i<=1;i+=2){let leg=new T.Group();leg.position.set(i*.17,.74,0);body.add(leg);mesh('box','#273c53',0,-.28,0,.21,.52,.24,leg);mesh('box','#344d62',0,-.57,.07,.24,.16,.4,leg);legs.push(leg);
 let arm=new T.Group();arm.position.set(i*.44,1.41,0);body.add(arm);mesh('box',palette[0],0,-.16,0,.23,.36,.25,arm);mesh('box',palette[1],0,-.4,.05,.18,.19,.2,arm);arms.push(arm)}
 mesh('box',palette[2],0,1.16,-.31,.44,.48,.24,body);mesh('box','#63758e',0,1.2,-.46,.23,.33,.1,body);
 const gunMount=new T.Group();gunMount.position.set(.4,1.22,.48);body.add(gunMount);
 let weapon=weaponModel(kind==='gunner'?0:kind==='mortar'?4:kind==='sniper'?3:0,gunMount);
 if(!['player','gunner','mortar','sniper'].includes(kind))gunMount.visible=false;
 if(kind==='warden'){g.scale.setScalar(2.6);for(let i=0;i<5;i++){const a=i*Math.PI*2/5;mesh('gem','#be83ff',Math.sin(a)*.55,2.15,Math.cos(a)*.55,.15,.6,.15,body,2.5)}mesh('box','#925be0',0,1.2,-.4,.8,.8,.3,body,1)}
 if(kind==='brute'){g.scale.setScalar(1.75);mesh('box','#69728d',-.57,1.4,0,.42,.45,.54,body);mesh('box','#69728d',.57,1.4,0,.42,.45,.54,body)}
 if(kind==='charger'){g.scale.setScalar(1.25);for(let s of [-1,1]){let horn=new T.Mesh(new T.ConeGeometry(.12,.5,4),material('#ffe3a3'));horn.position.set(s*.25,2.16,0);horn.rotation.z=-s*.5;body.add(horn)}}
 if(kind==='skitter'){g.scale.set(.75,.7,.75);body.rotation.x=.25}
 return {g,body,legs,arms,gunMount,weapon};
}
function animateCharacter(c,time,speed,recoil=0){c.legs[0].rotation.x=Math.sin(time*11)*.65*speed;c.legs[1].rotation.x=-c.legs[0].rotation.x;c.body.position.y=Math.abs(Math.sin(time*11))*.06*speed;c.arms[0].rotation.x=-.6+Math.sin(time*11)*.18*speed;c.arms[1].rotation.x=-1.15-recoil*.5;c.gunMount.position.z=.48-recoil*.14}
const hero=character();actors.add(hero.g);
const heroRing=new T.Mesh(new T.RingGeometry(.63,.69,40),new T.MeshBasicMaterial({color:'#a2fff1',transparent:true,opacity:.55,side:T.DoubleSide}));heroRing.rotation.x=-Math.PI/2;scene.add(heroRing);
let demoActive=false,demoFinished=false,demoAge=0,demoWeaponTime=0,demoStage=1,demoInput={x:0,z:0},demoFiring=false;
let player,mode='menu',elapsed=0,wave=1,score=0,kills=0,spawnTimer=0,shake=0,hit=0,recoil=0;
let enemies=[],shots=[],particles=[],gems=[],hazards=[],rings=[],numbers=[];
let selected=0,cameraYaw=.35,cameraDistance=25,aim=0,fireTimer=0,toastTimer;
let touchFire=false,overlay=null,overlayReturn='menu',bindingAction=null,runId=null,runName='Rift Runner',pendingScores=new Map(),savingScores=false,padFireLocked=false;
let keys={},mouse={x:0,y:0,moved:false,down:false,orbit:false},moveStick={x:0,y:0},aimStick={x:0,y:0},gamepadAim={x:0,y:0},gamepadFire=false,prevPad=[];
const raycaster=new T.Raycaster(),floorPlane=new T.Plane(new T.Vector3(0,1,0),-1),aimPoint=new T.Vector3();
function freshPlayer(){return {x:0,z:0,vx:0,vz:0,hp:100,max:100,xp:0,next:10,level:1,speed:6.4,damage:1,rate:1,pierce:0,extra:0,crit:.1,magnet:3.8,dashCD:0,dashing:0,inv:0,dx:0,dz:1,regen:0}}
player=freshPlayer();
function clearObjects(list){for(const o of list)if(o.m){effects.remove(o.m);if(o.ownMat)o.m.material.dispose()}}
function start(demo=false){
 demoActive=demo===true;demoFinished=false;demoAge=0;demoWeaponTime=0;demoInput={x:0,z:0};demoFiring=false;
 clearInput();runId=demoActive?null:crypto.randomUUID();runName=$('#playerName').value.trim().slice(0,16)||'Rift Runner';if(!demoActive){prefs.name=runName;savePrefs()}
 for(const e of enemies)removeEnemy(e);clearObjects(shots);clearObjects(particles);clearObjects(gems);clearObjects(hazards);clearObjects(rings);numbers.forEach(n=>n.el.remove());
 enemies=[];shots=[];particles=[];gems=[];hazards=[];rings=[];numbers=[];runSeed=(Math.random()*4294967296)>>>0;player=freshPlayer();elapsed=0;wave=1;score=0;kills=0;bossSpawned=false;victory=false;hitMarker=0;stage=1;stageKills=0;stageGoal=STAGES[0].goal;portalActive=false;spawnTimer=.8;fireTimer=0;selected=0;mode='play';cameraYaw=.35;cameraDistance=25;shake=hit=recoil=0;if(demoActive){stage=demoStage;stageGoal=STAGES[stage-1].goal;mode='menu';player.damage=1.6;player.rate=1.25;player.regen=3;player.hp=player.max=160}setStageDecor();
 if(demoActive){hero.g.visible=true;equip(0);for(let i=0;i<8;i++){const a=i*Math.PI/4;spawnEnemy(null,{x:Math.sin(a)*14,z:Math.cos(a)*14})}return}
 $('#menu').classList.add('hidden');$('#choice').classList.add('hidden');$('#pauseMenu').classList.add('hidden');hero.g.visible=true;
 document.body.classList.add('in-run');document.body.classList.remove('menu-open');
 equip(0);audio.start();toast('SECTOR 01 · RIFT AWAKENING');updateHUD();
}
function equip(i){selected=(i+WEAPONS.length)%WEAPONS.length;hero.gunMount.remove(hero.weapon);hero.weapon=weaponModel(selected,hero.gunMount);document.querySelectorAll('.weapon').forEach((b,n)=>{b.classList.toggle('active',n===selected);b.setAttribute('aria-pressed',String(n===selected))});fireTimer=Math.min(fireTimer,.16);if(mode==='play')audio.fx('switch')}
WEAPONS.forEach((w,i)=>{const b=document.createElement('button');b.className='weapon';b.style.setProperty('--rarity',w.color);b.title=`${i+1}: ${w.label} — ${w.description}`;b.setAttribute('aria-label',b.title);b.innerHTML=`<span class="num">${i+1}</span><span style="font-size:23px;color:${w.color}">${w.icon}</span><span class="name">${w.label}</span><span class="kind">${w.kind}</span>`;b.onclick=()=>equip(i);$('#weapons').appendChild(b)});equip(0);
function clearInput(){keys={};mouse.down=false;mouse.orbit=false;touchFire=false;gamepadFire=false;padFireLocked=true;moveStick.x=moveStick.y=aimStick.x=aimStick.y=0;for(const id of ['#moveStick','#aimStick'])$(id).querySelector('span').style.transform='none'}
function held(action){return !!keys[prefs.bindings[action]]}
function pause(){if(overlay){closePanel();return}if(mode==='play'){clearInput();mode='pause';document.body.classList.add('menu-open');$('#pauseStats').textContent=`SECTOR ${wave} · ${score.toLocaleString()} SCORE · ${formatTime(elapsed)}`;$('#pauseMenu').classList.remove('hidden');$('#resume').focus()}else if(mode==='pause'){clearInput();mode='play';document.body.classList.remove('menu-open');$('#pauseMenu').classList.add('hidden')}}
function dash(){if((mode!=='play'&&!demoActive)||player.dashCD>0)return;const v=inputMovement();let l=Math.hypot(v.x,v.z);player.dx=l>.1?v.x/l:Math.sin(aim);player.dz=l>.1?v.z/l:Math.cos(aim);player.dashing=.22;player.dashCD=1.8;player.inv=.35;burst(player.x,1,player.z,'#98ffff',25,5);audio.fx('dash')}
$('#start').onclick=()=>start();$('#pause').onclick=pause;$('#resume').onclick=pause;$('#dashTouch').onclick=dash;
function trigger(code){if(code===prefs.bindings.pause){pause();return}if(mode!=='play'||overlay)return;if(code===prefs.bindings.dash)dash();for(let i=1;i<=5;i++)if(code===prefs.bindings['weapon'+i])equip(i-1)}
addEventListener('keydown',e=>{if(bindingAction){e.preventDefault();if(e.code==='Escape'){bindingAction=null;renderBindings();$('#bindStatus').textContent='Rebinding cancelled.'}else if(!e.repeat)captureBinding(e.code);return}if(e.code==='Escape'){e.preventDefault();pause();return}if(e.target?.matches?.('input,textarea,select'))return;if(mode!=='play'&&mode!=='pause')return;if(Object.values(prefs.bindings).includes(e.code))e.preventDefault();if(mode==='play')keys[e.code]=true;if(!e.repeat)trigger(e.code)});
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
function pollPad(){const p=navigator.getGamepads?.()[0];gamepadAim={x:0,y:0};gamepadFire=false;if(!p)return;const dead=v=>Math.abs(v)>.16?v:0;gamepadAim={x:dead(p.axes[2]||0),y:dead(p.axes[3]||0)};if(!p.buttons[7]?.pressed)padFireLocked=false;gamepadFire=!padFireLocked&&!!p.buttons[7]?.pressed;const rising=i=>p.buttons[i]?.pressed&&!prevPad[i];if(mode==='play'&&!overlay){if(rising(0))dash();if(rising(4))equip(selected-1);if(rising(5))equip(selected+1)}if(rising(9))pause();prevPad=p.buttons.map(b=>b.pressed)}
function inputMovement(){if(demoActive)return demoInput;let x=(held('right')?1:0)-(held('left')?1:0),y=(held('back')?1:0)-(held('forward')?1:0);if(Math.hypot(moveStick.x,moveStick.y)>.05){x=moveStick.x;y=moveStick.y}const p=navigator.getGamepads?.()[0];if(p&&Math.hypot(p.axes[0],p.axes[1])>.17){x=p.axes[0];y=p.axes[1]}return movementVector(x,y,cameraYaw)}
function moveWithCollision(o,dx,dz,r){terrain.move(o,dx,dz,r)}
function spawnEnemy(kind,near=null){
 const unlocked=STAGES[stage-1]?.pool||Object.keys(ENEMY_TYPES);
 kind=kind||unlocked[Math.floor(rand(0,unlocked.length))];const def=kind==='warden'?{hp:1300,speed:1.8,radius:1.35,damage:24,score:5000,xp:0,color:'#c78dff'}:ENEMY_TYPES[kind],a=rand(0,Math.PI*2),r=rand(17,23);
 const location=near?terrain.safeNear(near.x,near.z,def.radius):terrain.spawn(player.x,player.z,def.radius);let {x,z}=location;
 const c=character(kind);actors.add(c.g);c.g.position.set(x,height(x,z),z);
 const difficulty=1+(stage-1)*.22+Math.min(wave-1,20)*.05;
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
  if(d>8){const v=terrain.steer(e.x,e.z,player.x,player.z,e);moveWithCollision(e,v.x*e.def.speed*dt,v.z*e.def.speed*dt,e.def.radius)}
  if(e.cool<=0){e.state='bossWindup';e.timer=e.enraged?.75:1.1;e.tx=player.x;e.tz=player.z;e.ax=dx/d;e.az=dz/d;
   if(e.attackIndex%2===0)ring(e.x,e.z,'#d18aff',4,1.1);else warnLine(e,d,'#ffab74');
  }
 }
 if(d<e.def.radius+.45)hurtPlayer(e.def.damage);
 e.c.g.position.set(e.x,height(e.x,e.z),e.z);e.c.g.rotation.y=Math.atan2(dx,dz);animateCharacter(e.c,elapsed,.4);
}
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
function projectile(x,z,a,w,enemy=false){const s=Math.sin(a),c=Math.cos(a),m=mesh(w.rocket?'ico':'box',w.color,x,height(x,z)+1.1,z,w.rocket?.16:.065,w.rocket?.16:.065,w.rocket?.35:.6,effects,2.4);m.rotation.y=a;m.castShadow=false;shots.push({m,x,z,px:x,pz:z,vx:s*w.speed,vz:c*w.speed,life:w.range/w.speed,damage:w.damage*(enemy?1:player.damage),pierce:w.pierce+(enemy?0:player.pierce),hitIds:new Set(),enemy,rocket:w.rocket||false,radius:w.radius||0,color:w.color})}
function fire(){const w=WEAPONS[selected],originX=player.x+Math.sin(aim)*.9,originZ=player.z+Math.cos(aim)*.9;const count=w.count+player.extra;
 for(let i=0;i<count;i++){const spread=w.spread,offset=count===1?rand(-spread,spread):(i-(count-1)/2)*spread;projectile(originX,originZ,aim+offset,w)}
 recoil=1;flashLight.position.set(originX,height(originX,originZ)+1.4,originZ);flashLight.color.set(w.color);flashLight.intensity=9;burst(originX,1.1,originZ,'#ffeca6',w.rocket?10:4,2);audio.fx(w.sound);if(w.rocket||selected===2)shake=.08;
}
function damageText(x,z,damage,critical){if(numbers.length>25)return;const el=document.createElement('span');el.className='damage'+(critical?' critical':'');el.textContent=Math.round(damage);$('#damageNumbers').appendChild(el);numbers.push({el,x,z,y:height(x,z)+2.2,life:.7})}
function hurtEnemy(e,damage,critical=false){if(e.hp<=0||victory)return;hitMarker=.12;e.hp-=damage;e.hit=.1;burst(e.x,1.2,e.z,critical?'#ffe668':'#c9fffe',5,2);damageText(e.x,e.z,damage,critical);if(e.hp<=0){score+=e.def.score;kills++;stageKills++;burst(e.x,1.2,e.z,e.def.color,e.kind==='brute'?32:18,4);ring(e.x,e.z,e.def.color,1.4,.3);audio.fx('kill');removeEnemy(e);if(e.kind==='warden'){victory=true;finishRun(false);return}const m=mesh('gem','#80ffde',e.x,height(e.x,e.z)+.4,e.z,.16,.26,.16,effects,1.5);gems.push({m,x:e.x,z:e.z,v:e.def.xp});if(e.kind==='splitter'&&stage>=3){for(let i=0;i<2;i++){const child=spawnEnemy('skitter',{x:e.x+rand(-2,2),z:e.z+rand(-2,2)});child.hp*=.45;child.max=child.hp}}if(kills%12===0){player.hp=Math.min(player.max,player.hp+5)}if(stageKills>=stageGoal)activatePortal()}}
function hurtPlayer(amount){if(player.inv>0||(mode!=='play'&&!demoActive))return;player.hp=Math.max(0,player.hp-amount);player.inv=.6;hit=1;shake=.22;burst(player.x,1,player.z,'#ff7193',15,3);audio.fx('hurt');if(player.hp<=0)finishRun(true)}
function explode(x,z,radius,damage,enemy=false){burst(x,.7,z,enemy?'#ff855f':'#ffd774',38,7);ring(x,z,'#ffe7ad',radius,.45);shake=.23;audio.fx('explosion');if(enemy){if(Math.hypot(player.x-x,player.z-z)<radius+.35)hurtPlayer(damage)}else{for(const e of enemies)if(e.hp>0&&Math.hypot(e.x-x,e.z-z)<radius+e.def.radius)hurtEnemy(e,damage)}}
function hazard(x,z,radius,damage,delay,kind){const mat=new T.MeshBasicMaterial({color:'#ff6257',transparent:true,opacity:.45,side:T.DoubleSide,depthWrite:false});const m=new T.Mesh(new T.CircleGeometry(1,40),mat);m.rotation.x=-Math.PI/2;m.position.set(x,height(x,z)+.09,z);m.scale.setScalar(radius);effects.add(m);hazards.push({m,x,z,radius,damage,life:delay,max:delay,kind,ownMat:true});ring(x,z,'#ffad55',radius,delay)}
function enemyUpdate(e,dt){
 if(e.hp<=0)return;e.cool-=dt;e.hit=Math.max(0,e.hit-dt);e.spawn=Math.max(0,e.spawn-dt);
 if(e.kind==='warden'){bossUpdate(e,dt);return}
 const dx=player.x-e.x,dz=player.z-e.z,d=Math.hypot(dx,dz)||1,nx=dx/d,nz=dz/d;let speed=e.def.speed*(1+Math.min(wave-1,10)*.025),moving=0;
 if(e.state==='snipe'){e.timer-=dt;if(e.timer<=0){projectile(e.x,e.z,Math.atan2(e.ax,e.az),{color:'#ff2f9e',damage:29,speed:24,range:42,pierce:0},true);e.state='approach';e.cool=2.6;clearWarning(e)}}
 else if(e.state==='windup'){e.timer-=dt;e.c.body.rotation.z=Math.sin(elapsed*40)*.035;if(e.kind==='leaper')e.c.g.position.y=height(e.x,e.z)+1+Math.max(0,1-e.timer)*2;if(e.timer<=0){clearWarning(e);e.state=e.kind==='leaper'?'leap':'charge';e.timer=e.kind==='leaper'?.6:.68;audio.fx('charge')}}
 else if(e.state==='charge'){moveWithCollision(e,e.ax*18*dt,e.az*18*dt,e.def.radius);moving=2;e.timer-=dt;if(Math.random()<.4)burst(e.x,.5,e.z,'#ffb171',2,1);if(e.timer<=0){e.state='approach';e.cool=3.5;e.c.body.rotation.z=0}}
 else if(e.state==='leap'){moveWithCollision(e,e.ax*25*dt,e.az*25*dt,e.def.radius);moving=2;e.timer-=dt;if(e.timer<=0){hazard(e.x,e.z,3.6,e.def.damage*1.3,.2,'leap');e.state='approach';e.cool=3.5}}
 else{
  if(e.kind==='charger'&&d<12&&d>3&&e.cool<0){e.state='windup';e.timer=.85;e.ax=nx;e.az=nz;e.c.g.rotation.y=Math.atan2(nx,nz);ring(e.x,e.z,'#ff5656',2,.85);warnLine(e,12,'#ff6d63');}
  else if(e.kind==='brute'&&d<3.8&&e.cool<0){hazard(e.x,e.z,4.2,25,.95,'slam');e.cool=3.5;e.timer=.95;}
  else if(e.kind==='mortar'&&e.cool<0){hazard(player.x+player.vx*.25,player.z+player.vz*.25,2.5,21,1.35,'mortar');e.cool=3.1;audio.fx('mortar')}
  else if(e.kind==='gunner'&&d<18&&e.cool<0){const a=Math.atan2(nx,nz);for(let i=-1;i<=1;i++)projectile(e.x,e.z,a+i*.17,{color:'#ff816a',damage:11,speed:10,range:26,pierce:0},true);e.cool=1.8;burst(e.x,1.3,e.z,'#ffe484',6,1)}
  else if(e.kind==='sniper'&&d>8&&d<32&&e.cool<0){e.state='snipe';e.timer=.95;e.ax=nx;e.az=nz;warnLine(e,42,'#ff4eae')}
  else if(e.kind==='stormer'&&e.cool<0){for(let i=0;i<8;i++)projectile(e.x,e.z,i*Math.PI/4+elapsed*.15,{color:'#7db3ff',damage:10,speed:9,range:18,pierce:0},true);e.cool=3.8;burst(e.x,1.4,e.z,'#9fcbff',13,2)}
  else if(e.kind==='leaper'&&d<15&&e.cool<0){e.state='windup';e.timer=.75;e.ax=nx;e.az=nz;ring(e.x,e.z,'#ffca66',2,.75)}
  e.timer=Math.max(0,e.timer-dt);
  if(e.timer<=0){let dir=1;if(e.kind==='gunner'||e.kind==='mortar'||e.kind==='sniper'){if(d<8)dir=-.7;else if(d<18)dir=0}let strafe=(e.kind==='skitter'||e.kind==='stormer')?Math.sin(elapsed*4+e.phase)*.6:0;if(dir>0&&d>3)strafe=0;const v=dir>0&&d>3?terrain.steer(e.x,e.z,player.x,player.z,e):{x:nx,z:nz};const mx=(v.x*dir-nz*strafe)*speed*dt,mz=(v.z*dir+nx*strafe)*speed*dt;moveWithCollision(e,mx,mz,e.def.radius);moving=Math.abs(dir);e.c.g.rotation.y=Math.atan2(nx,nz)}
 }
 if(d<e.def.radius+.48)hurtPlayer(e.state==='charge'?24:e.def.damage);
 e.c.g.position.set(e.x,height(e.x,e.z)+(e.state==='leap'?Math.sin(clamp(e.timer/.6,0,1)*Math.PI)*3:0),e.z);animateCharacter(e.c,elapsed+e.phase,moving);e.c.body.scale.setScalar(e.hit>0?1.08:1);e.c.g.visible=e.spawn<=0||Math.floor(elapsed*20)%2===0;
}
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
function levelUp(){if(demoActive){player.xp-=player.next;player.level++;player.next=Math.floor(player.next*1.3+3);UPGRADES[Math.floor(Math.random()*UPGRADES.length)][3]();return}player.xp-=player.next;player.level++;player.next=Math.floor(player.next*1.3+3);mode='upgrade';$('#cards').replaceChildren();const pool=[...UPGRADES];for(let i=pool.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]]}pool.slice(0,3).forEach(u=>{const b=document.createElement('button');b.className='card';b.innerHTML=`<span class="symbol">${u[1]}</span><strong>${u[0].toUpperCase()}</strong><p>${u[2]}</p>`;b.onclick=()=>{u[3]();mode='play';$('#choice').classList.add('hidden');toast(u[0].toUpperCase());updateHUD()};$('#cards').appendChild(b)});$('#choice').classList.remove('hidden');$('#cards button').focus();audio.fx('level')}
function toast(text){if(demoActive)return;$('#waveToast').textContent=text;$('#waveToast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#waveToast').classList.remove('show'),2200)}
function updateHUD(){if(demoActive)return;
 $('#healthText').textContent=`${Math.ceil(player.hp)} / ${player.max}`;$('#healthBar').style.width=100*player.hp/player.max+'%';$('#xpBar').style.width=Math.min(100,100*player.xp/player.next)+'%';$('#level').textContent=player.level;$('#score').textContent=score.toLocaleString()+' SCORE';
 $('#sector').textContent=`STAGE ${stage} · ${STAGES[stage-1]?.name||'VOID'}`;$('#clock').textContent=String(Math.floor(elapsed/60)).padStart(2,'0')+':'+String(Math.floor(elapsed%60)).padStart(2,'0');$('#hostiles').textContent=enemies.filter(e=>e.hp>0).length+' HOSTILES';$('#dashStatus').textContent=player.dashCD>0?'DASH '+player.dashCD.toFixed(1)+'s':'PHASE DASH READY';$('#crosshair').style.display=mode==='play'&&mouse.moved?'block':'none';
 const c=$('#portalCompass');if(mode==='play'&&stage<STAGES.length){c.classList.remove('hidden');const {x:px,z:pz}=stagePortal.position,dx=px-player.x,dz=pz-player.z;const distance=Math.hypot(dx,dz);const viewYaw=Math.atan2(camera.position.x-player.x,camera.position.z-player.z),delta=portalBearing(dx,dz,viewYaw);$('.compass-arrow').style.transform=`rotate(${delta*180/Math.PI}deg)`;$('#portalLabel').textContent=portalActive?'RIFT PORTAL OPEN':'RIFT PORTAL LOCKED';$('#portalDistance').textContent=portalActive?`${Math.round(distance)}m · ENTER TO DESCEND`:`${stageKills} / ${stageGoal} KILLS TO OPEN`}else c.classList.add('hidden');
}

function update(dt){
 if((mode!=='play'&&!demoActive)||overlay||demoFinished)return;
 elapsed+=dt;player.inv=Math.max(0,player.inv-dt);player.dashCD=Math.max(0,player.dashCD-dt);player.dashing=Math.max(0,player.dashing-dt);player.hp=Math.min(player.max,player.hp+player.regen*dt);
 if(!demoActive&&held('orbitLeft'))cameraYaw+=dt*1.6;if(!demoActive&&held('orbitRight'))cameraYaw-=dt*1.6;
 const input=inputMovement(),smooth=1-Math.exp(-dt*16);player.vx=lerp(player.vx,input.x*player.speed,smooth);player.vz=lerp(player.vz,input.z*player.speed,smooth);
 if(player.dashing>0){moveWithCollision(player,player.dx*27*dt,player.dz*27*dt,.45);burst(player.x,.6,player.z,'#81ffff',3,1)}else moveWithCollision(player,player.vx*dt,player.vz*dt,.45);
 let manual=demoActive,shooting=demoActive?demoFiring:held('fire')||touchFire||gamepadFire;
 const stick=Math.hypot(aimStick.x,aimStick.y)>.15?aimStick:gamepadAim;
 if(!demoActive&&Math.hypot(stick.x,stick.y)>.18){const v=movementVector(stick.x,stick.y,cameraYaw);aim=Math.atan2(v.x,v.z);manual=true}
 else if(!demoActive&&mouse.moved){floorPlane.constant=-(height(player.x,player.z)+1);raycaster.setFromCamera(new T.Vector2(mouse.x/innerWidth*2-1,-mouse.y/innerHeight*2+1),camera);const hitSurface=raycaster.intersectObject(stageWorld.surface,false)[0];if(hitSurface)aimPoint.copy(hitSurface.point);if(hitSurface||raycaster.ray.intersectPlane(floorPlane,aimPoint))aim=Math.atan2(aimPoint.x-player.x,aimPoint.z-player.z);manual=true}
 if(!manual&&!shooting&&Math.hypot(input.x,input.z)>.1)aim=Math.atan2(input.x,input.z);
 hero.g.rotation.y=aim;hero.g.position.set(player.x,height(player.x,player.z),player.z);animateCharacter(hero,elapsed,Math.min(1,Math.hypot(player.vx,player.vz)/5),recoil);hero.g.visible=player.inv<=0||Math.floor(elapsed*24)%2===0;
 fireTimer-=dt;if(shooting&&fireTimer<=0){fire();fireTimer=WEAPONS[selected].cooldown/player.rate}
 if(portalActive&&Math.hypot(player.x-stagePortal.position.x,player.z-stagePortal.position.z)<PORTAL_RADIUS){enterStage();return}
 spawnTimer-=dt;if(!bossSpawned&&spawnTimer<=0&&enemies.length<55){spawnEnemy();spawnTimer=Math.max(.3,1.5-wave*.12)}
 const nextWave=1+Math.floor(elapsed/30);if(nextWave>wave){wave=nextWave;if(!bossSpawned){toast('RIFT SURGE · STAY MOVING');audio.fx('level');player.hp=Math.min(player.max,player.hp+12);for(let i=0;i<Math.min(wave,6);i++)spawnEnemy()}}
 for(const e of enemies)enemyUpdate(e,dt);
 if((mode!=='play'&&!demoActive)||demoFinished)return;
 for(const b of shots){b.px=b.x;b.pz=b.z;b.x+=b.vx*dt;b.z+=b.vz*dt;b.life-=dt;b.m.position.set(b.x,height(b.x,b.z)+1.1,b.z);
  if(b.enemy){if(segmentHit(b.px,b.pz,b.x,b.z,player.x,player.z,.52)){hurtPlayer(b.damage);b.life=0}}
  else for(const e of enemies){if(e.hp>0&&!b.hitIds.has(e.id)&&segmentHit(b.px,b.pz,b.x,b.z,e.x,e.z,e.def.radius+.12)){b.hitIds.add(e.id);if(b.rocket){explode(b.x,b.z,b.radius,b.damage);b.life=0;break}const critical=Math.random()<player.crit;hurtEnemy(e,b.damage*(critical?2:1),critical);b.pierce--;if(b.pierce<0){b.life=0;break}}}
  if(b.rocket&&b.life>0&&Math.random()<.5)burst(b.x,1,b.z,'#ffbd65',1,.7);
  if(b.life<=0){if(b.rocket&&b.hitIds.size===0)explode(b.x,b.z,b.radius,b.damage);effects.remove(b.m)}
 }
 shots=shots.filter(b=>b.life>0);enemies=enemies.filter(e=>e.hp>0);if((mode!=='play'&&!demoActive)||demoFinished)return;
 for(const h of hazards){h.life-=dt;h.m.material.opacity=.2+(1-h.life/h.max)*.5;h.m.scale.setScalar(h.radius*(.9+.1*Math.sin(elapsed*18)));if(h.life<=0){explode(h.x,h.z,h.radius,h.damage,true);effects.remove(h.m);h.m.material.dispose()}}
 hazards=hazards.filter(h=>h.life>0);if((mode!=='play'&&!demoActive)||demoFinished)return;
 for(const g of gems){const dx=player.x-g.x,dz=player.z-g.z,d=Math.hypot(dx,dz);if(d<player.magnet){const speed=Math.min(d,dt*(4+16/(d+.2)));g.x+=dx/(d||1)*speed;g.z+=dz/(d||1)*speed}g.m.position.set(g.x,height(g.x,g.z)+.45+Math.sin(elapsed*4+g.x)*.12,g.z);g.m.rotation.y+=dt*2;if(d<.65){player.xp+=g.v;g.dead=true;effects.remove(g.m);audio.fx('gem')}}gems=gems.filter(g=>!g.dead);
 if(player.xp>=player.next){clearInput();levelUp()}updateHUD();
}
function updateEffects(dt){for(const p of particles){p.life-=dt;p.vy-=12*dt;p.m.position.x+=p.vx*dt;p.m.position.y+=p.vy*dt;p.m.position.z+=p.vz*dt;p.m.rotation.x+=dt*5;p.m.rotation.z+=dt*3;p.m.scale.multiplyScalar(Math.exp(-dt*1.5));if(p.life<=0)effects.remove(p.m)}particles=particles.filter(p=>p.life>0);
 if(stagePortal){stagePortal.children[1].rotation.z+=dt*.72;stagePortal.scale.setScalar(1+Math.sin(elapsed*4)*.08);if(portalLight){portalLight.intensity=portalActive?19+Math.sin(elapsed*9)*6:0;portalLight.color.set('#9e5cff')}if(portalActive&&Math.random()<dt*9){const [x,z]=STAGES[stage-1].portal;burst(x+rand(-2.5,2.5),rand(1,6),z+rand(-2.5,2.5),'#b974ff',1,1.8)}}
 for(const r of rings){r.life-=dt;r.m.scale.setScalar(r.size*(1-r.life/r.max));r.m.material.opacity=Math.max(0,r.life/r.max)*.7;if(r.life<=0){effects.remove(r.m);r.m.material.dispose()}}rings=rings.filter(r=>r.life>0);
 for(const n of numbers){n.life-=dt;n.y+=dt*1.7;const v=new T.Vector3(n.x,n.y,n.z).project(camera);n.el.style.left=(v.x*.5+.5)*innerWidth+'px';n.el.style.top=(-v.y*.5+.5)*innerHeight+'px';n.el.style.opacity=Math.min(1,n.life*3);if(n.life<=0)n.el.remove()}numbers=numbers.filter(n=>n.life>0);
 recoil=Math.max(0,recoil-dt*9);flashLight.intensity*=Math.exp(-dt*22);shake*=Math.exp(-dt*14);hit=Math.max(0,hit-dt*4);$('#hitflash').style.opacity=hit*.6;
}
function cameraUpdate(dt,time){const target=new T.Vector3(player.x,height(player.x,player.z)+1,player.z);let yaw=cameraYaw,dist=cameraDistance;
 if(demoActive){yaw=.4;dist=29;target.x+=Math.cos(yaw)*7;target.z-=Math.sin(yaw)*7}
 const desired=target.clone().add(new T.Vector3(Math.sin(yaw)*dist,dist*.85,Math.cos(yaw)*dist));camera.position.lerp(desired,1-Math.exp(-dt*7));camera.lookAt(target);if(!reduced){camera.position.x+=rand(-shake,shake);camera.position.y+=rand(-shake,shake)}
 heroRing.position.set(player.x,height(player.x,player.z)+.05,player.z);heroRing.visible=mode!=='dead';
 sun.position.set(player.x-24,height(player.x,player.z)+45,player.z+18);sun.target.position.set(player.x,height(player.x,player.z),player.z);sun.target.updateMatrixWorld();
}
camera.position.set(10,22,25);camera.lookAt(0,1,0);
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight)});

function formatTime(seconds){return Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0')}
function openPanel(id){if(mode==='play')pause();overlayReturn=mode;overlay=id;clearInput();document.body.classList.add('menu-open');$(id).classList.remove('hidden');if(id==='#settings'){renderBindings();syncSettings();$('#closeSettings').focus()}else{loadLeaderboard();$('#closeLeaderboard').focus()}}
function closePanel(){if(!overlay)return;$(overlay).classList.add('hidden');overlay=null;bindingAction=null;clearInput();if(overlayReturn==='pause')$('#resume').focus();else $('#start').focus()}
function captureBinding(code){if(!bindingAction)return;if(['Escape','MetaLeft','MetaRight','F5','F11','F12'].includes(code)){ $('#bindStatus').textContent='That key is reserved. Choose another key.';return}const action=bindingAction;const swap=assignBinding(prefs.bindings,action,code);bindingAction=null;savePrefs();renderBindings();refreshHelp();$('#bindStatus').textContent=ACTION_LABELS[action]+' → '+keyLabel(code)+(swap?' · Swapped with '+ACTION_LABELS[swap]:'')}
function renderBindings(){$('#bindings').replaceChildren();for(const [action,label] of Object.entries(ACTION_LABELS)){const row=document.createElement('div');row.className='bind-row';const name=document.createElement('span');name.textContent=label;const b=document.createElement('button');b.textContent=bindingAction===action?'PRESS A KEY…':keyLabel(prefs.bindings[action]);b.classList.toggle('listening',bindingAction===action);b.setAttribute('aria-label','Change '+label+' binding');b.onclick=()=>{bindingAction=action;renderBindings();$('#bindStatus').textContent='Press a key or mouse button. Escape cancels.'};row.appendChild(name);row.appendChild(b);$('#bindings').appendChild(row)}}
document.addEventListener('pointerdown',e=>{if(!bindingAction||e.pointerType==='touch')return;e.preventDefault();e.stopImmediatePropagation();captureBinding('Mouse'+e.button)},true);
document.addEventListener('contextmenu',e=>{if(overlay==='#settings')e.preventDefault()});
document.addEventListener('keydown',e=>{if(e.code!=='Tab'||bindingAction)return;const root=overlay?$(overlay):mode==='pause'?$('#pauseMenu'):mode==='upgrade'?$('#choice'):null;if(!root)return;const list=[...root.querySelectorAll('button:not(:disabled),input')];const first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}});
function refreshHelp(){const b=prefs.bindings;document.querySelectorAll('.weapon').forEach((el,i)=>{el.querySelector('.num').textContent=keyLabel(b['weapon'+(i+1)])})}
function syncSettings(){for(const [id,key] of [['master','master'],['music','music'],['effects','effects']]){$('#'+id+'Volume').value=prefs[key];$('#'+id+'Value').textContent=prefs[key]+'%'}$('#sound').textContent=prefs.muted?'SOUND OFF':'SOUND ON'}
for(const [id,key] of [['master','master'],['music','music'],['effects','effects']])$('#'+id+'Volume').oninput=e=>{prefs[key]=clamp(Number(e.target.value),0,100);if(key==='master'&&prefs.master>0)prefs.muted=false;savePrefs();syncSettings();audio.apply()};
$('#resetBindings').onclick=()=>{prefs.bindings={...DEFAULT_BINDINGS};bindingAction=null;savePrefs();renderBindings();refreshHelp();$('#bindStatus').textContent='Default controls restored.'};
$('#menuSettings').onclick=$('#pauseSettings').onclick=()=>openPanel('#settings');$('#menuLeaderboard').onclick=$('#pauseLeaderboard').onclick=()=>openPanel('#leaderboard');$('#closeSettings').onclick=$('#closeLeaderboard').onclick=closePanel;$('#refreshLeaderboard').onclick=loadLeaderboard;$('#endRun').onclick=()=>finishRun(false);$('#retryScore').onclick=saveScores;
$('#playerName').value=prefs.name;
function setTimeOfDay(value){prefs.timeOfDay=value;savePrefs();$('#dayMode').classList.toggle('active',value==='day');$('#nightMode').classList.toggle('active',value==='night');applyLighting();toast(value==='night'?'NIGHT MODE · MOONLIT RIFT':'DAY MODE · CLEAR SKIES')}
$('#dayMode').onclick=()=>setTimeOfDay('day');$('#nightMode').onclick=()=>setTimeOfDay('night');setTimeOfDay(prefs.timeOfDay);
function finishRun(defeated){if(demoActive){demoFinished=true;return}if(!['play','pause'].includes(mode))return;clearInput();mode='dead';hero.g.visible=!defeated;document.body.classList.remove('in-run');document.body.classList.add('menu-open');$('#pauseMenu').classList.add('hidden');$('#menu').classList.remove('hidden');$('#bossHUD').classList.add('hidden');$('#portalCompass').classList.add('hidden');$('#stageObjective').textContent='';$('.menu-card h1').innerHTML=victory?'RIFT<br><span>CONQUERED</span>':defeated?'RUN<br><span>SEVERED</span>':'RUN<br><span>COMPLETE</span>';$('.menu-card .edition').textContent=`STAGE ${stage} · ${score.toLocaleString()} SCORE`;$('#runSummary').textContent=`${kills} KILLS · ${formatTime(elapsed)}`;$('#start').textContent='PLAY AGAIN';$('#start').focus();if(runId&&elapsed>=1){pendingScores.set(runId,{id:runId,name:runName,score,kills,wave,seconds:Math.floor(elapsed)});runId=null;saveScores()}else $('#scoreSave').textContent=''}
async function saveScores(){if(savingScores||!pendingScores.size)return;savingScores=true;$('#scoreSave').textContent='Saving your score…';$('#retryScore').classList.add('hidden');try{for(const [id,run] of pendingScores){const r=await fetch('/api/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(run)});if(!r.ok)throw new Error('Save unavailable');pendingScores.delete(id)}$('#scoreSave').textContent='Score saved.'}catch{$('#scoreSave').textContent='Score not saved. Retry when connected.';$('#retryScore').classList.remove('hidden')}finally{savingScores=false}}
async function loadLeaderboard(){$('#leaderboardRows').replaceChildren();$('#leaderboardStatus').textContent='Loading scores…';try{const r=await fetch('/api/scores',{cache:'no-store'});if(!r.ok)throw new Error('Unavailable');const data=await r.json();if(!Array.isArray(data.scores))throw new Error('Invalid scores');$('#leaderboardStatus').textContent=data.scores.length?'':'No scores yet.';data.scores.forEach((s,i)=>{const tr=document.createElement('tr');for(const value of [i+1,s.name,s.score.toLocaleString(),s.wave,formatTime(s.seconds)]){const td=document.createElement('td');td.textContent=String(value);tr.appendChild(td)}$('#leaderboardRows').appendChild(tr)})}catch{$('#leaderboardStatus').textContent='Leaderboard unavailable right now. Press Refresh to try again.'}}

// Original synthwave score: four evolving chords, arpeggio, bass, kick and hats.
const audio={ctx:null,master:null,music:null,sfx:null,bus:null,step:0,next:0,
 apply(){if(!this.master)return;this.master.gain.value=prefs.muted?0:.22*prefs.master/100;this.music.gain.value=prefs.music/100;this.sfx.gain.value=prefs.effects/100},
 start(){try{if(this.ctx){this.ctx.resume();return}this.ctx=new (window.AudioContext||window.webkitAudioContext)();this.master=this.ctx.createGain();this.music=this.ctx.createGain();this.sfx=this.ctx.createGain();this.master.connect(this.ctx.destination);this.music.connect(this.master);this.sfx.connect(this.master);this.apply();this.next=this.ctx.currentTime;this.tick()}catch{ $('#sound').textContent='SOUND UNAVAILABLE'}},
 tone(f,time,duration,type='triangle',volume=.12,end){if(!this.ctx)return;const o=this.ctx.createOscillator(),g=this.ctx.createGain();o.type=type;o.frequency.setValueAtTime(f,time);if(end)o.frequency.exponentialRampToValueAtTime(end,time+duration);g.gain.setValueAtTime(.0001,time);g.gain.linearRampToValueAtTime(volume,time+.005);g.gain.exponentialRampToValueAtTime(.0001,time+duration);o.connect(g);g.connect(this.bus||this.sfx);o.start(time);o.stop(time+duration)},
 tick(){this.bus=this.music;if(this.ctx.state==='running'){while(this.next<this.ctx.currentTime+.12){const s=this.step,base=[55,65.406,49,73.416][Math.floor(s/32)%4],time=this.next,vol=mode==='play'?1:.35;
 this.tone(base*(s%8===6?2:1),time,.19,'sawtooth',.14*vol);const arp=[2,3,4,6,4,3,2,4][s%8];this.tone(base*arp*2,time,.15,'triangle',.085*vol);
 if(s%4===0)this.tone(135,time,.15,'sine',.65*vol,35);if(s%2===1)this.tone(7800,time,.025,'square',.025*vol);if(s%8===4)this.tone(190,time,.09,'triangle',.24*vol,80);
 if(s%16===0)[1,1.5,2.4].forEach(r=>this.tone(base*r*2,time,1.4,'triangle',.045*vol));this.step++;this.next+=60/112/4;
 }}else this.next=this.ctx.currentTime;this.bus=null;setTimeout(()=>this.tick(),40)},
 fx(type){if(demoActive||!this.ctx||prefs.muted)return;const n=this.ctx.currentTime;const tones={rifle:[600,.065,'sawtooth',.09,130],smg:[850,.045,'square',.045,230],shotgun:[180,.14,'sawtooth',.23,40],rail:[1600,.23,'sawtooth',.1,130],rocket:[120,.25,'sawtooth',.2,35],explosion:[90,.3,'sawtooth',.25,24],hurt:[140,.17,'sawtooth',.15,45],kill:[180,.06,'triangle',.06,65],gem:[1100,.07,'sine',.06,1600],dash:[220,.18,'sawtooth',.12,880],charge:[160,.35,'sawtooth',.1,500],mortar:[350,.12,'triangle',.07,130],switch:[350,.05,'triangle',.1,600]};if(type==='level'){[440,554,660,880].forEach((f,i)=>this.tone(f,n+i*.08,.25,'triangle',.13));return}const a=tones[type];if(a)this.tone(a[0],n,a[1],a[2],a[3],a[4])}
};
$('#sound').onclick=()=>{prefs.muted=!prefs.muted;savePrefs();audio.apply();syncSettings()};

// Attract mode uses the same simulation as a run; only its input comes from a CPU.
// It never starts audio, creates a score submission, or reads the user's controls.
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
  if(target){aim=Math.atan2(target.x-player.x,target.z-player.z);
   if(distance>10)demoInput=terrain.steer(player.x,player.z,target.x,target.z,player);
   else{const a=aim+Math.PI/2;demoInput={x:Math.sin(a)*.85-Math.sin(aim)*(distance<5?.7:0),z:Math.cos(a)*.85-Math.cos(aim)*(distance<5?.7:0)};const n=Math.max(1,Math.hypot(demoInput.x,demoInput.z));demoInput.x/=n;demoInput.z/=n}
   if(distance<4&&player.dashCD<=0)dash();
  }else demoInput={x:0,z:0};
  if(portalActive)demoInput=terrain.steer(player.x,player.z,stagePortal.position.x,stagePortal.position.z,player);
  update(step);updateEffects(step);
  if(demoFinished)break;
 }
}

let last=performance.now(),slowFrames=0,qualityReduced=false;
function frame(now){requestAnimationFrame(frame);const raw=(now-last)/1000,dt=Math.min(raw,.04);last=now;if(mode==='menu'||mode==='dead')updateDemo(dt);else{pollPad();if(mode==='play')update(dt);if(mode!=='pause'&&mode!=='upgrade')updateEffects(dt)}cameraUpdate(dt,now/1000);updateFlora(now/1000);updateCombatUI(dt);if(mode==='play')updateHUD();
 composer.render();if(raw>.045)slowFrames++;else slowFrames=Math.max(0,slowFrames-1);if(slowFrames>100&&!qualityReduced){qualityReduced=true;renderer.setPixelRatio(1);composer.setPixelRatio(1);bloom.enabled=false}}
window.gameReady=true;$('#start').disabled=false;$('#start').textContent='START RUN';$('#loadNote').textContent='';refreshHelp();syncSettings();start(true);requestAnimationFrame(frame);
