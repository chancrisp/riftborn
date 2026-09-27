import assert from 'node:assert/strict';
import {CampaignSequence,EncounterPacing,movementResponse} from '../dist/campaign.js';
const scene=new CampaignSequence('maw');let completed=0;
for(let i=0;i<400;i++)if(scene.tick(1/60))completed++;
assert.equal(completed,1);assert.equal(scene.skip(),false);
const paused=new CampaignSequence('victory');paused.paused=true;paused.tick(100);assert.equal(paused.age,0);assert.equal(paused.skip(),true);assert.equal(paused.skip(),false);
const pace=new EncounterPacing();assert.equal(pace.allowSpawns(false),false);pace.tick(3);assert.equal(pace.allowSpawns(false),true);pace.recover(6);pace.tick(2);assert.equal(pace.allowSpawns(true),false);pace.tick(4);assert.equal(pace.allowSpawns(true),true);
pace.age=27;assert.equal(pace.allowSpawns(false),false);assert.equal(pace.allowSpawns(true),true,'A trial owns its pressure, without periodic ambient breaks');
let v={x:6.4,z:0};for(let i=0;i<12;i++)v=movementResponse(v,{x:0,z:0},1/60);assert.ok(v.x<.04,'Release should stop drift quickly');
for(const hz of [30,60,120]){let r={x:0,z:0};for(let i=0;i<hz;i++)r=movementResponse(r,{x:6.4,z:0},1/hz);assert.ok(r.x<=6.4&&r.x>6.39)}
console.log('PASS campaign flow: bounded single-completion sequences, pause/skip, encounter rests and stable movement response.');
