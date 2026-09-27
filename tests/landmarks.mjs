import assert from 'node:assert/strict';
import * as T from 'three';
import {createTerrain} from '../dist/terrain.js';
import {buildStageWorld} from '../dist/scenery.js';
import {createStatues} from '../dist/encounters.js';
import {traceWorld} from '../dist/ballistics.js';

const landmarkModule=await import('../dist/landmarks.js').catch(error=>{
 if(error.code==='ERR_MODULE_NOT_FOUND')return {};
 throw error;
});
assert.equal(typeof landmarkModule.createLandmark,'function','The campaign needs a discoverable landmark factory');
const {createLandmark,LANDMARKS}=landmarkModule;

function walkTo(terrain,target,radius=.45,stop=.25){
 const player={x:0,z:0};
 for(let frame=0;frame<2800&&Math.hypot(player.x-target.x,player.z-target.z)>stop;frame++){
  const step=terrain.steer(player.x,player.z,target.x,target.z,player);
  terrain.move(player,step.x*.12,step.z*.12,radius);
 }
 return player;
}

// A blocked inspection point or new structure across an authored lane makes a discovery impossible.
// Exercise the same scenery -> landmark -> statue order used by the real stage transition.
const ids=new Map();let count=0,maxMeshes=0;
for(const seed of [7919,15838,23757])for(let stage=1;stage<=5;stage++){
 const terrain=createTerrain(stage,seed),world=buildStageWorld(terrain);
 const originalObstacles=[...terrain.obstacles],originalCovers=[...world.covers];
 const sharedResources=new Set();world.group.traverse(object=>{if(object.geometry)sharedResources.add(object.geometry);if(object.material)for(const material of [object.material].flat())sharedResources.add(material)});
 let sharedDisposals=0;for(const resource of sharedResources)resource.addEventListener('dispose',()=>sharedDisposals++);
 const landmark=createLandmark(terrain,world);
 assert.ok(landmark,`One discovery must be placed in stage ${stage}, seed ${seed}`);
 const scene=new T.Group();scene.add(landmark.group);
 const statues=createStatues(terrain,world,seed+stage*107);
 assert.ok(statues.statues.length>0,'A landmark must leave room for the existing statue encounters');
 if(ids.has(stage))assert.equal(landmark.id,ids.get(stage),'Discovery identity must survive a terrain seed change');else ids.set(stage,landmark.id);
 assert.equal(LANDMARKS.find(item=>item.stage===stage)?.id,landmark.id);
 assert.ok(landmark.name.length>5&&landmark.text.length>40,'An authored discovery has a name and useful lore');
 assert.ok(Math.hypot(landmark.x,landmark.z)>16&&Math.hypot(landmark.x,landmark.z)<57,'Discoveries belong outside the entry clearing and inside the arena');
 assert.ok(Math.hypot(landmark.x-terrain.points[0][0],landmark.z-terrain.points[0][1])>12,'The portal clearing must stay free');
 assert.ok(terrain.routeAt(landmark.x,landmark.z).distance>6,'Required lanes must stay free');
 assert.equal(landmark.nearby({x:0,z:0}),false);
 const player=walkTo(terrain,landmark.approach);
 assert.ok(Math.hypot(player.x-landmark.approach.x,player.z-landmark.approach.z)<.3,`Reachable inspection approach: ${stage}/${seed}`);
 assert.equal(landmark.nearby(player),true);
 assert.equal(landmark.claimed,false);assert.equal(landmark.claim(),true);assert.equal(landmark.claimed,true);assert.equal(landmark.claim(),false,'Repeated inspection cannot give a second reward');
 assert.equal(landmark.nearby(player),true,'Previously claimed lore remains inspectable');
 assert.equal(landmark.heal,12);assert.equal(landmark.rest,4);
 for(const [x,z] of terrain.points){
  const end=walkTo(terrain,{x,z},1.45,.4);
  assert.ok(Math.hypot(end.x-x,end.z-z)<.5,`Required navigation point remains reachable by a large body: ${stage}/${seed} ${x},${z}`);
 }
 for(const statue of statues.statues){
  const end=walkTo(terrain,statue,.45,3);
  assert.equal(statues.nearby(end),statue,`Statues remain approachable: ${stage}/${seed}`);
 }
 const ownObstacles=terrain.obstacles.filter(item=>!originalObstacles.includes(item)&&!statues.statues.some(statue=>statue.x===item.x&&statue.z===item.z));
 const ownCovers=world.covers.filter(item=>!originalCovers.includes(item)&&!statues.statues.some(statue=>statue.x===item.x&&statue.z===item.z));
 const ownedResources=new Set();let meshes=0;
 landmark.group.updateMatrixWorld(true);
 const foundation=new T.Box3().setFromObject(landmark.group.children[0]);
 for(const x of [foundation.min.x,foundation.max.x])for(const z of [foundation.min.z,foundation.max.z]){
  assert.ok(foundation.min.y<=terrain.height(x,z),'The solid foundation must meet the hillside rather than float above it');
 }
 landmark.group.traverse(object=>{
  if(!object.isMesh)return;meshes++;ownedResources.add(object.geometry);ownedResources.add(object.material);
  assert.equal(object.material.emissiveIntensity,0,'The discovery uses textured, unlit-by-emission PS1 scenery');
  const box=new T.Box3().setFromObject(object),center=box.getCenter(new T.Vector3()),size=box.getSize(new T.Vector3());
  assert.ok([center.x,center.y,center.z,size.x,size.y,size.z].every(Number.isFinite));
  const cover=ownCovers.find(item=>Math.abs(item.x-center.x)<1e-6&&Math.abs(item.y-center.y)<1e-6&&Math.abs(item.z-center.z)<1e-6&&Math.abs(item.sx-size.x)<1e-6&&Math.abs(item.sy-size.y)<1e-6&&Math.abs(item.sz-size.z)<1e-6);
  assert.ok(cover,'Every rendered solid must have matching projectile cover');
  assert.ok(ownObstacles.some(item=>Math.abs(item.x-center.x)<1e-6&&Math.abs(item.z-center.z)<1e-6&&Math.abs(item.sx-size.x)<1e-6&&Math.abs(item.sz-size.z)<1e-6),'Every solid footprint must block movement');
  const hit=traceWorld({x:center.x-size.x/2-1,y:center.y,z:center.z},{x:center.x+size.x/2+1,y:center.y,z:center.z},{height:()=>-100,covers:[cover]},0);
  assert.ok(hit&&hit.kind==='structure');
  assert.ok(Math.abs(hit.x-(center.x-size.x/2))<1e-5,'Projectiles strike the rendered box face');
 });
 assert.ok(meshes>=5&&meshes<=20,'Each landmark is an authored bounded assembly');maxMeshes=Math.max(maxMeshes,meshes);
 for(const obstacle of ownObstacles){
  assert.equal(terrain.clear(obstacle.x,obstacle.z,.45),false);
  assert.ok(originalObstacles.every(item=>item.sx?Math.abs(item.x-obstacle.x)>=(item.sx+obstacle.sx)/2||Math.abs(item.z-obstacle.z)>=(item.sz+obstacle.sz)/2:Math.hypot(item.x-obstacle.x,item.z-obstacle.z)>item.r+Math.hypot(obstacle.sx,obstacle.sz)/2),'Assembly must not overlap existing scenery');
 }
 let ownedDisposals=0;for(const resource of ownedResources)resource.addEventListener('dispose',()=>ownedDisposals++);
 landmark.dispose();landmark.dispose();
 assert.equal(landmark.group.parent,null);assert.equal(ownedDisposals,ownedResources.size,'Owned geometry/materials dispose exactly once');assert.equal(sharedDisposals,0,'Shared scenery remains owned by its world');
 assert.ok(originalObstacles.every(item=>terrain.obstacles.includes(item))&&ownObstacles.every(item=>!terrain.obstacles.includes(item)),'Dispose removes only landmark obstacles');
 assert.ok(originalCovers.every(item=>world.covers.includes(item))&&ownCovers.every(item=>!world.covers.includes(item)),'Dispose removes only landmark cover');
 assert.equal(landmark.claim(),false);assert.equal(landmark.nearby(player),false);
 statues.dispose();world.dispose();count++;
}
assert.equal(new Set(ids.values()).size,5,'Every stage has a different stable journal discovery');
const tutorial=createTerrain(1,123,{tutorial:true}),tutorialWorld=buildStageWorld(tutorial);
assert.equal(createLandmark(tutorial,tutorialWorld),null,'Tutorial must not create campaign discoveries');tutorialWorld.dispose();
console.log(`PASS: ${count} reachable authored landmarks, once-only claims, portal/outer routes, statues, matching movement/projectile solids, owned disposal; at most ${maxMeshes} draw calls.`);
