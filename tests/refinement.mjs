import assert from 'node:assert/strict';
import {shotStats,applyUpgrade,upgradePreview} from '../dist/upgrades.js';
import {WEAPONS} from '../dist/rules.js';
const base={rate:1,damage:1,extra:0,pierce:0,crit:.85,max:100,hp:91,magnet:4,speed:5,regen:0};
for(const w of WEAPONS){const p={...base};const before=shotStats(p,w,{rapid:2});applyUpgrade(p,0);assert.ok(Math.abs(shotStats(p,w,{rapid:2}).interval-before.interval/1.18)<1e-12);assert.match(upgradePreview(base,0,w,{rapid:2}),/s →/)}
assert.match(upgradePreview(base,7,WEAPONS[0]),/85% → 90%/);assert.match(upgradePreview(base,5,WEAPONS[4]),/Havoc unchanged/);
const copy={...base};upgradePreview(base,3,WEAPONS[0]);assert.deepEqual(base,copy);applyUpgrade(copy,3);assert.equal(copy.hp,120);assert.equal(copy.max,120);
console.log('PASS refinement stats: shared cadence, caps, applicability, healing and non-mutating comparisons.');

const {BuildFeedback}=await import('../dist/combat-feedback.js');
const {dangerMarker,disposeMarker}=await import('../dist/warnings.js');
const feedback=new BuildFeedback();assert.equal(feedback.emit('splinter'),true);assert.equal(feedback.emit('splinter'),false);feedback.tick(.5);assert.equal(feedback.text,'SPLINTER · SPLIT');feedback.clear();assert.equal(feedback.text,'');
const marker=dangerMarker((x,z)=>x*.2+z*.1,4,3,4.2,'mortar');const positions=marker.geometry.attributes.position;
for(let i=0;i<positions.count;i++)assert.ok(Math.abs(positions.getY(i)-positions.getX(i)*.2-positions.getZ(i)*.1-.13)<1e-5);
assert.equal(marker.material.depthTest,false);assert.equal(marker.material.fog,false);disposeMarker(marker);
const {evaluate}=await import('./harness.mjs');
assert.equal(evaluate(`start();runDeath=true;runTuning=RUN_MODES.death;difficultyBonus=50;const testCharger=spawnEnemy('charger',{x:0,z:0});player.x=0;player.z=10;testCharger.cool=-1;enemyUpdate(testCharger,1/60);!!testCharger.warning.userData.path`),true);
console.log('PASS refinement: terrain-conforming warnings and bounded build feedback.');

// Warnings retain fixed extent, disappear on cancellation, and follow scaled movement.
for(const death of [false,true])for(const curse of [0,10,50,100]){
 const result=evaluate(`(()=>{start();runTuning=RUN_MODES.${death?'death':'normal'};difficultyBonus=${curse};const e=spawnEnemy('charger',{x:0,z:0});e.ax=0;e.az=1;warnLine(e,12,'#fff');const p=e.warning.userData.path.at(-1);e.state='charge';e.timer=.68;player.inv=100;for(let n=0;n<41;n++)enemyUpdate(e,1/60);return {error:Math.hypot(p[0]-e.x,p[1]-e.z),cleared:!e.warning}})()`);
 assert.ok(result.error<.25);assert.equal(result.cleared,true);
}
assert.equal(evaluate(`(()=>{const e=spawnEnemy('sniper');e.ax=1;e.az=0;warnLine(e,42,'#fff');removeEnemy(e);return e.warning===null})()`),true);
assert.equal(evaluate(`(()=>{hazard(0,0,4.2,1,2,'slam');const m=hazards.at(-1).m;player.inv=100;update(1/60);return m.scale.x===1&&m.userData.radius===4.2})()`),true);
// Mod cues come from successful projectiles rather than merely attempted triggers.
assert.equal(evaluate(`(()=>{start();build.mods=[0];const e=spawnEnemy('brute',{x:0,z:4});equip(0);fire();for(let n=0;n<20;n++)updateShots(1/60);return buildFeedback.serial>0})()`),true);
evaluate(`start();build.dash='echo';dash();`);assert.equal(evaluate('buildFeedback.text'),'RIFT ECHO · READY');evaluate('dashEffects.tick(3)');assert.equal(evaluate('buildFeedback.text'),'RIFT ECHO · EXPIRED');evaluate('start()');assert.equal(evaluate('buildFeedback.text'),'');
console.log('PASS integrated feedback: scaled charge paths, cancellation, fixed blast radius, actual split/Echo events and restart.');

assert.equal(evaluate(`(()=>{start();const e=spawnEnemy('gunner',{x:0,z:7});e.cool=-1;enemyUpdate(e,1/60);return shots.length})()`),0,'Ready ranged enemies must still anticipate when first entering range');

assert.equal(evaluate(`(()=>{const e=enemies[0];for(let n=0;n<16;n++)enemyUpdate(e,1/60);return shots.length})()`),3,'Anticipation releases the same three-shot fan');

assert.match(upgradePreview(base,0,WEAPONS[1]),/0.075s → 0.0636s/);
