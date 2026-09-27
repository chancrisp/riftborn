import * as T from 'three';
import {createMonster} from './monsters.js?v=10';

// Shared PS1 material pipeline: one atlas, affine UVs, snapped vertices and no PBR.
const pixels=new Uint8Array(64*64*4);
for(let i=0;i<64*64;i++){const v=155+((i*73^(i>>4)*37)%70);pixels.set([v,v,v,255],i*4)}
const fallback=new T.DataTexture(pixels,64,64);fallback.needsUpdate=true;
export const retroResolution=new T.Vector2(320,240);
const atlas=typeof document!=='undefined'&&document.createElementNS?new T.TextureLoader().load('./assets/ps1-atlas.png'):fallback;
atlas.magFilter=atlas.minFilter=T.NearestFilter;atlas.generateMipmaps=false;atlas.colorSpace=T.SRGBColorSpace;
export function retroMaterial(color='#ffffff',tile=3,{glow=0,vertexColors=false}={}){
 const mat=new T.MeshLambertMaterial({color:new T.Color(color).lerp(new T.Color('#ffffff'),.35),map:atlas,vertexColors,flatShading:true,emissive:color,emissiveIntensity:Math.min(glow,.55)});
 mat.onBeforeCompile=shader=>{
  shader.uniforms.retroResolution={value:retroResolution};shader.uniforms.atlasTile={value:new T.Vector2(tile%4,3-Math.floor(tile/4))};
  shader.vertexShader='uniform vec2 retroResolution; varying vec2 affineUV; varying float affineW;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
   float clipW=max(.01,gl_Position.w);
   gl_Position.xy=floor((gl_Position.xy/clipW)*retroResolution*.5+.5)/(retroResolution*.5)*clipW;
   affineUV=uv*clipW;affineW=clipW;`);
  shader.fragmentShader='uniform vec2 atlasTile; varying vec2 affineUV; varying float affineW;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`vec2 texel=floor(fract(affineUV/affineW)*64.0);
   vec2 atlasUV=(atlasTile+(texel+.5)/64.0)/4.0;
   diffuseColor*=texture2D(map,atlasUV);`);
 };
 mat.customProgramCacheKey=()=> 'ps1-affine-v1';
 return mat;
}
export const RetroShader={
 uniforms:{tDiffuse:{value:null}},
 vertexShader:'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
 fragmentShader:`uniform sampler2D tDiffuse; varying vec2 vUv;
 void main(){vec3 c=texture2D(tDiffuse,vUv).rgb;
  vec2 p=mod(floor(gl_FragCoord.xy),4.0);
  float a=mod(p.x,2.0)*2.0+mod(p.y,2.0)*3.0;
  float b=mod(floor(p.x/2.0),2.0)*2.0+mod(floor(p.y/2.0),2.0)*3.0;
  float d=(mod(a,4.0)*4.0+mod(b,4.0))/16.0-.5;
  c=floor(clamp(c+d/31.0,0.0,1.0)*31.0+.5)/31.0;
  gl_FragColor=vec4(c,1.0);
 }`
};

const cache=new Map();
function skin(color,tile){const key=color+tile;if(!cache.has(key))cache.set(key,retroMaterial(color,tile));return cache.get(key)}
const shapes={torso:new T.CylinderGeometry(.82,.6,1,6),limb:new T.CylinderGeometry(.7,.52,1,5),head:new T.SphereGeometry(1,6,4),boot:new T.BoxGeometry(1,1,1),plate:new T.PlaneGeometry(1,1),horn:new T.ConeGeometry(1,1,4)};
export function retroCharacter(kind,weaponModel){
 if(kind!=='player')return createMonster(kind,skin);
 const g=new T.Group(),body=new T.Group();g.add(body);
 const colors={player:['#9aaf9d','#d5c3ac'],runner:['#99807c','#afa293'],skitter:['#728363','#a0ac84'],gunner:['#baa17e','#c6b8a0'],charger:['#a97165','#c0a28b'],brute:['#80848e','#acb4ab'],mortar:['#6d829a','#afbdc0'],sniper:['#9c878b','#cab6a6'],leaper:['#aa8d64','#c8b691'],splitter:['#65948b','#94b0a2'],stormer:['#7885aa','#a4b6cb'],warden:['#8d779f','#c0b7cb']}[kind]||['#948879','#b0a18b'];
 function part(shape,color,tile,x,y,z,sx,sy,sz,parent=body){const m=new T.Mesh(shapes[shape],skin(color,tile));m.position.set(x,y,z);m.scale.set(sx,sy,sz);parent.add(m);return m}
 part('torso',colors[0],1,0,1.47,0,.52,.7,.36);
 part('torso','#666959',2,0,1.09,0,.46,.22,.34);
 part('head',colors[1],0,0,2.04,.015,.22,.28,.22);
 // Facial detail is texture-painted on the low-poly head, rather than a neon visor.
 part('plate',colors[1],12,0,2.025,.209,.32,.4,1);
 part('head',colors[0],2,0,2.24,-.02,.235,.12,.225);
 part('torso',colors[1],0,0,1.81,0,.15,.18,.15);
 const legs=[],arms=[];
 for(const side of [-1,1]){
  const leg=new T.Group();leg.position.set(side*.18,1.04,0);body.add(leg);legs.push(leg);
  part('limb','#777668',1,0,-.22,0,.22,.48,.23,leg);
  part('limb','#666b61',1,0,-.64,.02,.18,.4,.19,leg);
  part('boot','#74736a',2,0,-.93,.08,.22,.18,.38,leg);
  const arm=new T.Group();arm.position.set(side*.39,1.73,0);body.add(arm);arms.push(arm);
  part('limb',colors[0],1,0,-.21,0,.21,.43,.22,arm);
  part('limb',colors[0],1,0,-.53,.04,.16,.31,.17,arm);
  part('head',colors[1],0,0,-.73,.05,.1,.13,.1,arm);
 }
 part('boot','#777c6b',2,0,1.49,-.25,.43,.49,.2);
 part('boot','#bac0a1',3,-.16,1.62,.22,.1,.3,.035);
 const gunMount=new T.Group();gunMount.position.set(.34,1.47,.48);body.add(gunMount);
 const weapon=weaponModel(kind==='mortar'?4:kind==='sniper'?3:0,gunMount);
 gunMount.visible=['player','gunner','mortar','sniper','stormer','warden'].includes(kind);
 if(kind==='brute'){g.scale.set(1.6,1.5,1.6);for(const side of [-1,1])part('torso','#a5aaa2',3,side*.46,1.71,0,.3,.33,.4)}
 if(kind==='charger'||kind==='warden')for(const side of [-1,1]){const horn=part('horn','#c2b995',13,side*.2,2.44,0,.09,.49,.11);horn.rotation.z=-side*.35}
 if(kind==='warden'){g.scale.setScalar(2.5);part('torso','#67556e',11,0,1.5,-.25,.7,1.25,.18)}
 if(kind==='skitter'){g.scale.set(.8,.65,.95);body.rotation.x=.45}
 if(kind==='leaper')body.rotation.x=.2;
 return {g,body,legs,arms,gunMount,weapon};
}
