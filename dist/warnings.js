import * as T from 'three';
// Geometry sits on the sampled terrain. Only opacity changes: the danger boundary
// never pulses inward while the damaging radius stays fixed.
export function dangerMarker(height,x,z,radius,kind='blast',path=null,width=.3){
 const vertices=[];
 const tri=(a,b,c)=>{for(const p of [a,b,c])vertices.push(p[0],height(p[0],p[1])+.13,p[1])};
 const strip=(a,b,w)=>{const d=Math.hypot(b[0]-a[0],b[1]-a[1])||1,n=[-(b[1]-a[1])/d*w,(b[0]-a[0])/d*w],p=[a[0]+n[0],a[1]+n[1]],q=[a[0]-n[0],a[1]-n[1]],r=[b[0]+n[0],b[1]+n[1]],s=[b[0]-n[0],b[1]-n[1]];tri(p,q,r);tri(q,s,r)};
 if(path){for(let i=1;i<path.length;i++){
   const a=path[i-1],b=path[i],d=Math.hypot(b[0]-a[0],b[1]-a[1]);if(d<.001)continue;
   if(width<.2){strip(a,b,width);continue}
   const nx=-(b[1]-a[1])/d*width,nz=(b[0]-a[0])/d*width;
   for(const side of [-1,1])strip([a[0]+nx*side,a[1]+nz*side],[b[0]+nx*side,b[1]+nz*side],.065);
   if(i===1||i===path.length-1)strip([b[0]+nx,b[1]+nz],[b[0]-nx,b[1]-nz],.065);
   if(i%8===0){strip([a[0]+nx*.45,a[1]+nz*.45],b,.06);strip([a[0]-nx*.45,a[1]-nz*.45],b,.06)}
  }}
 else{
  for(let i=0;i<64;i++){const a=i*Math.PI/32,b=(i+1)*Math.PI/32;strip([x+Math.sin(a)*radius,z+Math.cos(a)*radius],[x+Math.sin(b)*radius,z+Math.cos(b)*radius],.085)}
  // Crosshairs mark aimed blasts, spokes mark projectile emitters, double rings slams.
  const spokes=['mortar','hex','warden-node'].includes(kind)?4:['salvo','warden-ring'].includes(kind)?8:0;
  for(let i=0;i<spokes;i++){const a=i*2*Math.PI/spokes;strip([x+Math.sin(a)*radius*.25,z+Math.cos(a)*radius*.25],[x+Math.sin(a)*radius*.83,z+Math.cos(a)*radius*.83],.07)}
  if(!spokes)for(let i=0;i<32;i++){const a=i*Math.PI/16,b=(i+1)*Math.PI/16;strip([x+Math.sin(a)*radius*.8,z+Math.cos(a)*radius*.8],[x+Math.sin(b)*radius*.8,z+Math.cos(b)*radius*.8],.045)}
 }
 const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));geometry.computeVertexNormals();
 const material=new T.MeshBasicMaterial({color:kind==='salvo'||kind==='warden-ring'?'#c2bbdb':'#e2ba86',transparent:true,opacity:.72,side:T.DoubleSide,depthWrite:false,depthTest:false,fog:false});
 const mesh=new T.Mesh(geometry,material);mesh.renderOrder=12;mesh.userData.danger=true;mesh.userData.radius=radius;mesh.userData.path=path;return mesh;
}
export function disposeMarker(m){if(!m)return;m.removeFromParent();m.geometry.dispose();m.material.dispose()}
// Predict with the exact movement solver and fixed step. A cover callback handles
// Iron Maw's special collision stop; ordinary chargers may slide along terrain.
export function chargePath(e,speed,duration,terrain,stop=()=>false){
 const p={x:e.x,z:e.z},points=[[p.x,p.z]],steps=Math.ceil(duration*60);
 for(let i=0;i<steps;i++){const dt=Math.min(1/60,duration-i/60),dx=e.ax*speed*dt,dz=e.az*speed*dt;if(stop(p,dx,dz))break;terrain.move(p,dx,dz,e.def.radius);points.push([p.x,p.z])}
 return points;
}
