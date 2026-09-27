import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {SimulationClock} from '../dist/simulation.js';
import {context,nodes,evaluate as ev} from './harness.mjs';
const t=context.test, timings=[], peak={shots:0,scars:0,pulls:0,wake:0,particles:0};
// Bounded CPU simulation, not a GPU benchmark or an unassisted balance test.
// Exercise every stage with all mods and stacked ordinary upgrades; choose drafts
// immediately so this measures combat rather than time spent in a modal.
for(const seed of [11,7361,91257])for(let stage=1;stage<=5;stage++){
 t.start();ev(`runRandom=randomSource(${seed});runSeed=${seed};stage=${stage};setStageDecor();stageGoal=100000;build.mods=[0,1,2,3,4];build.dash='${stage%2?'echo':'wake'}';player.extra=4;player.pierce=4;player.damage=3;player.rate=2;player.crit=.6;player.max=player.hp=100000;`);
 for(let n=0;n<18;n++)t.spawnEnemy(n%3?'runner':'brute');
 const clock=new SimulationClock();let sim=0;const began=performance.now();
 for(let frame=0;frame<600;frame++){
  const fps=[10,15,30,60,144][Math.floor(frame/120)];
  clock.advance(1/fps,true,dt=>{
   if(t.state.mode==='upgrade'){nodes.get('#cards').children[0].onclick();return false}
   if(Math.floor(sim)!==Math.floor(sim+dt))t.equip(Math.floor(sim)%5);
   const target=t.state.enemies.find(e=>e.hp>0);if(target)t.setAim(Math.atan2(target.x-t.state.player.x,target.z-t.state.player.z));
   t.setKeys({Mouse0:true,KeyW:Math.floor(sim)%4===0,KeyD:Math.floor(sim)%4===1});
   if(t.state.player.dashCD<=0)t.dash();
   t.update(dt);t.updateEffects(dt);sim+=dt;
   const counts=ev('({shots:shots.length,scars:combatEffects.scars.length,pulls:combatEffects.pulls.length,wake:dashEffects.wake.length,particles:particles.length})');
   for(const k in peak)peak[k]=Math.max(peak[k],counts[k]);
   assert.ok(counts.shots<=320&&counts.scars<=12&&counts.pulls<=8&&counts.wake<=24&&counts.particles<=361,'Effects stay bounded');
   assert.ok(Number.isFinite(t.state.player.hp+t.state.player.x+t.state.player.z));
   assert.equal(t.state.mode==='dead',false);
  });
 }
 timings.push(performance.now()-began);
 t.start();assert.equal(ev('combatEffects.scars.length+combatEffects.pulls.length+dashEffects.wake.length'),0);
}
// Abandonment cancels pending owned attacks, not just the marked creatures.
t.start();ev("beginTrial(statueWorld.statues[0]);hazard(0,0,2,20,1,'trial-slam',trial.id)");
const attacker=t.state.enemies[0];attacker.kind='gunner';attacker.cool=-1;attacker.x=0;attacker.z=6;for(let n=0;n<17;n++)t.enemyUpdate(attacker,1/60);
assert.ok(t.state.hazards.length);assert.ok(t.state.shots.some(b=>b.emitter===attacker));ev('abandonTrial()');
assert.equal(t.state.hazards.length,0);assert.equal(t.state.shots.filter(b=>b.emitter===attacker).length,0);
timings.sort((a,b)=>a-b);
console.log('PASS stress: 15 heavily upgraded seeded worlds, mixed 10–144 Hz input cadence, caps/reset/owned-attack cleanup.');
console.log(JSON.stringify({cpuCombatMsMedian:Math.round(timings[7]),cpuCombatMsMax:Math.round(timings.at(-1)),peak,rendering:'mocked; not a browser FPS measurement'}));
