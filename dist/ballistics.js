// World-space swept projectile collisions.
const lerp=(a,b,t)=>a+(b-a)*t;
export const pointAt=(a,b,t)=>({x:lerp(a.x,b.x,t),y:lerp(a.y,b.y,t),z:lerp(a.z,b.z,t)});
function slab(p,d,min,max,interval){if(Math.abs(d)<1e-10)return p>=min&&p<=max;let a=(min-p)/d,b=(max-p)/d;if(a>b)[a,b]=[b,a];interval[0]=Math.max(interval[0],a);interval[1]=Math.min(interval[1],b);return interval[0]<=interval[1]}
export function hitBody(a,b,{x,z,radius,bottom,top}){
 const dx=b.x-a.x,dz=b.z-a.z,ox=a.x-x,oz=a.z-z,A=dx*dx+dz*dz,C=ox*ox+oz*oz-radius*radius,interval=[0,1];
 if(A<1e-12){if(C>0)return null}else{const B=2*(ox*dx+oz*dz),D=B*B-4*A*C;if(D<0)return null;interval[0]=Math.max(0,(-B-Math.sqrt(D))/(2*A));interval[1]=Math.min(1,(-B+Math.sqrt(D))/(2*A));if(interval[0]>interval[1])return null}
 if(!slab(a.y,b.y-a.y,bottom,top,interval))return null;
 return interval[0];
}
function hitCover(a,b,o,r){
 const c=Math.cos(o.rotation||0),s=Math.sin(o.rotation||0),local=p=>({x:c*(p.x-o.x)-s*(p.z-o.z),y:p.y-o.y,z:s*(p.x-o.x)+c*(p.z-o.z)}),p=local(a),q=local(b),range=[0,1];
 if(o.hull){
  for(const k of ['x','y','z'])if(!slab(p[k],q[k]-p[k],o.hull.min[k]*o['s'+k]-r,o.hull.max[k]*o['s'+k]+r,range))return null;
  // Clip against the actual convex model faces, including tapered tree crowns
  // and the full upper/lower tips of crystal models. Scale normals inversely.
  for(const face of o.hull.planes){
   const nx=face.x/o.sx,ny=face.y/o.sy,nz=face.z/o.sz,pad=r*Math.hypot(nx,ny,nz);
   const from=p.x*nx+p.y*ny+p.z*nz-face.w-pad,to=q.x*nx+q.y*ny+q.z*nz-face.w-pad;
   if(from>0&&to>0)return null;if(from<=0&&to<=0)continue;
   const t=from/(from-to);if(from>0)range[0]=Math.max(range[0],t);else range[1]=Math.min(range[1],t);
   if(range[0]>range[1])return null;
  }
  return range[0];
 }
 if(o.shape==='cylinder'||o.shape==='cone'||o.shape==='gem'||o.shape==='ico')return hitBody(p,q,{x:0,z:0,radius:Math.max(o.sx,o.sz)*(o.shape==='cylinder'||o.shape==='cone'?1:.65)+r,bottom:-o.sy/2-r,top:o.sy/2+r});
 for(const k of ['x','y','z'])if(!slab(p[k],q[k]-p[k],-o['s'+k]/2-r,o['s'+k]/2+r,range))return null;
 return range[0];
}
export function traceWorld(a,b,world,r=.04){
 let t=Infinity,kind='terrain';
 // The terrain is piecewise linear. Split at every grid/triangle boundary
 // so a fast round cannot skip a narrow ridge between frame endpoints.
 const cuts=[0,1];
 for(const [start,end] of [[a.x,b.x],[a.z,b.z],[a.x+a.z,b.x+b.z]]){
  if(Math.abs(end-start)<1e-10)continue;
  for(let n=Math.floor(Math.min(start,end))+1;n<Math.max(start,end);n++)cuts.push((n-start)/(end-start));
 }
 cuts.sort((x,y)=>x-y);
 let last=0,prev=a.y-world.height(a.x,a.z)-r;
 if(prev<=0)return {t:0,kind,...a};
 for(const at of cuts){if(at<=last)continue;const p=pointAt(a,b,at),clear=p.y-world.height(p.x,p.z)-r;if(clear<=0){t=Math.min(t,last+(at-last)*prev/(prev-clear));break}last=at;prev=clear}
 for(const cover of world.covers||[]){const hit=hitCover(a,b,cover,r);if(hit!==null&&hit<t){t=hit;kind='structure'}}
 return Number.isFinite(t)?{t,kind,...pointAt(a,b,t)}:null;
}
