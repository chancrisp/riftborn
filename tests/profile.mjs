import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.ok(fs.existsSync('dist/profile.js'),'Local profile must be versioned and resilient');
const {loadProfile,saveProfile,award,recordEnemy,equipCosmetic,rememberRun,PROFILE_KEY}=await import('../dist/profile.js');
for(const value of [null,'broken','null','[]','{"version":0,"lastUsername":"Ash"}','{"version":1,"milestones":null}']){const p=loadProfile({getItem:()=>value});assert.equal(p.version,1);assert.ok(p.enemies)}
const p=loadProfile(null);assert.equal(award(p,'trial',false),false);assert.equal(award(p,'trial',true),true);assert.equal(award(p,'trial',true),false);assert.equal(equipCosmetic(p,'badge','skull'),true);assert.equal(equipCosmetic(p,'trail','ember'),false);award(p,'warden',true);assert.equal(equipCosmetic(p,'trail','ember'),true);
recordEnemy(p,'skitter',true,false);assert.equal(p.enemies.skitter,undefined);recordEnemy(p,'skitter',false,true);recordEnemy(p,'skitter',true,true);assert.equal(p.enemies.skitter.defeated,1);
let saved;assert.equal(saveProfile({setItem:(k,v)=>{assert.equal(k,PROFILE_KEY);saved=v}},p),true);assert.equal(loadProfile({getItem:()=>saved}).cosmetics.trail,'ember');assert.equal(saveProfile({setItem(){throw Error('full')}},p),false);assert.equal(loadProfile({getItem(){throw Error('blocked')}}).version,1);
rememberRun(p,{id:'a',score:100,death_mode:true});rememberRun(p,{id:'a',score:100,death_mode:true});assert.equal(p.runs.length,1);
console.log('PASS profile: migration, malformed/unavailable/full storage, isolated progress, unlock/equip and result deduplication.');

rememberRun(p,{id:'best',name:'Ash',score:10000,death_mode:false,gameplay_version:'builds-1'});for(let i=0;i<60;i++)rememberRun(p,{id:String(i),name:'Ash',score:10,death_mode:false,gameplay_version:'builds-1'});assert.equal(p.runs.length,50);assert.equal(p.scoreBests['builds-1:normal'],10000);
