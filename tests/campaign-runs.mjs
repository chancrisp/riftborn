// A bounded synthetic campaign audit, not evidence of human difficulty or fun.
// Run: node tests/campaign-runs.mjs
// Optional: CAMPAIGN_RUNS=normal-rifle CAMPAIGN_LIMIT=480 node tests/campaign-runs.mjs
// Only assistance: starting HP/max HP is 10000. No offensive stats, enemy HP,
// goals, positions, kills, cooldowns, or spawn pacing are edited by this driver.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {context,evaluate as ev,nodes} from './harness.mjs';

const options=[
 {id:'normal-rifle',seed:11,death:false,weapon:0,skip:false},
 {id:'death-stinger',seed:7361,death:true,weapon:1,skip:true},
 {id:'normal-scatter',seed:91257,death:false,weapon:2,skip:true},
 {id:'death-lancer',seed:7129,death:true,weapon:3,skip:false},
 {id:'normal-havoc',seed:44201,death:false,weapon:4,skip:false}
].filter(item=>!process.env.CAMPAIGN_RUNS||process.env.CAMPAIGN_RUNS.split(',').includes(item.id));
assert.ok(options.length,'CAMPAIGN_RUNS must select at least one known run');
const limit=Math.max(30,Math.min(480,Number(process.env.CAMPAIGN_LIMIT)||480));
context.auditLimit=limit;
const scoreCalls=[],mockFetch=context.fetch;
context.fetch=async (url,request)=>{if(url==='/api/scores'&&request?.method==='POST')scoreCalls.push(JSON.parse(request.body));return mockFetch(url,request)};
// Install once in the existing VM. The harness owns all score/profile adapters;
// window.__RIFTBORN_TEST__ stays true and no network/browser is used by this file.
ev(`
window.__RIFTBORN_TEST_SEQUENCES__=true;
const auditOriginalHurt=hurtPlayer;
let auditDamage=0,auditSources={},auditPaths=null,auditGoal=null,auditWaypoint=0,auditStage=0,auditRouteAge=0;
hurtPlayer=function(...args){const before=player.hp;const result=auditOriginalHurt(...args);const damage=Math.max(0,before-player.hp);auditDamage+=damage;if(damage)auditSources[args[1]||'Unknown hazard']=(auditSources[args[1]||'Unknown hazard']||0)+damage;return result};
function auditMove(x,z){
 const n=Math.max(1,Math.hypot(x,z));x/=n;z/=n;
 moveStick.x=Math.cos(cameraYaw)*x-Math.sin(cameraYaw)*z;
 moveStick.y=Math.sin(cameraYaw)*x+Math.cos(cameraYaw)*z;
}
function auditRoute(tx,tz,dt){
 auditRouteAge-=dt;
 if(auditStage!==stage){auditPaths=null;auditStage=stage}
 if(!auditPaths||!auditGoal||Math.hypot(auditGoal.x-tx,auditGoal.z-tz)>3||auditRouteAge<=0){
  auditRouteAge=.7;auditGoal={x:tx,z:tz};
  const nearest=(x,z)=>{let best=Infinity,key=terrain.reachable[0];for(const i of terrain.reachable){const p=terrain.position(i),d=(p.x-x)**2+(p.z-z)**2;if(d<best){best=d;key=i}}return key};
  const origin=nearest(player.x,player.z),goal=nearest(tx,tz),parents=new Map([[origin,-1]]),queue=[origin];
  for(let i=0;i<queue.length&&!parents.has(goal);i++)for(const next of terrain.edges[queue[i]])if(terrain.valid[next]&&!parents.has(next)){parents.set(next,queue[i]);queue.push(next)}
  auditPaths=[];if(parents.has(goal)){let key=goal;while(key!==-1){auditPaths.push(terrain.position(key));key=parents.get(key)}auditPaths.reverse()}
  if(terrain.walkable(tx,tz,.45))auditPaths.push({x:tx,z:tz});auditWaypoint=0;
 }
 while(auditWaypoint<auditPaths.length-1&&Math.hypot(player.x-auditPaths[auditWaypoint].x,player.z-auditPaths[auditWaypoint].z)<.6)auditWaypoint++;
 const p=auditPaths[auditWaypoint]||{x:player.x,z:player.z},distance=Math.hypot(p.x-player.x,p.z-player.z);
 auditMove((p.x-player.x)/Math.max(.55,distance),(p.z-player.z)/Math.max(.55,distance));
}
globalThis.campaignAudit={
 start(config){
  Math.random=randomSource(config.seed);runRandom=Math.random;setDeathMode(config.death);$('#playerName').value='Audit-'+config.id;start();equip(config.weapon);
  player.hp=player.max=10000;auditDamage=0;auditSources={};auditPaths=null;auditGoal=null;auditStage=0;auditRouteAge=0;
  return {seed:runSeed,profile:JSON.stringify(profile),base:{damage:player.damage,rate:player.rate,speed:player.speed}};
 },
 step(dt){
  const from={x:player.x,y:height(player.x,player.z)+1.47,z:player.z};
  let target=null,best=Infinity,visible=false;
  for(const e of combatTargets()){
   if(e.hp<=0)continue;const d=Math.hypot(e.x-player.x,e.z-player.z),bounds=bodyBounds(e,true);
   const to={x:e.x,y:(bounds.bottom+bounds.top)/2,z:e.z};
   const clear=d<WEAPONS[selected].range&&!traceWorld(from,to,shotWorld(),0);
   const rank=d+(clear?0:100)+(e.fixed?-20:0);
   if(rank<best){best=rank;target=e;visible=clear}
  }
  keys={};mouse.moved=false;aimStick.x=aimStick.y=gamepadAim.x=gamepadAim.y=0;
  if(target){const bounds=bodyBounds(target,true);aim=Math.atan2(target.x-player.x,target.z-player.z);aimPitch=pitchTo(from.x,from.y,from.z,target.x,(bounds.bottom+bounds.top)/2,target.z);keys[prefs.bindings.fire]=visible}
  let goal=null;
  if(portalActive)goal=stagePortal.position;
  else{
   // Recover earned shards by walking to them, so upgrades follow real XP.
   let gem=null,gemDistance=Infinity;
   for(const g of gems){const d=Math.hypot(g.x-player.x,g.z-player.z);if(d<gemDistance){gem=g;gemDistance=d}}
   const d=target?Math.hypot(target.x-player.x,target.z-player.z):Infinity;
   if(gem&&gemDistance<12&&(!target||d>3||gemDistance<3))goal=gem;
   else if(target&&(!visible||d>(selected===2?3.5:selected===1?5:7)))goal=target;
   else if(!target&&gem)goal=gem;
  }
  if(goal)auditRoute(goal.x,goal.z,dt);else auditMove(0,0);
  if(target&&player.dashCD<=0&&elapsed>8&&elapsed%8<dt*1.1&&Math.hypot(moveStick.x,moveStick.y)>.1)dash();
  update(dt);if(mode==='play')updateEffects(dt);
 },
 snapshot(){return {mode,stage,stageKills,stageGoal,kills,elapsed,score,victory,hp:player.hp,level:player.level,damage:auditDamage,sources:{...auditSources},weaponDamage:[...runDamage],shots:shots.length,hostiles:liveHostiles(),hazards:hazards.length,particles:particles.length,objects:encounterObjects.length,scars:combatEffects.scars.length,pulls:combatEffects.pulls.length,position:{x:player.x,z:player.z},portalActive,quarryState,build:JSON.parse(JSON.stringify(build)),sequence:cinematic?.kind||null,sequenceAge:cinematic?.age||0,sequencePaused:cinematic?.paused||false,shotCount:shotSerial,pending:rewards.pending,active:!!activeReward,profile:JSON.stringify(profile),boss:enemies.find(e=>e.miniboss||e.kind==='warden')?.hp||null}},
 freeze(){return JSON.stringify({elapsed,spawnTimer,fireTimer,player:[player.x,player.z,player.hp,player.inv,player.dashCD],boons,enemies:enemies.map(e=>[e.hp,e.x,e.z,e.cool]),shots:shots.map(b=>[b.x,b.y,b.z,b.life]),hazards:hazards.map(h=>h.life)})},
 sequence(dt){updateSequence(dt);updateEffects(dt)},
 pause,skip:skipSequence,
 cleanup(){return {cinematic:!!cinematic,pending:rewards.pending,active:!!activeReward,objects:encounterObjects.length,vents:vents.length,mods:build.mods.length,dash:build.dash,damage:runDamage.reduce((a,b)=>a+b,0),curse:difficultyBonus,trial:trial?.state||null}}
};
`);
const driver=context.campaignAudit;
const dt=1/60;
const round=n=>Math.round(n*100)/100;
const headings=card=>card.children.find(child=>child.textContent)?.textContent||'';
function chooseReward(config,report){
 const cards=nodes.get('#cards').children;
 assert.ok(cards.length,'Active draft must provide cards');
 const priorities=[['SPLINTER ROUNDS','STORM NEEDLE','GRAVEBURST','RIFT SCAR','EVENT HORIZON'][config.weapon],'FORKED CHAMBER','HEAVY ROUNDS','OVERCLOCK','DEADEYE','GHOST ROUNDS','GRAVITY WELL','RIFT ECHO','VOID WAKE'];
 const ranked=cards.map(card=>({card,name:headings(card)})).sort((a,b)=>(priorities.indexOf(a.name)<0?100:priorities.indexOf(a.name))-(priorities.indexOf(b.name)<0?100:priorities.indexOf(b.name)));
 report.drafts.push({stage:driver.snapshot().stage,name:ranked[0].name});
 ranked[0].card.onclick();
}

const reports=[];
for(const config of options){
 const initial=driver.start(config),started=performance.now();
 const report={...config,terrainSeed:initial.seed,assistance:'Starting HP/max HP = 10000; all offensive stats and game progression unchanged',stages:[],drafts:[],sequences:[],pauses:0,peak:{shots:0,hostiles:0,hazards:0,particles:0,objects:0,scars:0,pulls:0}};
 assert.deepEqual({...initial.base},{damage:1,rate:1,speed:6.4});
 let state=driver.snapshot(),stageStart=0,stageKills=0,stageDamage=0,lastStage=1,lastSequence=null,wallFrames=0,nextPause=25,sequencePaused=false;
 for(;wallFrames<Math.ceil((limit+45)*60);wallFrames++){
  state=driver.snapshot();
  if(state.mode==='dead'||state.elapsed>=limit)break;
  if(state.stage!==lastStage){
   report.stages.push({stage:lastStage,seconds:round(state.elapsed-stageStart),kills:state.kills-stageKills,damageTaken:round(state.damage-stageDamage),exit:'walked through open portal'});
   console.log(config.id+' reached stage '+state.stage+' at '+round(state.elapsed)+'s');
   assert.equal(state.stage,lastStage+1,'A campaign may advance only one stage at a time');
   lastStage=state.stage;stageStart=state.elapsed;stageKills=state.kills;stageDamage=state.damage;
  }
  for(const key of Object.keys(report.peak))report.peak[key]=Math.max(report.peak[key],state[key]);
  assert.ok(Number.isFinite(state.hp)&&Number.isFinite(state.position.x)&&Number.isFinite(state.position.z));
  assert.ok(state.hostiles<=55&&state.shots<=320,'Entity caps stay bounded');
  if(state.mode==='sequence'){
   if(lastSequence!==state.sequence){report.sequences.push(state.sequence);lastSequence=state.sequence;sequencePaused=false}
   if(!sequencePaused){
    driver.pause();const before=driver.snapshot();driver.sequence(dt);assert.equal(driver.snapshot().sequenceAge,before.sequenceAge,'Sequence pause freezes its clock');driver.pause();sequencePaused=true;
   }
   if(config.skip&&state.sequenceAge>=.3)driver.skip();else driver.sequence(dt);
   continue;
  }
  lastSequence=null;
  if(state.mode==='upgrade'){chooseReward(config,report);continue}
  assert.equal(state.mode,'play');
  if(state.elapsed>=nextPause){
   driver.pause();const before=driver.freeze();for(let n=0;n<30;n++)context.test.update(dt);assert.equal(driver.freeze(),before,'Pause freezes combat, movement and cooldowns');driver.pause();assert.equal(driver.snapshot().mode,'play');report.pauses++;nextPause+=25;
  }
  driver.step(dt);
 }
 state=driver.snapshot();
 assert.equal(state.profile,initial.profile,'Test campaigns cannot persist profile progress');
 report.outcome=state.victory&&state.mode==='dead'?'victory':state.mode==='dead'?'defeat':'simulation-limit';
 report.stages.push({stage:state.stage,seconds:round(state.elapsed-stageStart),kills:state.kills-stageKills,damageTaken:round(state.damage-stageDamage),exit:report.outcome});
 Object.assign(report,{seconds:round(state.elapsed),cpuSeconds:round((performance.now()-started)/1000),kills:state.kills,stage:state.stage,hp:round(state.hp),level:state.level,damageTaken:round(state.damage),damageSources:state.sources,weaponDamage:state.weaponDamage.map(round),shotsFired:state.shotCount,build:state.build,finalBossHP:state.boss,finalPosition:state.position,quarryState:state.quarryState,frames:wallFrames});
 if(report.outcome==='victory'){
  assert.deepEqual(report.stages.map(s=>s.stage),[1,2,3,4,5]);
  assert.ok(report.sequences.includes('maw')&&report.sequences.includes('warden')&&report.sequences.includes('phase')&&report.sequences.includes('victory'));
  assert.ok(state.kills>=182&&state.weaponDamage[config.weapon]>0);
  assert.equal(state.active,false);assert.equal(state.pending,false);
 }
 assert.ok(report.pauses>0,'Each substantial campaign covers pause/resume');
 reports.push(report);console.log(JSON.stringify(report));
 // Finish the harness-only score promise before the next run resets state.
 for(let n=0;n<8&&ev('savingScores');n++)await Promise.resolve();
 assert.equal(ev('savingScores'),false,'Mock score saves must settle');
 if(report.outcome==='victory'){
  const saved=scoreCalls.at(-1);assert.ok(saved,'Victory submits through the test adapter');assert.equal(saved.stage,5);assert.equal(saved.death_mode,config.death);assert.equal(saved.outcome,'victory');assert.equal(saved.kills,report.kills);
 }
}

// A separate reset check intentionally creates a queued, visible reward; it does
// not contribute to any campaign outcome or weapon-damage result above.
driver.start(options[0]);driver.skip();
ev("rewards.add('audit-reset-active','ordinary');rewards.add('audit-reset-pending','major');showReward()");
assert.equal(driver.snapshot().mode,'upgrade');
assert.equal(driver.snapshot().pending,true);
driver.start(options[0]);
const clean=driver.cleanup();
assert.deepEqual({...clean},{cinematic:true,pending:false,active:false,objects:0,vents:0,mods:0,dash:null,damage:0,curse:0,trial:'available'},'Restart clears pending reward and encounter state');
driver.skip();
assert.equal(new Set(scoreCalls.map(run=>run.id)).size,scoreCalls.length,'Completed runs get distinct test score IDs');
const result={kind:'assisted synthetic full-campaign regression',stepHz:60,maxSimulatedSeconds:limit,network:'Harness mock only',limitations:['Large starting health pool; no human difficulty, balance, fun, GPU, or real-device performance claim','Scripted targeting reads enemy positions and terrain routes','No direct enemy damage, enemy stat edits, stage jumps, kill/quota edits, or direct portal activation','Required campaign path only; optional landmarks and Skull Trials are not targeted'],runs:reports,completed:reports.filter(r=>r.outcome==='victory').length,mockedScores:scoreCalls.length,lifecycleReset:'passed'};
fs.mkdirSync(new URL('../.sites-runtime/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('../.sites-runtime/campaign-runs.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log('PASS campaign audit invariants: '+result.completed+'/'+reports.length+' assisted victories; other outcomes retained honestly. Report: .sites-runtime/campaign-runs.json');
