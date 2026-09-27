import assert from 'node:assert/strict';
import {createTerrain,MAX_WALK_SLOPE,randomSource} from '../dist/terrain.js';
import {createTerrainSurface} from '../dist/terrain-visuals.js';
// Rendering tags the same actual faces that traversal rejects; geometry remains exact.
for(let stage=1;stage<=5;stage++){
 const terrain=createTerrain(stage,7919),before=terrain.heights.slice(),view=createTerrainSurface(terrain,{low:'#456056',high:'#889981',trail:'#c4baa0'},randomSource(4));
 const g=view.surface.geometry,p=g.attributes.position,index=g.index;
 assert.ok(g.groups[0].count>0&&g.groups[1].count>0,'Both treads and cliffs remain in each world');
 for(const group of g.groups)for(let offset=group.start;offset<group.start+group.count;offset+=3){
  let x=0,z=0;for(let n=0;n<3;n++){const v=index.getX(offset+n);x+=p.getX(v)/3;z+=p.getZ(v)/3;assert.ok(Math.abs(p.getY(v)-terrain.height(p.getX(v),p.getZ(v)))<.0001)}
  assert.equal(terrain.surfaceSlope(x,z)>MAX_WALK_SLOPE,group.materialIndex===1,'Rock styling matches collision slope');
 }
 assert.deepEqual(terrain.heights,before);assert.ok(view.ledge.geometry.attributes.position.count>0);assert.equal(view.drawCalls,3);
 assert.ok(view.ledge.geometry.attributes.position.array.every(Number.isFinite));assert.notEqual(view.surface.material[0].color.getHex(),view.surface.material[1].color.getHex());
 for(let i=0;i<view.ledge.geometry.attributes.normal.count;i++)assert.ok(view.ledge.geometry.attributes.normal.getY(i)>0,'Upper rims face the overhead camera');
 view.dispose();
}
console.log('PASS terrain readability: five exact surfaces, cliff/slope agreement, upper rims and bounded three-call rendering.');
