import assert from 'node:assert/strict';
import {loadPreferences} from '../dist/preferences.js';
const defaults=loadPreferences(null);
assert.equal(defaults.pixelation,'auto');assert.equal(defaults.fog,50);assert.equal(defaults.fpsCap,60);
const stored=loadPreferences({getItem:()=>JSON.stringify({pixelation:160,fog:0,fpsCap:30,timeOfDay:'night',master:25})});
assert.equal(stored.pixelation,160);assert.equal(stored.fog,0);assert.equal(stored.fpsCap,30);assert.equal(stored.master,25);
const bad=loadPreferences({getItem:()=>JSON.stringify({pixelation:9000,fog:-30,fpsCap:-10})});
assert.equal(bad.pixelation,'auto');assert.equal(bad.fog,0);assert.equal(bad.fpsCap,60);
const {renderHeight,fogRange,FramePacer}=await import('../dist/graphics.js');
assert.equal(renderHeight('auto',false,false),320);assert.equal(renderHeight('auto',true,false),240);assert.equal(renderHeight('auto',false,true),240);
assert.equal(renderHeight(480,false,true),480,'An explicit pixelation choice is never silently overridden');
assert.ok(fogRange(0,true).near>200);assert.ok(fogRange(100,true).far<fogRange(50,true).far);assert.ok(fogRange(50,true).near>=36);assert.ok(fogRange(50,true).far<80);assert.ok(fogRange(100,true,50).near>=53,'Zoomed-out player remains before the fog');
assert.equal(defaults.nightmare,false);assert.equal(stored.nightmare,false,'Legacy Night Mode retires to normal');assert.equal(loadPreferences({getItem:()=>JSON.stringify({nightmare:true})}).nightmare,true);
for(const cap of [30,60,120,0]){const pacer=new FramePacer();let frames=0;for(let i=0;i<1440;i++)if(pacer.ready(i*1000/144,cap))frames++;assert.ok(Math.abs(frames-(cap||144)*10)<=1,`Frame cap ${cap} at 144Hz: ${frames}`)}
const pacer=new FramePacer();assert.equal(pacer.ready(0,30),true);assert.equal(pacer.ready(10,30),false);assert.equal(pacer.ready(10000,30),true);assert.equal(pacer.ready(10001,30),false,'No render burst after backgrounding');
console.log('PASS: saved graphics defaults and validation, explicit pixelation, fog ranges, and FPS caps independent of simulation.');

const {createStorm}=await import('../dist/storm.js');
for(const reduced of [false,true]){const storm=createStorm({reduced,mobile:true});storm.setEnabled(true);let thunder=0,maxLight=0;for(let i=0;i<1000;i++){thunder+=Number(storm.update(.04,i*.04,{x:i*.1,z:0},3));maxLight=Math.max(maxLight,storm.light.intensity)}assert.ok(thunder>=2);assert.equal(storm.count,360);assert.ok(storm.rain.geometry.attributes.position.array.every(Number.isFinite));if(reduced)assert.equal(maxLight,0);else assert.ok(maxLight>0);storm.setEnabled(false);assert.equal(storm.group.visible,false);assert.equal(storm.light.intensity,0);storm.dispose()}
console.log('PASS: bounded storm geometry, multiple thunder cycles, reduced-motion lightning suppression and clean disable.');
