import * as T from 'three';
// Constant CPU work: three projections, no raycasts or material/instance cloning.
// The fragment shader handles only foreground pixels inside the hero's aperture.
export const cutaway={center:{value:new T.Vector2()},radius:{value:new T.Vector2()},depth:{value:0},floor:{value:0},strength:{value:0}};
const chest=new T.Vector3(),edge=new T.Vector3(),top=new T.Vector3(),view=new T.Vector3();
export function updateCutaway(camera,p,dt,enabled=true){
 camera.updateMatrixWorld();chest.set(p.x,p.y+1.2,p.z);view.copy(chest).applyMatrix4(camera.matrixWorldInverse);
 edge.setFromMatrixColumn(camera.matrixWorld,0).multiplyScalar(1.7).add(chest).project(camera);
 top.copy(chest);top.y+=2.1;top.project(camera);chest.project(camera);
 cutaway.center.value.set(chest.x*.5+.5,chest.y*.5+.5);
 cutaway.radius.value.set(Math.max(.008,Math.abs(edge.x-chest.x)*.5),Math.max(.012,Math.abs(top.y-chest.y)*.7));
 cutaway.depth.value=-view.z-.6;cutaway.floor.value=p.y+.25;
 const target=enabled&&view.z<0?1:0;cutaway.strength.value+=(target-cutaway.strength.value)*(1-Math.exp(-dt*12));
}
export function cutawayShader(shader){
 for(const [name,u] of Object.entries(cutaway))shader.uniforms['cutaway'+name[0].toUpperCase()+name.slice(1)]=u;
 shader.vertexShader='varying float sceneryDepth; varying float sceneryHeight;\n'+shader.vertexShader;
 shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
 sceneryDepth=-mvPosition.z;
 vec4 sceneryWorld=vec4(transformed,1.0);
 #ifdef USE_INSTANCING
 sceneryWorld=instanceMatrix*sceneryWorld;
 #endif
 sceneryHeight=(modelMatrix*sceneryWorld).y;`);
 shader.fragmentShader=`uniform vec2 cutawayCenter; uniform vec2 cutawayRadius;
 uniform float cutawayDepth; uniform float cutawayFloor; uniform float cutawayStrength;
 uniform vec2 retroResolution; varying float sceneryDepth; varying float sceneryHeight;
 `+shader.fragmentShader;
 shader.fragmentShader=shader.fragmentShader.replace('#include <dithering_fragment>',`#include <dithering_fragment>
 float aperture=length((gl_FragCoord.xy/retroResolution-cutawayCenter)/cutawayRadius);
 if(sceneryDepth<cutawayDepth && sceneryHeight>cutawayFloor){
  float fade=(1.0-smoothstep(.65,1.0,aperture))*cutawayStrength;
  float checker=mod(floor(gl_FragCoord.x)+2.0*floor(gl_FragCoord.y),4.0);
  if(checker<fade*3.0)discard;
 }`);
}
