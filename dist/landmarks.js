// DISCOVERIES — one optional authored structure per world; gameplay/profile rewards belong to game.js.
import * as T from 'three';
import {retroMaterial} from './retro.js?v=17';

export const LANDMARKS=Object.freeze([
 {stage:1,id:'meadow-shrine',name:'Shrine of the Last Rain',text:'The wardens left fresh water here for every traveler, even those fleeing the Crown. A little remains beneath the moss.',heal:12,rest:4},
 {stage:2,id:'quarry-engine',name:'The Silent Tithe Engine',text:'This counterweight lifted stone for the Citadel until the miners refused their final tithe. Its brake is still locked around a worker’s hammer.',heal:12,rest:4},
 {stage:3,id:'caldera-reliquary',name:'Reliquary of the First Ember',text:'The keepers sealed the first rift ember here, believing the mountain could swallow it. Pilgrims left cooling salts beside the seal.',heal:12,rest:4},
 {stage:4,id:'citadel-archive',name:'The Unburned Archive',text:'These stone leaves record the names the Crown ordered erased. The archivists carved them deep enough to outlast the fortress.',heal:12,rest:4},
 {stage:5,id:'void-memorial',name:'Memorial to the Unreturned',text:'Two broken crowns mark the last expedition that tried to close this rift. Between them, someone left a place for the next survivor.',heal:12,rest:4}
].map(Object.freeze));

// Every part is an axis-aligned low-poly box. The same dimensions feed rendering,
// movement footprints and swept projectile cover, including small relief details.
// All upper parts sit within the solid foundation: no invisible overhead walk blockers.
function assembly(stage){
 const base=[0,.18,0,4,.36,2.4,0];
 if(stage===1)return [base,[-1.5,1.8,0,.7,3.25,.8,0],[1.5,1.8,0,.7,3.25,.8,0],[-1.5,3.5,0,1.05,.3,1.1,1],[1.5,3.5,0,1.05,.3,1.1,1],[0,3.78,0,3.8,.36,1.1,0],[0,.8,.2,1.8,.9,1.3,0],[0,1.35,.2,2.1,.2,1.5,1],[0,2.6,.48,.42,.68,.12,2]];
 if(stage===2)return [base,[-1.6,2,0,.6,3.65,.9,0],[1.6,2,0,.6,3.65,.9,0],[0,3.92,0,3.9,.4,.95,1],[0,2.87,0,.16,1.7,.16,1],[-.75,1.38,0,1.05,2,.95,0],[-.75,2.5,0,1.45,.25,1.25,1],[.7,.8,.15,1.4,.88,1.3,0],[.7,1.38,.15,1.7,.24,1.55,1],[1.6,2.8,.53,.18,.8,.14,2],[-1.6,2.8,.53,.18,.8,.14,2]];
 if(stage===3)return [base,[-1.5,1.58,0,.7,2.8,.9,0],[1.5,1.58,0,.7,2.8,.9,0],[0,3.1,0,3.9,.4,1.4,0],[0,3.46,0,2.9,.32,1.2,1],[0,3.77,0,1.9,.3,1,0],[0,1.05,0,2,1.4,1.45,0],[0,1.91,0,2.35,.3,1.7,1],[0,2.23,0,.7,.34,.7,2],[0,1.05,.75,.5,.6,.1,2]];
 if(stage===4)return [base,[-1.65,1.98,0,.5,3.6,1.5,0],[1.65,1.98,0,.5,3.6,1.5,0],[0,3.85,0,3.9,.3,1.8,1],[0,1.9,-.48,2.85,3,.35,0],[-.78,1.97,.05,1.15,2.8,.6,1],[.78,1.97,.05,1.15,2.8,.6,1],[-.78,1.1,.39,.72,.1,.08,2],[-.78,1.7,.39,.72,.1,.08,2],[-.78,2.3,.39,.72,.1,.08,2],[.78,1.4,.39,.72,.1,.08,2],[.78,2,.39,.72,.1,.08,2],[.78,2.6,.39,.72,.1,.08,2]];
 return [base,[-1.2,1.9,0,1.1,3.45,1.3,0],[1.2,1.65,0,1.1,2.95,1.3,0],[-1.45,3.82,0,.6,.4,1.3,1],[-.97,4.1,0,.34,.95,1.1,0],[1.45,3.32,0,.6,.4,1.3,1],[.97,3.55,0,.34,.85,1.1,0],[0,.7,.2,1.15,.68,1.35,1],[0,1.13,.2,1.3,.18,1.5,0],[-1.2,2.25,.68,.34,.7,.08,2],[1.2,1.92,.68,.34,.7,.08,2]];
}

function removeOwned(list,owned){for(const item of owned){const index=list.indexOf(item);if(index>=0)list.splice(index,1)}}

// Called after scenery and preferably before statues. Candidate sites are connected
// outer cells beside authored routes; they reserve the full footprint before navigation
// is rebuilt. Reject a site if it disconnects any existing required waypoint.
export function createLandmark(terrain,stageWorld){
 if(terrain.tutorial)return null;
 const definition=LANDMARKS.find(item=>item.stage===terrain.stage);if(!definition)return null;
 const parts=assembly(terrain.stage),portal=terrain.points[0];
 const required=terrain.points.map(([x,z])=>terrain.safeNear(x,z,1.45));
 const candidates=terrain.reachable.map(terrain.position).filter(p=>{
  const distance=Math.hypot(p.x,p.z);
  return distance>20&&distance<53&&Math.hypot(p.x-portal[0],p.z-portal[1])>15&&terrain.routeAt(p.x,p.z).distance>7.4&&terrain.clear(p.x,p.z,4.5);
 }).sort((a,b)=>{
  const score=p=>Math.min(...terrain.points.slice(1).map(([x,z])=>Math.hypot(p.x-x,p.z-z)))+Math.abs(Math.hypot(p.x,p.z)-36)*.25;
  return score(a)-score(b)||a.z-b.z||a.x-b.x;
 });
 let site=null,obstacles=[];
 for(const candidate of candidates){
  const approach={x:candidate.x,z:candidate.z+3.2};
  if(!terrain.walkable(approach.x,approach.z,1.45))continue;
  const y=terrain.height(candidate.x,candidate.z),corners=[[-2,-1.2],[-2,1.2],[2,-1.2],[2,1.2]];
  // A connected approach must also be at interaction height, not below a shelf.
  if(Math.abs(terrain.height(approach.x,approach.z)-y)>1.5)continue;
  if(corners.some(([x,z])=>Math.abs(terrain.height(candidate.x+x,candidate.z+z)-y)>1))continue;
  obstacles=parts.map(([x,,z,sx,,sz])=>({x:candidate.x+x,z:candidate.z+z,sx,sz}));
  terrain.obstacles.push(...obstacles);terrain.rebuildNavigation();
  const nav=terrain.position(terrain.cell(approach.x,approach.z));
  if(terrain.valid[terrain.cell(approach.x,approach.z)]&&terrain.canMove(nav.x,nav.z,approach.x,approach.z,1.45)&&required.every(p=>terrain.valid[terrain.cell(p.x,p.z)])){
   site={...candidate,y,approach};break;
  }
  removeOwned(terrain.obstacles,obstacles);terrain.rebuildNavigation();obstacles=[];
 }
 if(!site)return null;
 // Sink the foundation through the sampled hillside while keeping its top level.
 // The slab's footprint already owns collision; no terrain deformation is needed.
 let foundationBottom=site.y;
 for(let x=-2;x<=2;x+=.4)for(let z=-1.2;z<=1.201;z+=.4)foundationBottom=Math.min(foundationBottom,terrain.height(site.x+x,site.z+z));
 foundationBottom-=site.y+.12;
 parts[0]=[0,(foundationBottom+.36)/2,0,4,.36-foundationBottom,2.4,0];
 const palettes=[['#7c8775','#b6b99b','#667555'],['#4a5c68','#c3a571','#89654c'],['#53414c','#b68570','#b86c43'],['#536b83','#b3c2c6','#65748a'],['#504166','#a99aaa','#796788']];
 const tile=[5,6,8,10,11][terrain.stage-1],materials=palettes[terrain.stage-1].map(color=>retroMaterial(color,tile,{occlusion:true}));
 const geometry=new T.BoxGeometry(1,1,1),group=new T.Group(),covers=[];
 group.name=definition.name;
 for(const [x,y,z,sx,sy,sz,color] of parts){
  const mesh=new T.Mesh(geometry,materials[color]);mesh.position.set(site.x+x,site.y+y,site.z+z);mesh.scale.set(sx,sy,sz);mesh.castShadow=mesh.receiveShadow=true;group.add(mesh);
  covers.push({shape:'box',x:site.x+x,y:site.y+y,z:site.z+z,sx,sy,sz,rotation:0});
 }
 stageWorld.covers.push(...covers);
 let disposed=false;
 const landmark={...definition,x:site.x,z:site.z,y:site.y,approach:site.approach,group,claimed:false,interactionRadius:3.6,
  nearby(player){return !disposed&&!!player&&Math.hypot(player.x-site.x,player.z-site.z)<landmark.interactionRadius&&Math.abs(terrain.height(player.x,player.z)-site.y)<2},
  claim(){if(disposed||landmark.claimed)return false;landmark.claimed=true;return true},
  dispose(){if(disposed)return;disposed=true;group.removeFromParent();geometry.dispose();materials.forEach(material=>material.dispose());removeOwned(terrain.obstacles,obstacles);removeOwned(stageWorld.covers,covers);terrain.rebuildNavigation()}
 };
 return landmark;
}
