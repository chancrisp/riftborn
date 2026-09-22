// One sampled surface drives rendering, movement, navigation and spawning.
export const EXTENT=76, CELLS=152, PLAY_RADIUS=66;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t)};
const mix=(a,b,t)=>a+(b-a)*t;
export function randomSource(seed){return (a=0,b=1)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return a+(b-a)*seed/4294967296}}
const layouts=[
 {points:[[0,-30,2],[-27,-19,4],[-34,14,2],[0,36,-1],[33,21,4],[35,-12,1]],width:4.5},
 {points:[[27,-19,5],[8,-42,8],[-30,-28,5],[-38,8,2],[-10,37,7],[31,30,9]],width:4.2},
 {points:[[-28,22,6],[-36,-10,5],[-10,-37,7],[29,-28,6],[38,8,4],[8,38,5]],width:4.3},
 {points:[[6,34,8],[-27,34,8],[-32,-8,4],[-22,-34,8],[24,-34,8],[34,12,4]],width:4.8},
 {points:[[-34,-20,5],[-8,-41,8],[32,-27,5],[38,16,7],[5,38,5],[-32,27,8]],width:4.8}
];
export function createTerrain(stage,seed=7361){
 const rng=randomSource(seed+stage*7919), phase=rng(-3,3), layout=layouts[stage-1];
 // The entry and portal stay fixed; outer landmarks change between runs.
 const points=layout.points.map((p,i)=>i===0?[...p]:[p[0]+rng(-3,3),p[1]+rng(-3,3),p[2]+rng(-.6,.6)]);
 const routes=[];
 const spokes=stage===2?[0]:stage===4?[0]:stage===5?[0,1,2,3,4,5]:[0,2,4];
 for(const i of spokes)routes.push([[0,0,0],points[i]]);
 if(stage!==5)for(let i=0;i<points.length;i++)routes.push([points[i],points[(i+1)%points.length]]);
 if(stage===2)routes.push([[0,0,0],[-16,0,0]],[[-16,0,0],[-16,14,1]],[[-16,14,1],points[3]]);
 if(stage===4)routes.push([[0,0,0],[0,-34,4]],[[0,-34,4],points[3]],[[0,-34,4],points[4]],[[0,0,0],[-32,0,3]],[[-32,0,3],points[2]]);
 function raw(x,z){
  const d=Math.hypot(x,z), wave=Math.sin(x*.085+phase)*Math.cos(z*.095-phase);
  if(stage===1)return 2+3.6*wave+2.5*Math.sin(z*.055)-2.6*Math.exp(-(((x+Math.sin(z*.06)*13)/9)**2));
  if(stage===2){const q=Math.max(Math.abs(x+4)*.9,Math.abs(z-3));return -3+Math.floor(q/11)*3.4+.35*wave}
  if(stage===3)return -3+11*Math.exp(-(((d-34)/12)**2))+2*wave+Math.max(0,d-45)*.22;
  if(stage===4)return Math.floor(Math.max(Math.abs(x),Math.abs(z))/13)*3.2+((Math.abs(x)>18&&Math.abs(x)<28)?-4:0);
  const a=Math.atan2(z,x);return 2+Math.floor(d/15)*2.1+2*wave-10*Math.exp(-((Math.sin(a*3+phase*.2)*d/3.5)**2));
 }
 function routeAt(x,z){let distance=Infinity,total=0,sum=0;for(const [a,b] of routes){const dx=b[0]-a[0],dz=b[1]-a[1],t=clamp(((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz),0,1),d=Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz),w=Math.max(0,1-d/(layout.width+4))**4;distance=Math.min(distance,d);total+=w;sum+=w*mix(a[2],b[2],t)}return {distance,y:total?sum/total:0}}
 function generatedHeight(x,z){const r=routeAt(x,z);let y=mix(r.y,raw(x,z),smooth(layout.width,layout.width+4,r.distance));y=mix(0,y,smooth(6,11,Math.hypot(x,z)));const p=points[0];return mix(p[2],y,smooth(5,8,Math.hypot(x-p[0],z-p[1])))}
 const heights=new Float32Array((CELLS+1)**2);
 for(let iz=0;iz<=CELLS;iz++)for(let ix=0;ix<=CELLS;ix++)heights[iz*(CELLS+1)+ix]=generatedHeight(ix-EXTENT,iz-EXTENT);
 // Match the diagonal of the rendered triangles exactly, including cliff edges.
 function height(x,z){const gx=clamp(x+EXTENT,0,CELLS-.00001),gz=clamp(z+EXTENT,0,CELLS-.00001),ix=Math.floor(gx),iz=Math.floor(gz),u=gx-ix,v=gz-iz,k=iz*(CELLS+1)+ix,a=heights[k],b=heights[k+1],c=heights[k+CELLS+1],d=heights[k+CELLS+2];return u+v<=1?a+(b-a)*u+(c-a)*v:d+(c-d)*(1-u)+(b-d)*(1-v)}
 const obstacles=[];
 function clear(x,z,r=.45){if(Math.hypot(x,z)>PLAY_RADIUS-r)return false;for(const o of obstacles){if(o.sx){if(Math.abs(x-o.x)<o.sx/2+r&&Math.abs(z-o.z)<o.sz/2+r)return false}else if(Math.hypot(x-o.x,z-o.z)<o.r+r)return false}return true}
 function walkable(x,z,r=.45){if(!clear(x,z,r))return false;const y=height(x,z),reach=1.5;return [[reach,0],[-reach,0],[0,reach],[0,-reach]].every(([dx,dz])=>Math.abs(height(x+dx,z+dz)-y)<=reach*.85+.12)}
 function canMove(x,z,nx,nz,r){const d=Math.hypot(nx-x,nz-z);return walkable(nx,nz,r)&&Math.abs(height(nx,nz)-height(x,z))<=d*.85+.00001}
 function move(o,dx,dz,r){const n=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.18));dx/=n;dz/=n;for(let i=0;i<n;i++){if(canMove(o.x,o.z,o.x+dx,o.z+dz,r)){o.x+=dx;o.z+=dz}else{if(canMove(o.x,o.z,o.x+dx,o.z,r))o.x+=dx;if(canMove(o.x,o.z,o.x,o.z+dz,r))o.z+=dz}}}
 // Conservative shared navigation clearance supports the largest enemy (Warden).
 const size=65, step=2, offset=64, valid=new Uint8Array(size*size),edges=Array.from({length:size*size},()=>[]),reachable=[],flow=new Int32Array(size*size);let targetCell=-1;
 const position=i=>({x:(i%size)*step-offset,z:Math.floor(i/size)*step-offset});
 function cell(x,z){return clamp(Math.round((z+offset)/step),0,size-1)*size+clamp(Math.round((x+offset)/step),0,size-1)}
 function closest(x,z){let i=cell(x,z);if(valid[i])return i;let best=Infinity,result=-1;for(const k of reachable){const p=position(k),d=(p.x-x)**2+(p.z-z)**2;if(d<best){best=d;result=k}}return result}
 function rebuildNavigation(){valid.fill(0);reachable.length=0;for(let i=0;i<valid.length;i++){edges[i].length=0;const p=position(i);valid[i]=walkable(p.x,p.z,1.45)?1:0}for(let i=0;i<valid.length;i++){if(!valid[i])continue;const p=position(i);for(const j of [i-1,i+1,i-size,i+size]){if(j<0||j>=valid.length||!valid[j])continue;const q=position(j);if(Math.hypot(p.x-q.x,p.z-q.z)>2.01)continue;let ok=true;for(let n=1;n<=20;n++){const x=mix(p.x,q.x,n/20),z=mix(p.z,q.z,n/20);if(!canMove(mix(p.x,q.x,(n-1)/20),mix(p.z,q.z,(n-1)/20),x,z,1.45)){ok=false;break}}if(ok)edges[i].push(j)}}const seen=new Set([cell(0,0)]),queue=[cell(0,0)];for(let n=0;n<queue.length;n++)for(const j of edges[queue[n]])if(!seen.has(j)){seen.add(j);queue.push(j)}for(let i=0;i<valid.length;i++)if(!seen.has(i))valid[i]=0;reachable.push(...queue);targetCell=-1}
 function updateFlow(x,z){const target=closest(x,z);if(target===targetCell)return;targetCell=target;flow.fill(-1);if(target<0)return;flow[target]=target;const queue=[target];for(let n=0;n<queue.length;n++)for(const j of edges[queue[n]])if(valid[j]&&flow[j]===-1){flow[j]=queue[n];queue.push(j)}}
 function steer(x,z,tx,tz,agent){updateFlow(tx,tz);const nav=agent||{};if(nav.navCell===undefined||!valid[nav.navCell]||Math.hypot(position(nav.navCell).x-x,position(nav.navCell).z-z)>4)nav.navCell=closest(x,z);let q=flow[nav.navCell]===nav.navCell?{x:tx,z:tz}:position(nav.navCell);if(Math.hypot(q.x-x,q.z-z)<.001){const next=flow[nav.navCell];if(next>=0&&next!==nav.navCell){nav.navCell=next;q=position(next)}else q={x:tx,z:tz}}const d=Math.max(.24,Math.hypot(q.x-x,q.z-z));return {x:(q.x-x)/d,z:(q.z-z)/d}}
 function spawn(px,pz,r=.5,random=Math.random){const candidates=reachable.filter(i=>{const p=position(i),d=Math.hypot(p.x-px,p.z-pz);return d>=17&&d<=26&&walkable(p.x,p.z,r)});const pool=candidates.length?candidates:reachable.filter(i=>{const p=position(i);return Math.hypot(p.x-px,p.z-pz)>=12&&walkable(p.x,p.z,r)});const p=position(pool[Math.min(pool.length-1,Math.floor(random()*pool.length))]??cell(0,0));return p}
 function safeNear(x,z,r=.5){const candidates=reachable.map(i=>({...position(i),i})).filter(p=>walkable(p.x,p.z,r));candidates.sort((a,b)=>(a.x-x)**2+(a.z-z)**2-((b.x-x)**2+(b.z-z)**2));return candidates[0]||{x:0,z:0}}
 return {stage,seed,heights,points,routes,obstacles,height,routeAt,clear,walkable,canMove,move,rebuildNavigation,reachable,edges,position,cell,steer,spawn,safeNear,valid};
}
