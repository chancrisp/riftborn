import * as T from 'three';
import {retroMaterial} from './retro.js?v=9';
import {EXTENT,CELLS,randomSource} from './terrain.js?v=9';

// Static scenery is batched by geometry/material: silhouettes without hundreds of draw calls.
export function buildStageWorld(terrain){
 const covers=[];
 const group=new T.Group(),rng=randomSource(terrain.seed+terrain.stage*3571),s=terrain.stage;
 const palettes=[['#497c57','#75915f','#bac1a0'],['#424c66','#687992','#b3b0a1'],['#372d40','#6d3948','#b77561'],['#273958','#546d91','#a5bcd1'],['#241e48','#503b76','#9e83b6']];
 const [low,high,trail]=palettes[s-1],batches=new Map(),geometries={box:new T.BoxGeometry(1,1,1),ico:new T.IcosahedronGeometry(1,0),cone:new T.ConeGeometry(1,1,6),cylinder:new T.CylinderGeometry(1,1,1,8),gem:new T.OctahedronGeometry(1,0)};
 const hulls=Object.fromEntries(Object.entries(geometries).map(([shape,geometry])=>{
  geometry.computeBoundingBox();const pos=geometry.attributes.position,index=geometry.index,planes=new Map();
  for(let i=0;i<(index?.count??pos.count);i+=3){
   const vertex=j=>new T.Vector3().fromBufferAttribute(pos,index?index.getX(i+j):i+j),a=vertex(0),b=vertex(1),c=vertex(2),n=b.sub(a).cross(c.sub(a)).normalize();
   if(n.lengthSq()<.5)continue;const w=n.dot(a),key=[n.x,n.y,n.z,w].map(v=>v.toFixed(5)).join(',');planes.set(key,{x:n.x,y:n.y,z:n.z,w});
  }
  return [shape,{min:geometry.boundingBox.min,max:geometry.boundingBox.max,planes:[...planes.values()]}];
 }));
 const ground=new T.BufferGeometry(),positions=[],colors=[],uvs=[],indices=[],cLow=new T.Color(low),cHigh=new T.Color(high),cTrail=new T.Color(trail);
 for(let iz=0;iz<=CELLS;iz++)for(let ix=0;ix<=CELLS;ix++){const x=ix-EXTENT,z=iz-EXTENT,y=terrain.heights[iz*(CELLS+1)+ix],route=terrain.routeAt(x,z);positions.push(x,y,z);uvs.push(x/6,z/6);const c=cLow.clone().lerp(cHigh,T.MathUtils.clamp((y+3)/14,0,1));if(route.distance<2.1)c.lerp(cTrail,.42);c.lerp(new T.Color('#ffffff'),.62).multiplyScalar(rng(.92,1.07));colors.push(c.r,c.g,c.b)}
 for(let z=0;z<CELLS;z++)for(let x=0;x<CELLS;x++){const a=z*(CELLS+1)+x,b=a+1,c=a+CELLS+1,d=c+1;indices.push(a,c,b,b,c,d)}
 ground.setAttribute('uv',new T.Float32BufferAttribute(uvs,2));ground.setAttribute('position',new T.Float32BufferAttribute(positions,3));ground.setAttribute('color',new T.Float32BufferAttribute(colors,3));ground.setIndex(indices);ground.computeVertexNormals();
 const groundMat=retroMaterial('#d0cab4',[4,5,8,10,11][s-1],{vertexColors:true}),surface=new T.Mesh(ground,groundMat);surface.receiveShadow=true;group.add(surface);
 function add(shape,color,x,y,z,sx,sy,sz,glow=0,rotation=0){if(sy>.35&&Math.hypot(x,z)<75)covers.push({shape,x,y,z,sx,sy,sz,rotation,hull:hulls[shape]});const key=shape+color+glow;if(!batches.has(key))batches.set(key,{shape,color,glow,items:[]});batches.get(key).items.push({x,y,z,sx,sy,sz,rotation})}
 function allowed(x,z,r){return Math.hypot(x,z)>11&&Math.hypot(x,z)<63&&terrain.routeAt(x,z).distance>5.7+r&&Math.hypot(x-terrain.points[0][0],z-terrain.points[0][1])>9+r&&terrain.clear(x,z,r+.8)}
 function block(x,z,sx,sz,h,color){const y=terrain.height(x,z);add('box',color,x,y+h/2,z,sx,h,sz);terrain.obstacles.push({x,z,sx,sz});return y}
 function structureSites(){const sites=[];for(let z=-48;z<=48;z+=4)for(let x=-48;x<=48;x+=4){if(Math.hypot(x,z)<17||!allowed(x,z,4))continue;const y=terrain.height(x,z);if(Math.abs(terrain.height(x-3,z)-y)<.7&&Math.abs(terrain.height(x+3,z)-y)<.7)sites.push([x,z])}return sites.sort((a,b)=>Math.hypot(...a)-Math.hypot(...b))}
 // Each stage owns its terrain, skyline and architectural vocabulary.
 if(s===1){
  let ruins=0;for(const [x,z] of structureSites()){if(!allowed(x,z,4))continue;const y=terrain.height(x,z);for(const d of [-2.2,2.2]){block(x+d,z,1.1,1.6,4.2+y-terrain.height(x+d,z),'#a5aba0');add('box','#bdc5ad',x+d,y+4.5,z,1.6,.4,2)}add('box','#8c9795',x,y+5,z,6,.8,1.6);if(++ruins===3)break}
  for(let i=0;i<95;i++){const x=rng(-65,65),z=rng(-65,65),k=rng(.8,1.5);if(!allowed(x,z,1.5))continue;const y=terrain.height(x,z);add('cylinder','#66503d',x,y+1.8*k,z,.3*k,3.6*k,.3*k);for(let j=0;j<3;j++)add('cone',['#245c51','#327464','#529076'][j],x,y+(3+j*.95)*k,z,(2-j*.35)*k,2.6*k,(2-j*.35)*k);terrain.obstacles.push({x,z,r:.5*k})}
 }else if(s===2){
  let gantries=0;for(const [x,z] of structureSites()){if(!allowed(x,z,4))continue;const y=terrain.height(x,z);for(const d of [-3,3])block(x+d,z,1,2,8+y-terrain.height(x+d,z),'#354556');add('box','#c7a66d',x,y+8.3,z,8,.7,1.4);add('box','#506e7d',x+1,y+5.8,z,.25,4,.25);if(++gantries===2)break}
  for(let i=0;i<65;i++){const x=rng(-63,63),z=rng(-63,63),w=rng(2,5);if(!allowed(x,z,w))continue;const h=rng(2,7),y=block(x,z,w,w*.8,h,'#546078');add('box','#8e9baf',x,y+h+.2,z,w+ .3,.4,w*.85)}
 }else if(s===3){
  for(let i=0;i<70;i++){const x=rng(-65,65),z=rng(-65,65);if(!allowed(x,z,2.5))continue;const y=terrain.height(x,z),h=rng(2,8);add('cylinder','#443748',x,y+h/2,z,1.4,h,1.4);add('gem','#f19a58',x,y+h+.2,z,.55,1.3,.55,1.8);terrain.obstacles.push({x,z,r:1.5})}
  for(let i=0;i<40;i++){const x=rng(-62,62),z=rng(-62,62);if(!allowed(x,z,2.8)||terrain.height(x,z)>2)continue;const y=block(x,z,4,3,.25,'#8f4039');add('box','#ff7744',x,y+.27,z,3.6,.08,2.6,1.8)}
 }else if(s===4){
  for(let i=0;i<60;i++){const x=Math.round(rng(-58,58)/8)*8,z=Math.round(rng(-58,58)/8)*8;if(!allowed(x,z,3))continue;const tower=i%3===0,h=tower?rng(8,13):rng(2,4),y=block(x,z,3.5,3.5,h,'#405978');add('box','#b4cddd',x,y+h,z,4.1,.4,4.1);if(tower){for(const d of [-1.4,1.4])add('box','#6e91b0',x+d,y+h+.8,z,.65,1.4,3.5);add('gem','#83e7ff',x,y+h+1.6,z,.35,1,.35,2)}}
 }else{
  for(let i=0;i<58;i++){const x=rng(-65,65),z=rng(-65,65);if(!allowed(x,z,3))continue;const h=rng(3,9),y=terrain.height(x,z);add('gem','#54437a',x,y+h/2,z,2,h,2);terrain.obstacles.push({x,z,r:2});add('gem','#ba80ef',x,y+h+2,z,.7,1.8,.7,2,rng(0,6));if(i%3===0)add('box','#35294e',x,y+h+5,z,5,.8,4,0,rng(0,3))}
 }
 // Stage-specific distant silhouettes; never place collision-free scenery in the arena.
 for(let i=0;i<24;i++){const a=i*Math.PI/12,r=rng(86,113),x=Math.cos(a)*r,z=Math.sin(a)*r,h=rng(14,34);add(s===4?'box':s===5?'gem':s===3?'cone':'ico',low,x,s===5?8:-3,z,rng(7,15),h,rng(7,15),0,a)}
 // Low marker stones make the traversable ramps readable without covering their surface.
 for(const [a,b] of terrain.routes){const length=Math.hypot(b[0]-a[0],b[1]-a[1]);for(let d=4;d<length;d+=5){const t=d/length,x=T.MathUtils.lerp(a[0],b[0],t),z=T.MathUtils.lerp(a[1],b[1],t),nx=-(b[1]-a[1])/length,nz=(b[0]-a[0])/length;for(const side of [-1,1]){const px=x+nx*3*side,pz=z+nz*3*side;add('box',trail,px,terrain.height(px,pz)+.07,pz,.28,.14,.28,s===5?.5:0)}}}
 const dummy=new T.Object3D(),materials=[];
 for(const {shape,color,glow,items} of batches.values()){const mat=retroMaterial(color,shape==='cone'&&s===1?14:shape==='cylinder'&&s===1?7:glow&&s===3?9:[5,6,8,10,11][s-1],{glow});materials.push(mat);const m=new T.InstancedMesh(geometries[shape],mat,items.length);items.forEach((p,i)=>{dummy.position.set(p.x,p.y,p.z);dummy.scale.set(p.sx,p.sy,p.sz);dummy.rotation.set(0,p.rotation,0);dummy.updateMatrix();m.setMatrixAt(i,dummy.matrix)});m.castShadow=true;m.receiveShadow=true;m.computeBoundingSphere();group.add(m)}
 terrain.rebuildNavigation();
 return {group,surface,covers,drawCalls:batches.size+1,dispose(){group.removeFromParent();ground.dispose();groundMat.dispose();Object.values(geometries).forEach(g=>g.dispose());materials.forEach(m=>m.dispose());group.traverse(o=>{if(o.isInstancedMesh)o.dispose()})}};
}
