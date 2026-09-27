import assert from 'node:assert/strict';
import {SimulationClock,PadMenu} from '../dist/simulation.js';
import {context,nodes,evaluate} from './harness.mjs';
const t=context.test;
// Reproduce the real selection path, including calls used by mouse, bindings and bumpers.
for(const weapon of [3,4])for(const rate of [1,1.18*1.18]){
 t.start();t.equip(weapon);evaluate(`player.rate=${rate};boons.rapid=8;keys={Mouse0:true}`);t.update(1/60);
 const recovery=evaluate('fireTimer');
 for(let i=0;i<20;i++)t.equip(i%2?weapon:0);
 assert.equal(evaluate('fireTimer'),recovery,'Weapon selection must preserve the recovery of the last shot');
 t.equip(weapon);assert.equal(evaluate('fireTimer'),recovery,'Same-slot selection cannot shorten recovery');
}
// One crit roll for the entire blast, with actual damage capped by remaining HP.
t.start();evaluate('player.crit=1;');
const a=t.spawnEnemy('brute',{x:0,z:4}),b=t.spawnEnemy('brute',{x:1,z:4});
a.hp=b.hp=1000;a.max=b.max=1000;
evaluate('explode(0,4,4,72,false,2,{sourceWeapon:4,shotId:1,generation:0})');
assert.equal(a.hp,856,'Havoc explosions receive Deadeye criticals');assert.equal(b.hp,856);
console.log('PASS foundation: selection recovery and explosion criticals.');
for(const fps of [10,15,24,30,60,120,144]){const c=new SimulationClock();let seconds=0;for(let i=0;i<fps*10;i++)c.advance(1/fps,true,dt=>{seconds+=dt});assert.ok(Math.abs(seconds-10)<1e-8,`${fps} Hz keeps simulation time`);c.advance(30,true,()=>assert.fail('Long stall must discard catch-up'));c.advance(.1,false,()=>assert.fail('Pause must freeze'));}
const menu=new PadMenu(),pad={axes:[0,1],buttons:[]};assert.equal(menu.directionAt(pad,0),1);assert.equal(menu.directionAt(pad,.1),0);assert.equal(menu.directionAt(pad,.36),1);
assert.equal(typeof nodes.get('#nameKeyboard')?.children[0]?.onclick,'function','Controller username keyboard must be usable');
t.start();assert.equal(evaluate('beginTrial(statueWorld.statues[0])'),true);assert.equal(evaluate('difficultyBonus'),5);assert.equal(evaluate('trial.roster.size'),4);
const roster=t.state.enemies.filter(e=>e.trialId);for(const e of roster)t.hurtEnemy(e,1e6);assert.equal(evaluate('trial.state'),'completed');assert.equal(evaluate('trialCount'),1);
t.hurtEnemy(roster[0],1e6);assert.equal(evaluate('trialCount'),1);evaluate('showReward()');assert.equal(t.state.mode,'upgrade');nodes.get('#cards').children.at(-1).onclick();assert.equal(evaluate('trial.state'),'claimed');assert.equal(t.state.mode,'play');
t.start();evaluate('beginTrial(statueWorld.statues[0]);abandonTrial()');assert.equal(evaluate('trial.state'),'abandoned');assert.equal(evaluate('trialCount'),0);assert.equal(evaluate('difficultyBonus'),5);
console.log('PASS integrated trials: real terrain placement, marked kills, one reward, curse retained on abandonment.');
t.equip(4);const oldModel=t.hero.weapon;t.start();assert.ok(t.hero.weapon!==oldModel,'Restart refreshes the actual Rifle model');
t.start();const accounting=t.spawnEnemy('runner',{x:0,z:4});accounting.hp=17;evSafe();
function evSafe(){evaluate('player.crit=0;');t.hurtEnemy(accounting,1000,false,{sourceWeapon:3,generation:1});t.hurtEnemy(accounting,1000,false,{sourceWeapon:3});assert.equal(evaluate('runDamage[3]'),17,'Damage counts health removed once, including secondary attribution');}
evaluate("player.hp=1;player.inv=0;hurtPlayer(99,'sniper')");assert.equal(evaluate('lastSummary.cause'),'Sniper');assert.equal(evaluate('lastSummary.damage[3]'),17);t.start();assert.equal(evaluate('runDamage[3]'),0);
evaluate("profile.lastUsername='Remembered'");t.openPanel('#runSetup');assert.equal(nodes.get('#playerName').value,'Remembered');t.closePanel();
assert.equal(evaluate('profile.milestones.length'),0,'Harness runs cannot grant real profile milestones');
console.log('PASS feedback: overkill clamp, secondary attribution, lethal source, retry reset and remembered editable username.');
t.start();evaluate("build.mods=[0,1,2,3,4];rewards.add('exhausted-trial','trial');showReward()");assert.equal(nodes.get('#cards').children.length,2);assert.match(nodes.get('#cards').children[0].children[0].textContent,/ALL MODS OWNED/);nodes.get('#cards').children[0].onclick();assert.equal(nodes.get('#choiceTitle').textContent,'CHOOSE AN UPGRADE');
t.start();t.spawnEnemy('runner',{x:0,z:6});const spitter=t.spawnEnemy('gunner',{x:0,z:6});spitter.cool=-1;t.enemyUpdate(spitter,1/60);assert.ok(t.state.shots.every(b=>b.source==='gunner'),'Co-located enemies keep the actual firing source');
t.start();evaluate("trial=new SkullTrial(1);trial.activate(['fake'],()=>{});addVent({x:0,z:0});vents[0].phase='active';vents[0].timer=1;stageWorld.covers.push({shape:'box',x:0,y:1,z:1,sx:5,sy:4,sz:.5});player.x=0;player.z=2;player.hp=100;player.inv=0");const sheltered=t.spawnEnemy('brute',{x:0,z:2});sheltered.x=0;sheltered.z=2;sheltered.c.g.position.set(0,t.height(0,2),2);sheltered.hp=1000;evaluate('updateVents(.01)');assert.equal(sheltered.hp,1000,'Vent cover protects enemies as well as player');assert.equal(t.state.player.hp,100);
