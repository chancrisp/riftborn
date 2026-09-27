import assert from 'node:assert/strict';
import * as T from 'three';
import {cutaway,updateCutaway} from '../dist/occlusion.js';
import {retroMaterial} from '../dist/retro.js';
import {createTerrain} from '../dist/terrain.js';
import {buildStageWorld} from '../dist/scenery.js';
import {traceWorld} from '../dist/ballistics.js';
const camera=new T.PerspectiveCamera(47,1,.1,230);camera.position.set(0,20,25);camera.lookAt(0,1,0);camera.updateMatrixWorld();
updateCutaway(camera,{x:0,y:0,z:0},1,true);assert.ok(cutaway.strength.value>.99);assert.ok(cutaway.depth.value>0);updateCutaway(camera,{x:0,y:0,z:0},1,false);assert.ok(cutaway.strength.value<.001);
const compile=mat=>{const s={uniforms:{},vertexShader:'#include <project_vertex>',fragmentShader:'#include <map_fragment>\n#include <dithering_fragment>'};mat.onBeforeCompile(s);return s};
assert.ok(compile(retroMaterial('#fff',3,{occlusion:true})).fragmentShader.includes('cutawayDepth'));
assert.ok(!compile(retroMaterial()).fragmentShader.includes('cutawayDepth'));
for(let stage=1;stage<=5;stage++){
 const t=createTerrain(stage,7361),w=buildStageWorld(t),before=JSON.stringify(w.covers),obstacles=JSON.stringify(t.obstacles),calls=w.drawCalls;
 const a={x:0,y:2,z:0},b={x:20,y:2,z:20},hit=traceWorld(a,b,{height:t.height,covers:w.covers});
 for(let i=0;i<120;i++)updateCutaway(camera,{x:i/10,y:0,z:0},1/60,true);
 assert.equal(JSON.stringify(w.covers),before);assert.equal(JSON.stringify(t.obstacles),obstacles);assert.deepEqual(traceWorld(a,b,{height:t.height,covers:w.covers}),hit);assert.equal(w.drawCalls,calls);w.dispose();
}
console.log('PASS cutaway: restoration, scenery-only shader, five-stage collision/targeting data and draw-call parity.');
