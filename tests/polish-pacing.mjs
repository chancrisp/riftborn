import fs from 'node:fs';
import assert from 'node:assert/strict';
import {context,nodes,evaluate as ev} from './harness.mjs';
const t=context.test,metrics=[];
ev('let measuredDamage=0;const measuredHurtPlayer=hurtPlayer;hurtPlayer=(...args)=>{const before=player.hp;measuredHurtPlayer(...args);measuredDamage+=Math.max(0,before-player.hp)}');
// Assisted 20s samples: durable high HP, aimed/manual fire, fixed strafe route.
// This measures attack overlap and outcomes, not human difficulty or fun.
for(const seed of [11,7361,91257])for(const death of [false,true])for(const stage of [2,3,4,5]){
 t.setMode('menu');ev(`setDeathMode(${death});start();measuredDamage=0;runRandom=randomSource(${seed});runSeed=${seed};stage=${stage};setStageDecor();difficultyBonus=50;stageGoal=100000;player.max=player.hp=100000;build.mods=[0,1,2,3,4];player.damage=2;player.rate=1.5;player.extra=2;player.pierce=2;build.dash='wake';`);
 if(stage===2)ev('startQuarry()');else if(stage===5)ev('summonBoss();{const b=enemies[0];b.hp=b.max*.4;b.enraged=true;b.nodeCooldown=0}');else ev('beginTrial(statueWorld.statues[0]);player.x=trial.statue.x+3;player.z=trial.statue.z');
 let peakEnemies=0,peakHazards=0,finished=null;
 for(let n=0;n<1200;n++){
  if(t.state.mode==='upgrade'){nodes.get('#cards').children[0].onclick();continue}
  if(t.state.mode!=='play')break;
  if(n%180===0)t.equip(Math.floor(n/180)%5);
  const target=t.state.enemies.filter(e=>e.hp>0).sort((a,b)=>Math.hypot(a.x-t.state.player.x,a.z-t.state.player.z)-Math.hypot(b.x-t.state.player.x,b.z-t.state.player.z))[0];if(target)t.setAim(Math.atan2(target.x-t.state.player.x,target.z-t.state.player.z));
  t.setKeys({Mouse0:true,KeyW:n%480<120,KeyD:n%480>=120&&n%480<240,KeyS:n%480>=240&&n%480<360,KeyA:n%480>=360});t.update(1/60);t.updateEffects(1/60);
  peakEnemies=Math.max(peakEnemies,t.state.enemies.length);peakHazards=Math.max(peakHazards,t.state.hazards.length);
  if(finished===null&&ev("trial?.state==='complete'||quarryState==='rewarded'||victory"))finished=+(n/60).toFixed(1);
 }
 assert.ok(peakEnemies<=55);assert.ok(Number.isFinite(t.state.player.hp));metrics.push({seed,mode:death?'death':'normal',stage,curse:50,damage:Math.round(ev('measuredDamage')),peakEnemies,peakHazards,finished});
}
// Identical vent phases begin with an immediate pulse, independent of previous cycles.
t.start();ev('stage=3;setStageDecor();beginTrial(statueWorld.statues[0]);');
const starts=[];for(let n=0;n<1200;n++){const old=ev('vents[0].phase');ev('updateVents(1/60)');if(old==='warning'&&ev('vents[0].phase')==='active')starts.push(ev('vents[0].tick'))}assert.ok(starts.length>=3);assert.ok(starts.every(v=>v===.5));
console.log('PASS pacing: 24 assisted cursed encounters, both modes, three seeds, finite state/spawn bounds and stable vent onset.');console.log(JSON.stringify(metrics));fs.mkdirSync('.sites-runtime',{recursive:true});fs.writeFileSync('.sites-runtime/refinement-pacing.json',JSON.stringify(metrics,null,2));
