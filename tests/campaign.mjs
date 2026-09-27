import assert from 'node:assert/strict';
import {context,nodes,evaluate as ev} from './harness.mjs';
const t=context.test;
const choose=()=>{ev('showReward()');for(let i=0;i<50&&t.state.mode==='upgrade';i++)nodes.get('#cards').children[0].onclick()};
function world(stage,seed=7361){t.start();ev(`stage=${stage};runSeed=${seed};stageGoal=STAGES[stage-1].goal;setStageDecor();`)}
// Required Quarry cannot be skipped, cannot duplicate, and waits for optional trial resolution.
world(2);ev('stageKills=stageGoal;beginTrial(statueWorld.statues[0]);activatePortal()');assert.equal(ev('quarryState'),'waiting');assert.equal(t.state.portalActive,false);ev('abandonTrial();activatePortal()');
let mini=t.state.enemies.find(e=>e.miniboss);assert.ok(mini);t.activatePortal();assert.equal(t.state.enemies.filter(e=>e.miniboss).length,1);ev('boons.execution=5');const hp=mini.hp;t.hurtEnemy(mini,10);assert.equal(mini.hp,hp-15);ev('boons.execution=0');
t.hurtEnemy(mini,1e6);assert.equal(t.state.portalActive,false);choose();assert.equal(t.state.portalActive,true);assert.equal(ev('build.mods.length'),1);t.activatePortal();assert.equal(ev('rewards.pending'),false);
// Actual cover sweeps cause stagger only during a committed charge.
world(2);t.activatePortal();mini=t.state.enemies.find(e=>e.miniboss);Object.assign(mini,{x:0,z:0,state:'charge',ax:1,az:0,timer:1});ev('stageWorld.covers.push({shape:"box",x:1.5,y:1,z:0,sx:1,sy:4,sz:4})');t.enemyUpdate(mini,.03);assert.equal(mini.state,'stagger');
// All five weapons hit the same encounter-object category; explosion remains covered.
for(let weapon=0;weapon<5;weapon++){world(4);const object=ev("addEncounterObject('anchor',{x:0,z:4},120,'test')");t.equip(weapon);t.setAim(0);t.fire();ev('for(let n=0;n<60;n++)updateShots(1/60)');assert.ok(object.hp<120,'Weapon '+weapon+' must damage anchors');}
world(4);assert.equal(ev('beginTrial(statueWorld.statues[0])'),true);const elite=t.state.enemies.find(e=>e.trialElite);const initial=elite.hp;t.hurtEnemy(elite,100);assert.equal(Math.round(initial-elite.hp),40);ev('hurtEnemy(encounterObjects[0],1000);');const middle=elite.hp;t.hurtEnemy(elite,100);assert.equal(Math.round(middle-elite.hp),60);ev('abandonTrial()');assert.equal(ev('encounterObjects.length'),0);
world(3);ev('beginTrial(statueWorld.statues[0])');assert.equal(ev('vents.length'),3);t.pause();const timer=ev('vents[0].timer');t.update(1);assert.equal(ev('vents[0].timer'),timer);t.pause();ev('abandonTrial()');assert.equal(ev('vents.length'),0);
world(5);t.activatePortal();let boss=t.state.enemies.find(e=>e.kind==='warden');Object.assign(boss,{hp:boss.max*.4,enraged:true,nodeCooldown:0,state:'approach'});t.bossUpdate(boss,.02);assert.equal(ev('encounterObjects.length'),2);ev('for(const o of encounterObjects)hurtEnemy(o,1000)');t.bossUpdate(boss,.02);assert.ok(boss.recovery>0);assert.equal(ev('nodeCharge'),null);assert.equal(t.state.hazards.length,0);
boss.recovery=0;boss.nodeCooldown=0;t.bossUpdate(boss,.02);assert.equal(ev('nodeCharge.nodes.size'),2);t.bossUpdate(boss,7);assert.equal(t.state.hazards.filter(h=>h.kind==='warden-node').length,3);ev('hazards.forEach(h=>effects.remove(h.m));hazards=[]');boss.nodeCooldown=0;t.bossUpdate(boss,.02);t.hurtEnemy(boss,1e6);assert.equal(t.state.victory,true);assert.equal(ev('encounterObjects.length'),0);assert.equal(ev('nodeCharge'),null);
// Reachable encounter placement across five world families and multiple terrain seeds.
for(const seed of [11,7361,91257])for(let stage=1;stage<=5;stage++){
 world(stage,seed);if(stage<5){assert.ok(ev('statueWorld.statues.length'));assert.equal(ev('beginTrial(statueWorld.statues[0])'),true,`Trial placement ${stage}/${seed}`);for(const e of t.state.enemies)assert.ok(ev(`terrain.walkable(${e.x},${e.z},${e.def.radius})`));ev('abandonTrial()')}
}
console.log('PASS campaign: Quarry gate/stagger, five-weapon anchors, progressive shields, vent cleanup, Warden nodes/deadline/victory, 15 seeded worlds.');
