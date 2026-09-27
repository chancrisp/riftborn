import assert from 'node:assert/strict';
import {POWERUPS,DROP_CHANCE,rollPowerup,createBoons,collectBoon,tickBoons,absorbDamage,createStatues} from '../dist/encounters.js';
import {DEFAULT_BINDINGS,loadPreferences} from '../dist/preferences.js';
import {createTerrain} from '../dist/terrain.js';
import {buildStageWorld} from '../dist/scenery.js';

// A new action must not wipe a returning player's customized controls.
const legacy={...DEFAULT_BINDINGS,forward:'KeyF',back:'KeyG',left:'KeyH',right:'KeyV'};
delete legacy.interact;
const migrated=loadPreferences({getItem:()=>JSON.stringify({bindings:legacy})}).bindings;
for(const [action,key] of Object.entries(legacy))assert.equal(migrated[action],key);
assert.equal(new Set(Object.values(migrated)).size,Object.keys(DEFAULT_BINDINGS).length);
assert.equal(loadPreferences(null).bindings.interact,'KeyF');

assert.equal(rollPowerup(()=>DROP_CHANCE),null);
assert.equal(rollPowerup(()=>1),null);
for(const [index,kind] of Object.keys(POWERUPS).entries()){
 let calls=0;assert.equal(rollPowerup(()=>calls++===0?0:(index+.5)/5),kind);
 const boons=createBoons(),player={hp:95,max:100};collectBoon(boons,kind,player);
 if(kind==='heal'){assert.equal(player.hp,100);continue}
 tickBoons(boons,2);collectBoon(boons,kind,player);
 assert.equal(boons[kind],POWERUPS[kind].duration,'Repeat pickup refreshes, never stacks duration');
 tickBoons(boons,20);assert.ok(Object.values(boons).every(v=>v===0),'Every temporary effect expires');
}
const boons=createBoons();collectBoon(boons,'ward',{});
assert.equal(absorbDamage(boons,12),0);assert.equal(boons.shield,18);
assert.equal(absorbDamage(boons,25),7);assert.equal(boons.ward,0);

// Statues must remain approachable without closing the routes to a stage's portal.
let statueCount=0;
for(let seed=1;seed<=3;seed++)for(let stage=1;stage<=5;stage++){
 const terrain=createTerrain(stage,seed*7919),world=buildStageWorld(terrain),statues=createStatues(terrain,world,seed*7919+stage*107);
 assert.ok(statues.statues.length>0&&statues.statues.length<=4);
 for(const statue of statues.statues){
  const p={x:0,z:0};
  for(let frame=0;frame<2400&&Math.hypot(p.x-statue.x,p.z-statue.z)>=3;frame++){
   const v=terrain.steer(p.x,p.z,statue.x,statue.z,p);terrain.move(p,v.x*.12,v.z*.12,.45);
  }
  assert.equal(statues.nearby(p),statue,`Statue must be reachable: ${stage}/${seed}`);
  assert.equal(statues.activate(statue),true);assert.equal(statues.activate(statue),false);statueCount++;
 }
 const [x,z]=terrain.points[0],p={x:0,z:0};
 for(let frame=0;frame<2400&&Math.hypot(p.x-x,p.z-z)>.4;frame++){
  const v=terrain.steer(p.x,p.z,x,z,p);terrain.move(p,v.x*.12,v.z*.12,.45);
 }
 assert.ok(Math.hypot(p.x-x,p.z-z)<.5,`Statues cannot block the portal: ${stage}/${seed}`);
 statues.dispose();world.dispose();
}
console.log(`PASS: saved Interact migration, drop odds, pickup refresh/expiry, healing cap, shield absorption, ${statueCount} approachable single-use statues and 15 portal routes.`);
