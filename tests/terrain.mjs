import assert from 'node:assert/strict';
import * as T from 'three';
import {createTerrain,randomSource} from '../dist/terrain.js';
import {buildStageWorld} from '../dist/scenery.js';
let stages=0,spawns=0,routed=0,maxBuild=0,maxCalls=0;const summaries=[];
for(let seed=1;seed<=20;seed++){
 let previous=null;
 for(let stage=1;stage<=5;stage++){
  const started=performance.now(),t=createTerrain(stage,seed*7919),world=buildStageWorld(t);maxBuild=Math.max(maxBuild,performance.now()-started);maxCalls=Math.max(maxCalls,world.drawCalls);
  assert.ok(t.reachable.length>400,'Enough connected combat space');
  assert.ok(t.walkable(0,0,1.45),'Safe entry');
  const heights=[...t.heights];assert.ok(Math.max(...heights)-Math.min(...heights)>8,'Meaningful elevation');
  if(previous){let delta=0;for(let i=0;i<heights.length;i++)delta+=Math.abs(heights[i]-previous[i]);assert.ok(delta/heights.length>2,'Adjacent stages must differ geometrically')}
  previous=heights;
  // Every landmark and the portal can be reached by walking the real collision surface.
  for(const point of t.points){const p={x:0,z:0};for(let frame=0;frame<2400&&Math.hypot(point[0]-p.x,point[1]-p.z)>.3;frame++){const v=t.steer(p.x,p.z,point[0],point[1],p);t.move(p,v.x*.12,v.z*.12,.45)}assert.ok(Math.hypot(point[0]-p.x,point[1]-p.z)<.4,`Route blocked: ${stage}/${seed}/${point}`)}
  const random=randomSource(seed);
  for(let n=0;n<30;n++){const target=n%2?{x:0,z:0}:{x:t.points[0][0],z:t.points[0][1]},p=t.spawn(target.x,target.z,1.35,random);assert.ok(t.walkable(p.x,p.z,1.35));assert.ok(Math.hypot(p.x-target.x,p.z-target.z)>=12);spawns++;
   if(n<4){for(let frame=0;frame<2400&&Math.hypot(p.x-target.x,p.z-target.z)>1.5;frame++){const v=t.steer(p.x,p.z,target.x,target.z,p);t.move(p,v.x*.12,v.z*.12,1.35)}assert.ok(Math.hypot(p.x-target.x,p.z-target.z)<1.6,`Enemy route stuck: ${stage}/${seed} at ${JSON.stringify(p)} to ${JSON.stringify(target)}`);routed++}
  }
  // Swept dash/charge collision must not tunnel through a solid wall.
  t.obstacles.push({x:0,z:3,sx:8,sz:1});const p={x:0,z:0};t.move(p,0,15,.45);assert.ok(p.z<2.1,'Dash tunneled through structure');t.obstacles.pop();
  // Rendered triangles and collision queries must agree between vertices.
  world.group.updateMatrixWorld(true);const ray=new T.Raycaster();for(let i=0;i<20;i++){const x=random(-60,60),z=random(-60,60);ray.set(new T.Vector3(x,100,z),new T.Vector3(0,-1,0));const hit=ray.intersectObject(world.surface)[0];assert.ok(hit);assert.ok(Math.abs(hit.point.y-t.height(x,z))<.00001,'Surface/collision mismatch')}
  if(seed===1)summaries.push({stage,connectedCells:t.reachable.length,obstacles:t.obstacles.length,elevationRange:+(Math.max(...heights)-Math.min(...heights)).toFixed(1),staticDrawCalls:world.drawCalls});
  world.dispose();stages++;
 }
}
console.log(JSON.stringify({stages,spawns,routed,maxBuildMs:Math.round(maxBuild),maxStaticDrawCalls:maxCalls,summaries},null,2));
console.log('PASS: 100 generated stages, all landmark/portal paths, safe spawns, routed large enemies, dash walls, exact rendered surface heights and distinct geography.');
