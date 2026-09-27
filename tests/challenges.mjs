import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.ok(fs.existsSync('dist/challenges.js'),'Required encounters need explicit attack lifecycle');
const {NodeCharge,quarryImpact,anchorMultiplier}=await import('../dist/challenges.js');
const event=new NodeCharge(['a','b']);event.destroy('a');assert.equal(event.tick(1),'charging');event.destroy('b');assert.equal(event.tick(1),'interrupted');assert.equal(event.tick(20),'interrupted');
const ignored=new NodeCharge(['a','b']);assert.equal(ignored.tick(7),'attack');assert.equal(ignored.tick(1),'attack');
assert.equal(quarryImpact('approach',{kind:'structure'}),false);assert.equal(quarryImpact('charge',{kind:'terrain'}),false);assert.equal(quarryImpact('charge',{kind:'structure'}),true);
assert.equal(anchorMultiplier(3),.4);assert.equal(anchorMultiplier(1),.8);assert.equal(anchorMultiplier(0),1);
console.log('PASS encounters: node deadline/interruption and charge-only cover stagger.');
