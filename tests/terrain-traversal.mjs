import assert from 'node:assert/strict';
import {createTerrain,randomSource} from '../dist/terrain.js';
import {buildStageWorld} from '../dist/scenery.js';

// Every portal has an authored direct spoke. The Citadel's old 5-to-8-unit
// clearing blend made a steep shoulder that only a navigation detour could pass.
for(const seed of [7919,15838,23757,31676,39595,47514])for(let stage=1;stage<=5;stage++){
 const terrain=createTerrain(stage,seed),player={x:0,z:0},[x,z]=terrain.points[0];
 for(let frame=0;frame<1000&&Math.hypot(player.x-x,player.z-z)>2.8;frame++){
  const dx=x-player.x,dz=z-player.z,distance=Math.hypot(dx,dz);
  terrain.move(player,dx/distance*.12,dz/distance*.12,.45);
 }
 assert.ok(Math.hypot(player.x-x,player.z-z)<3,`Reserved direct portal approach must stay traversable: ${stage}/${seed}`);
}

// A clear endpoint is insufficient: navigation and reverse-path checks must use
// the same swept solid footprints as short walking/dash collision steps.
{
 const terrain=createTerrain(1,1);terrain.obstacles.push({x:0,z:0,sx:.1,sz:2});
 assert.equal(terrain.canMove(-1,0,1,0,.45),false,'Movement queries cannot skip a solid between clear endpoints');
}

// Navigation's rounding margin must never become a global player-radius increase.
{
 const terrain=createTerrain(1,1),player={x:0,z:-4};
 terrain.obstacles.push({x:-1,z:0,sx:1,sz:6},{x:1,z:0,sx:1,sz:6});
 terrain.move(player,0,8,.45);
 assert.ok(Math.abs(player.z-4)<1e-6,'A player can still walk through a valid one-unit gap');
 assert.equal(player.x,0);
}

// The old 1.5-unit cardinal samples averaged over this steep crease and accepted
// it even though none of the eight camera-relative keyboard inputs could move.
{
 const terrain=createTerrain(4,7919),world=buildStageWorld(terrain);
 assert.equal(terrain.walkable(-27.94,-38.62,.45),false,'A steep crease with no keyboard exit cannot be advertised as walkable');
 world.dispose();
}

// Test fixture: a level shelf adjoining a steep face. A player fits on the shelf
// right up to its edge; a distant 1.5-unit height probe must not block that floor.
{
 const terrain=createTerrain(1,1);
 for(let z=0;z<=152;z++)for(let x=0;x<=152;x++)terrain.heights[z*153+x]=x<=76?0:(x-76)*3;
 assert.equal(terrain.walkable(-.7,0,.45),true,'Flat ground before a cliff remains traversable');
 const player={x:-2,z:0};terrain.move(player,1.3,0,.45);
 assert.ok(Math.abs(player.x+.7)<1e-6,'Walking can reach visible level ground beside a cliff');
 terrain.move(player,4,0,.45);assert.ok(player.x<.001,'A dash cannot enter the steep face');
 terrain.move(player,-4,0,.45);assert.ok(player.x<-3.7,'A blocked dash always has a reverse walking exit');
}

// A steep diagonal wall has a legal tangent even when neither world-axis slide
// advances; holding into it must glide along the visible boundary, not snag.
{
 const terrain=createTerrain(1,2);
 for(let z=0;z<=152;z++)for(let x=0;x<=152;x++)terrain.heights[z*153+x]=Math.max(0,x+z-152)*3;
 const player={x:-.2,z:-.2};
 for(let frame=0;frame<90;frame++)terrain.move(player,.12,0,.45);
 assert.ok(player.x>3&&player.z<-3,'Movement projects along a diagonal cliff boundary');
 assert.equal(terrain.walkable(player.x,player.z,.45),true);
}

// Random roaming leaves the broad reserved paths and hits slopes, obstacle edges
// and terrace lips. Every accepted straight leg must be reversible at walking speed,
// and each final location must retain at least one usable keyboard escape.
let walks=0,reversals=0,offRoute=0;
for(const seed of [7919,15838,23757])for(let stage=1;stage<=5;stage++){
 const terrain=createTerrain(stage,seed),world=buildStageWorld(terrain),random=randomSource(seed+stage*991);
 for(let route=0;route<24;route++){
  const player=terrain.position(terrain.reachable[Math.floor(random()*terrain.reachable.length)]);
  for(let leg=0;leg<24;leg++){
   const angle=random(0,Math.PI*2),stride=leg%6===0?1.6:.12;
   for(let step=0;step<8;step++){
    const before={...player};terrain.move(player,Math.sin(angle)*stride,Math.cos(angle)*stride,.45);
    assert.ok(Math.hypot(player.x-before.x,player.z-before.z)<=stride+.000001,'Collision recovery cannot teleport or add movement speed');
    if(terrain.routeAt(player.x,player.z).distance>5)offRoute++;
    assert.equal(terrain.walkable(player.x,player.z,.45),true,`Roaming cannot enter an invalid face: ${stage}/${seed}`);
    const back={...player},distance=Math.hypot(before.x-back.x,before.z-back.z);
    // A slide can curve around cover, so its endpoints need not have a clear chord.
    // For straight accepted legs, replay the actual path using smaller steps.
    if(distance>.001&&terrain.canMove(before.x,before.z,player.x,player.z,.45)){
     for(let n=0;n<60&&Math.hypot(before.x-back.x,before.z-back.z)>.005;n++){
      const dx=before.x-back.x,dz=before.z-back.z,d=Math.hypot(dx,dz),scale=Math.min(1,.08/d);
      terrain.move(back,dx*scale,dz*scale,.45);
     }
     assert.ok(Math.hypot(before.x-back.x,before.z-back.z)<.01,`An accepted move must be reversible by ordinary walking: ${stage}/${seed}, ${JSON.stringify({before,player,back})}`);reversals++;
    }
    walks++;
   }
   const exits=Array.from({length:8},(_,index)=>{
    const a=index*Math.PI/4+.35,escape={...player};terrain.move(escape,Math.sin(a)*.1066667,Math.cos(a)*.1066667,.45);
    return Math.hypot(escape.x-player.x,escape.z-player.z);
   });
   assert.ok(Math.max(...exits)>.02,`Roaming must retain a keyboard escape: ${stage}/${seed} at ${JSON.stringify(player)}`);
  }
 }
 world.dispose();
}
assert.ok(offRoute>10000,'The roaming regression must meaningfully exercise terrain outside the reserved paths');
console.log(`PASS: steep-face rejection, usable cliff-side ground, tangent sliding; ${walks} seeded walking/dash steps, ${reversals} walking reversals, ${offRoute} off-route samples with keyboard escapes.`);
