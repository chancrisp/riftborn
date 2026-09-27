// ELEVATION READABILITY — the exact collision mesh, with rock faces and upper ledge lips.
// This adds no obstacles and never alters terrain heights or projectile collision.
import * as T from 'three';
import {EXTENT,CELLS,MAX_WALK_SLOPE} from './terrain.js?v=17';
import {retroMaterial} from './retro.js?v=17';

export function createTerrainSurface(terrain,palette,random){
 const {low,high,trail}=palette,positions=[],colors=[],uvs=[],cliffUvs=[],flats=[],cliffs=[],lips=[],edges=new Map();
 const cLow=new T.Color(low),cHigh=new T.Color(high),cTrail=new T.Color(trail),white=new T.Color('#ffffff'),stride=CELLS+1;
 for(let iz=0;iz<=CELLS;iz++)for(let ix=0;ix<=CELLS;ix++){
  const x=ix-EXTENT,z=iz-EXTENT,y=terrain.heights[iz*stride+ix],route=terrain.routeAt(x,z);
  positions.push(x,y,z);uvs.push(x/6,z/6);cliffUvs.push((x+z)/4,y/3);
  const color=cLow.clone().lerp(cHigh,T.MathUtils.clamp((y+3)/14,0,1));
  // Wider, warmer ramp treads contrast with the cool, vertically textured rock sides.
  if(route.distance<2.8)color.lerp(cTrail,.72);
  color.lerp(white,.62).multiplyScalar(random(.92,1.07));colors.push(color.r,color.g,color.b);
 }
 const point=i=>({x:positions[i*3],y:positions[i*3+1],z:positions[i*3+2]});
 function lip(a,b,inside){
  const p=point(a),q=point(b),c=point(inside),dx=q.x-p.x,dz=q.z-p.z,length=Math.hypot(dx,dz);
  let nx=-dz/length,nz=dx/length;if(nx*(c.x-p.x)+nz*(c.z-p.z)<0){nx=-nx;nz=-nz}
  const v=[p,q,{x:p.x+nx*.18,z:p.z+nz*.18},{x:q.x+nx*.18,z:q.z+nz*.18}];
  // Shared edges arrive in either direction; keep every ribbon facing upward.
  const order=dx*nz-dz*nx>0?[0,2,1,1,2,3]:[0,1,2,1,3,2];
  for(const i of order)lips.push(v[i].x,terrain.height(v[i].x,v[i].z)+.035,v[i].z);
 }
 function triangle(a,b,c){
  const p=point(a),q=point(b),r=point(c),det=(q.x-p.x)*(r.z-p.z)-(r.x-p.x)*(q.z-p.z);
  const gx=((q.y-p.y)*(r.z-p.z)-(r.y-p.y)*(q.z-p.z))/det,gz=((q.x-p.x)*(r.y-p.y)-(r.x-p.x)*(q.y-p.y))/det;
  const steep=Math.hypot(gx,gz)>MAX_WALK_SLOPE;(steep?cliffs:flats).push(a,b,c);
  for(const [u,v,w] of [[a,b,c],[b,c,a],[c,a,b]]){
   const key=Math.min(u,v)*stride*stride+Math.max(u,v),old=edges.get(key);
   if(!old){edges.set(key,{steep,inside:w});continue}
   if(old.steep===steep)continue;
   const highPoint=steep?old.inside:w,lowPoint=steep?w:old.inside;
   // Only the upper rim gets a lip. Lower cliff feet do not masquerade as ramps.
   if(positions[highPoint*3+1]>positions[lowPoint*3+1]+.12)lip(u,v,highPoint);
  }
 }
 for(let z=0;z<CELLS;z++)for(let x=0;x<CELLS;x++){const a=z*stride+x,b=a+1,c=a+stride,d=c+1;triangle(a,c,b);triangle(b,c,d)}
 const ground=new T.BufferGeometry();ground.setAttribute('position',new T.Float32BufferAttribute(positions,3));ground.setAttribute('color',new T.Float32BufferAttribute(colors,3));ground.setAttribute('uv',new T.Float32BufferAttribute(uvs,2));ground.setAttribute('cliffUv',new T.Float32BufferAttribute(cliffUvs,2));ground.setIndex([...flats,...cliffs]);ground.addGroup(0,flats.length,0);ground.addGroup(flats.length,cliffs.length,1);ground.computeVertexNormals();
 const top=retroMaterial('#d0cab4',terrain.tutorial?5:[4,5,8,10,11][terrain.stage-1],{vertexColors:true,occlusion:true});
 const rock=retroMaterial(['#5a6358','#465567','#483a44','#42546b','#4b3b61'][terrain.stage-1],terrain.stage===3?8:terrain.stage===5?11:5,{vertexColors:true,occlusion:true});
 const compile=rock.onBeforeCompile;rock.onBeforeCompile=shader=>{compile(shader);shader.vertexShader='attribute vec2 cliffUv;\n'+shader.vertexShader.replace('affineUV=uv*clipW;','affineUV=cliffUv*clipW;')};rock.customProgramCacheKey=()=> 'ps1-rock-face-v1';
 const surface=new T.Mesh(ground,[top,rock]);surface.receiveShadow=true;
 const lipGeometry=new T.BufferGeometry();lipGeometry.setAttribute('position',new T.Float32BufferAttribute(lips,3));lipGeometry.setAttribute('uv',new T.Float32BufferAttribute(Array(lips.length/3*2).fill(0),2));lipGeometry.computeVertexNormals();
 const lipMaterial=retroMaterial(trail,5,{occlusion:true}),ledge=new T.Mesh(lipGeometry,lipMaterial);ledge.name='terrain-upper-edges';ledge.visible=lips.length>0;
 return {surface,ledge,drawCalls:(flats.length?1:0)+(cliffs.length?1:0)+(lips.length?1:0),dispose(){ground.dispose();top.dispose();rock.dispose();lipGeometry.dispose();lipMaterial.dispose()}};
}
