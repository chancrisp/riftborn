import assert from 'node:assert/strict';
import {CombatEffects} from '../dist/combat-effects.js';
import {createBuild,BALANCE as B} from '../dist/progression.js';
const build=createBuild();build.mods=[0,1,2,3,4];let procs=[],targets=[],secondary=[],damage=[],explosions=0,blocked=false;
const fx=new CombatEffects({event:type=>procs.push(type),build:()=>build,targets:()=>targets,clear:()=>!blocked,center:e=>({x:e.x,y:1,z:e.z}),secondary(...s){secondary.push(s);return true},damage(e,n){damage.push(n);e.hp-=n},flash(){},line:()=>({}),lineUpdate(){},remove(){},orb:()=>({}),explode(){explosions++},hit:()=>!blocked,move(e,x,z){if(!blocked){e.x+=x;e.z+=z}}});
const bullet=(weapon)=>({sourceWeapon:weapon,generation:0,group:{},origin:{x:0,z:0},damage:100,vx:0,vy:0,vz:20});const p={x:0,y:1,z:2},enemy={id:1,x:0,z:2,hp:100};
const rifle=bullet(0);fx.hit(rifle,enemy,p,false);fx.hit(rifle,enemy,p,false);assert.equal(secondary.length,2);fx.hit({...rifle,generation:1},enemy,p,false);assert.equal(secondary.length,2);
targets=[{id:2,x:1,z:2,hp:1000},{id:3,x:2,z:2,hp:1000},{id:4,x:3,z:2,hp:1000}];
for(let i=0;i<7;i++){const b=bullet(1);fx.hit(b,enemy,p,false);fx.hit({...b},enemy,p,false)}assert.equal(build.charge,0);assert.equal(damage.length,3,'One charge per trigger, bounded chain');
blocked=true;for(let i=0;i<7;i++)fx.hit(bullet(1),enemy,p,false);assert.equal(damage.length,3,'Chain cannot cross cover');blocked=false;
secondary=[];const scatter=bullet(2);fx.hit(scatter,enemy,p,true);fx.hit({...scatter},enemy,p,true);assert.equal(secondary.length,B.graveFragments,'One bone cone per original volley');
for(let i=0;i<50;i++)fx.travel(bullet(3),p,{...p,z:5});assert.equal(fx.scars.length,B.maxScars);const before=damage.length;fx.tick(.01);assert.equal(damage.length-before,targets.length,'Overlapping scars share one cooldown per target');const first=damage.length;fx.tick(.01);assert.equal(damage.length,first,'Scar tick rate bounded');fx.tick(2);assert.equal(fx.scars.length,0);
const boss={id:5,x:2,z:2,hp:1000,kind:'warden'};targets=[boss,{id:6,x:3,z:2,hp:100}];const rocket=bullet(4);fx.impact(rocket,p);fx.impact(rocket,p);assert.equal(fx.pulls.length,1);fx.tick(.1);assert.equal(boss.x,2);assert.ok(targets[1].x<3);fx.tick(.4);assert.equal(explosions,1);fx.tick(2);assert.equal(explosions,1);
fx.impact(bullet(4),p);fx.clear();fx.tick(2);assert.equal(explosions,1,'Cleanup cannot detonate pending pulls');
console.log('PASS five mods: trigger accounting, recursion bounds, cover, scar limits/ticks, pull resistance and cleanup.');

for(const key of ['splinter','storm','stormEmpty','grave','scar','pull','detonate'])assert.ok(procs.includes(key),key+' actual event cue');
