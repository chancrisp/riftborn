import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.ok(fs.existsSync('dist/dash-traits.js'),'Dash traits must have bounded, pausable lifecycle');
const {DashEffects}=await import('../dist/dash-traits.js');
let trait='echo',echoes=[],valid=true;const d=new DashEffects({trait:()=>trait,valid:()=>valid,line:()=>({}),ghost:()=>({}),remove(){},fire:(...args)=>echoes.push(args)});
d.begin({x:0,y:1,z:0});assert.equal(echoes.length,0,'Dash cannot fire');d.shot({x:10,y:2,z:10},{weapon:2,count:8});d.shot({x:0,y:0,z:0},{});assert.equal(echoes.length,1);assert.equal(echoes[0][2].count,8);assert.equal(echoes[0][1].x,10);
d.begin({x:0,y:1,z:0});d.tick(2.1);d.shot({},{});assert.equal(echoes.length,1);valid=false;d.begin({x:0,y:1,z:0});d.shot({},{});assert.equal(echoes.length,1);
trait='wake';valid=true;for(let i=0;i<100;i++)d.record({x:i,y:1,z:0},{x:i+1,y:1,z:0});assert.ok(d.wake.length<=24);assert.equal(d.slow({x:99,z:0}),.6);assert.equal(d.slow({x:99,z:0,kind:'warden'}),1);d.clear();assert.equal(d.wake.length,0);assert.equal(d.echo,null);
console.log('PASS dash traits: manual volley echo, shared target, expiry, obstruction, wake caps/resistance and cleanup.');
