// TERRAIN REFERENCE: layouts define paths/portal clearings; generatedHeight shapes the mesh; canMove and navigation share that exact sampled surface. Tutorial uses a smaller open cloister.
// One sampled surface drives rendering, movement, navigation and spawning.
export const EXTENT=76, CELLS=152, PLAY_RADIUS=66, MAX_WALK_SLOPE=.85;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t)};
const mix=(a,b,t)=>a+(b-a)*t;
// SEEDED RANDOMNESS — same seed produces the same layout; returns a number in [a, b).
export function randomSource(seed){return (a=0,b=1)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return a+(b-a)*seed/4294967296}}
// STAGE PATHS — [x, z, height] landmarks; the first point is the reserved portal clearing.
const layouts=[
 {points:[[0,-30,2],[-27,-19,4],[-34,14,2],[0,36,-1],[33,21,4],[35,-12,1]],width:4.5},
 {points:[[27,-19,5],[8,-42,8],[-30,-28,5],[-38,8,2],[-10,37,7],[31,30,9]],width:4.2},
 {points:[[-28,22,6],[-36,-10,5],[-10,-37,7],[29,-28,6],[38,8,4],[8,38,5]],width:4.3},
 {points:[[6,34,8],[-27,34,8],[-32,-8,4],[-22,-34,8],[24,-34,8],[34,12,4]],width:4.8},
 {points:[[-34,-20,5],[-8,-41,8],[32,-27,5],[38,16,7],[5,38,5],[-32,27,8]],width:4.8}
];
export function createTerrain(stage,seed=7361,{tutorial=false}={}){
 const rng=randomSource(seed+stage*7919), phase=rng(-3,3), layout=tutorial?{points:[[0,-20,0],[-14,-10,0],[14,-10,0],[14,10,0],[-14,10,0]],width:5}:layouts[stage-1];
 // The entry and portal stay fixed; outer landmarks change between runs.
 const points=layout.points.map((p,i)=>tutorial||i===0?[...p]:[p[0]+rng(-3,3),p[1]+rng(-3,3),p[2]+rng(-.6,.6)]);
 const routes=[];
 const spokes=tutorial?[0,1,2,3,4]:stage===2?[0]:stage===4?[0]:stage===5?[0,1,2,3,4,5]:[0,2,4];
 for(const i of spokes)routes.push([[0,0,0],points[i]]);
 if(stage!==5)for(let i=0;i<points.length;i++)routes.push([points[i],points[(i+1)%points.length]]);
 if(stage===2)routes.push([[0,0,0],[-16,0,0]],[[-16,0,0],[-16,14,1]],[[-16,14,1],points[3]]);
 if(stage===4)routes.push([[0,0,0],[0,-34,4]],[[0,-34,4],points[3]],[[0,-34,4],points[4]],[[0,0,0],[-32,0,3]],[[-32,0,3],points[2]]);
 // BASE GEOGRAPHY — stage-specific hills/cliffs before safe paths flatten selected areas.
 function raw(x,z){
  const d=Math.hypot(x,z), wave=Math.sin(x*.085+phase)*Math.cos(z*.095-phase);
  if(tutorial)return Math.max(0,d-23)*.28+.22*Math.sin(x*.13)*Math.sin(z*.11);
  if(stage===1)return 2+3.6*wave+2.5*Math.sin(z*.055)-2.6*Math.exp(-(((x+Math.sin(z*.06)*13)/9)**2));
  if(stage===2){const q=Math.max(Math.abs(x+4)*.9,Math.abs(z-3));return -3+Math.floor(q/11)*3.4+.35*wave}
  if(stage===3)return -3+11*Math.exp(-(((d-34)/12)**2))+2*wave+Math.max(0,d-45)*.22;
  if(stage===4)return Math.floor(Math.max(Math.abs(x),Math.abs(z))/13)*3.2+((Math.abs(x)>18&&Math.abs(x)<28)?-4:0);
  const a=Math.atan2(z,x);return 2+Math.floor(d/15)*2.1+2*wave-10*Math.exp(-((Math.sin(a*3+phase*.2)*d/3.5)**2));
 }
 function routeAt(x,z){let distance=Infinity,total=0,sum=0;for(const [a,b] of routes){const dx=b[0]-a[0],dz=b[1]-a[1],t=clamp(((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz),0,1),d=Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz),w=Math.max(0,1-d/(layout.width+4))**4;distance=Math.min(distance,d);total+=w;sum+=w*mix(a[2],b[2],t)}return {distance,y:total?sum/total:0}}
 // BLEND SAFE AREAS — reserve entry, paths and portal, then sample the resulting surface once.
 // The portal's five-unit floor stays flat; its outer shoulder needs five more
 // units to meet the same full-face slope limit as walking (especially Citadel).
 function generatedHeight(x,z){const r=routeAt(x,z);let y=mix(r.y,raw(x,z),smooth(layout.width,layout.width+4,r.distance));y=mix(0,y,smooth(6,11,Math.hypot(x,z)));const p=points[0];return mix(p[2],y,smooth(5,10,Math.hypot(x-p[0],z-p[1])))}
 const heights=new Float32Array((CELLS+1)**2);
 for(let iz=0;iz<=CELLS;iz++)for(let ix=0;ix<=CELLS;ix++)heights[iz*(CELLS+1)+ix]=generatedHeight(ix-EXTENT,iz-EXTENT);
 // Match the diagonal of the rendered triangles exactly, including cliff edges.
 function height(x,z){const gx=clamp(x+EXTENT,0,CELLS-.00001),gz=clamp(z+EXTENT,0,CELLS-.00001),ix=Math.floor(gx),iz=Math.floor(gz),u=gx-ix,v=gz-iz,k=iz*(CELLS+1)+ix,a=heights[k],b=heights[k+1],c=heights[k+CELLS+1],d=heights[k+CELLS+2];return u+v<=1?a+(b-a)*u+(c-a)*v:d+(c-d)*(1-u)+(b-d)*(1-v)}
 // The gradient belongs to the actual rendered triangle, not a distant height
 // average. Use this same classification for cliff materials and walking.
 function surfaceGradient(x,z){const gx=clamp(x+EXTENT,0,CELLS-.00001),gz=clamp(z+EXTENT,0,CELLS-.00001),ix=Math.floor(gx),iz=Math.floor(gz),k=iz*(CELLS+1)+ix,a=heights[k],b=heights[k+1],c=heights[k+CELLS+1],d=heights[k+CELLS+2];return gx-ix+gz-iz<=1?{x:b-a,z:c-a}:{x:d-c,z:d-b}}
 function surfaceSlope(x,z){const gradient=surfaceGradient(x,z);return Math.hypot(gradient.x,gradient.z)}
 const obstacles=[];
 function clear(x,z,r=.45){if(Math.hypot(x,z)>(tutorial?28:PLAY_RADIUS)-r)return false;for(const o of obstacles){if(o.sx){if(Math.abs(x-o.x)<o.sx/2+r&&Math.abs(z-o.z)<o.sz/2+r)return false}else if(Math.hypot(x-o.x,z-o.z)<o.r+r)return false}return true}
 function walkable(x,z,r=.45){return clear(x,z,r)&&surfaceSlope(x,z)<=MAX_WALK_SLOPE+.00001}
 function canMove(x,z,nx,nz,r=.45){
  if(!walkable(nx,nz,r))return false;
  const dx=nx-x,dz=nz-z,d=Math.hypot(dx,dz);if(d<1e-10)return true;
  for(const obstacle of obstacles){
   if(obstacle.sx){
    let low=0,high=1,hit=true;
    for(const [start,delta,extent] of [[x-obstacle.x,dx,obstacle.sx/2+r],[z-obstacle.z,dz,obstacle.sz/2+r]]){
     if(Math.abs(delta)<1e-12){if(Math.abs(start)>=extent){hit=false;break}}
     else{let a=(-extent-start)/delta,b=(extent-start)/delta;if(a>b)[a,b]=[b,a];low=Math.max(low,a);high=Math.min(high,b);if(low>=high){hit=false;break}}
    }
    if(hit&&high>1e-10&&low<1-1e-10)return false;
   }else{
    const at=clamp(((obstacle.x-x)*dx+(obstacle.z-z)*dz)/(d*d),0,1);
    if(Math.hypot(x+dx*at-obstacle.x,z+dz*at-obstacle.z)<obstacle.r+r)return false;
   }
  }
  // Never average opposing slopes across a crease: that can admit a step into
  // a steep facet from which ordinary walking has no exit. The rendered mesh
  // is affine between integer x, z and x+z triangle boundaries.
  const cuts=[0,1];
  for(const [start,delta] of [[x,dx],[z,dz],[x+z,dx+dz]]){
   if(Math.abs(delta)<1e-12)continue;
   const end=start+delta,lo=Math.min(start,end),hi=Math.max(start,end);
   for(let edge=Math.floor(lo)+1;edge<hi;edge++){const t=(edge-start)/delta;if(t>1e-10&&t<1-1e-10)cuts.push(t)}
  }
  cuts.sort((a,b)=>a-b);
  for(let i=1;i<cuts.length;i++){const a=cuts[i-1],b=cuts[i];if(b-a<1e-10)continue;const midpoint=(a+b)/2;if(surfaceSlope(x+dx*midpoint,z+dz*midpoint)>MAX_WALK_SLOPE+.00001)return false}
  return true;
 }
 // MOVEMENT — bounded swept steps; a rejected uphill component can still move
 // along the cliff contour. Every slide uses the same surface/collision test.
 function move(o,dx,dz,r){
  const n=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.18));dx/=n;dz/=n;
  for(let i=0;i<n;i++){
   if(canMove(o.x,o.z,o.x+dx,o.z+dz,r)){o.x+=dx;o.z+=dz;continue}
   const gradient=surfaceGradient(o.x+dx,o.z+dz),normalLength=Math.hypot(gradient.x,gradient.z);
   if(normalLength>MAX_WALK_SLOPE){
    const nx=gradient.x/normalLength,nz=gradient.z/normalLength,dot=dx*nx+dz*nz,sx=dx-dot*nx,sz=dz-dot*nz;
    if(Math.hypot(sx,sz)>.00001&&canMove(o.x,o.z,o.x+sx,o.z+sz,r)){o.x+=sx;o.z+=sz;continue}
   }
   if(canMove(o.x,o.z,o.x+dx,o.z,r))o.x+=dx;
   if(canMove(o.x,o.z,o.x,o.z+dz,r))o.z+=dz;
  }
 }
 // Conservative shared navigation clearance supports the largest enemy (Warden).
 const size=65, step=2, offset=64, valid=new Uint8Array(size*size),edges=Array.from({length:size*size},()=>[]),reachable=[],flow=new Int32Array(size*size);let targetCell=-1;
 const position=i=>({x:(i%size)*step-offset,z:Math.floor(i/size)*step-offset});
 function cell(x,z){return clamp(Math.round((z+offset)/step),0,size-1)*size+clamp(Math.round((x+offset)/step),0,size-1)}
 function closest(x,z){let i=cell(x,z);if(valid[i])return i;let best=Infinity,result=-1;for(const k of reachable){const p=position(k),d=(p.x-x)**2+(p.z-z)**2;if(d<best){best=d;result=k}}return result}
 // NAVIGATION BUILD — call after adding obstacles; only cells connected to entry remain valid.
 function rebuildNavigation(){
  valid.fill(0);reachable.length=0;
  // Real movement approaches nodes with tiny rounding offsets. A route exactly
  // balanced on a cliff's triangle edge is not a usable corridor. This narrow
  // navigation-only margin does not widen any player collision or obstacle.
  const margin=.04,offsets=[[0,0],[margin,0],[-margin,0],[0,margin],[0,-margin]];
  for(let i=0;i<valid.length;i++){
   edges[i].length=0;const p=position(i);
   valid[i]=walkable(p.x,p.z,1.45)&&offsets.every(([x,z])=>surfaceSlope(p.x+x,p.z+z)<=MAX_WALK_SLOPE+.00001)?1:0;
  }
  for(let i=0;i<valid.length;i++){
   if(!valid[i])continue;const p=position(i);
   for(const j of [i-1,i+1,i-size,i+size]){
    if(j<0||j>=valid.length||!valid[j])continue;const q=position(j);
    if(Math.hypot(p.x-q.x,p.z-q.z)>2.01)continue;
    const sides=p.x===q.x?[[0,0],[margin,0],[-margin,0]]:[[0,0],[0,margin],[0,-margin]];
    if(sides.every(([x,z])=>canMove(p.x+x,p.z+z,q.x+x,q.z+z,1.45)))edges[i].push(j);
   }
  }
  const seen=new Set([cell(0,0)]),queue=[cell(0,0)];
  for(let n=0;n<queue.length;n++)for(const j of edges[queue[n]])if(!seen.has(j)){seen.add(j);queue.push(j)}
  for(let i=0;i<valid.length;i++)if(!seen.has(i))valid[i]=0;
  reachable.push(...queue);targetCell=-1;
 }
 // PATH CACHE — a shared flow field points enemies toward the player; rebuild when target cell changes.
 function updateFlow(x,z){const target=closest(x,z);if(target===targetCell)return;targetCell=target;flow.fill(-1);if(target<0)return;flow[target]=target;const queue=[target];for(let n=0;n<queue.length;n++)for(const j of edges[queue[n]])if(valid[j]&&flow[j]===-1){flow[j]=queue[n];queue.push(j)}}
 function steer(x,z,tx,tz,agent){updateFlow(tx,tz);const nav=agent||{};if(nav.navCell===undefined||!valid[nav.navCell]||Math.hypot(position(nav.navCell).x-x,position(nav.navCell).z-z)>4)nav.navCell=closest(x,z);let q=flow[nav.navCell]===nav.navCell?{x:tx,z:tz}:position(nav.navCell);if(Math.hypot(q.x-x,q.z-z)<.001){const next=flow[nav.navCell];if(next>=0&&next!==nav.navCell){nav.navCell=next;q=position(next)}else q={x:tx,z:tz}}const d=Math.max(.24,Math.hypot(q.x-x,q.z-z));return {x:(q.x-x)/d,z:(q.z-z)/d}}
 // SAFE SPAWNS — choose connected, walkable cells outside the immediate player area.
 function spawn(px,pz,r=.5,random=Math.random){const candidates=reachable.filter(i=>{const p=position(i),d=Math.hypot(p.x-px,p.z-pz);return d>=17&&d<=26&&walkable(p.x,p.z,r)});const pool=candidates.length?candidates:reachable.filter(i=>{const p=position(i);return Math.hypot(p.x-px,p.z-pz)>=12&&walkable(p.x,p.z,r)});const p=position(pool[Math.min(pool.length-1,Math.floor(random()*pool.length))]??cell(0,0));return p}
 // PLACEMENT RECOVERY — snap authored/summoned positions to the nearest reachable cell.
 function safeNear(x,z,r=.5){const candidates=reachable.map(i=>({...position(i),i})).filter(p=>walkable(p.x,p.z,r));candidates.sort((a,b)=>(a.x-x)**2+(a.z-z)**2-((b.x-x)**2+(b.z-z)**2));return candidates[0]||{x:0,z:0}}
 return {stage,seed,tutorial,heights,points,routes,obstacles,height,surfaceSlope,routeAt,clear,walkable,canMove,move,rebuildNavigation,reachable,edges,position,cell,steer,spawn,safeNear,valid};
}
