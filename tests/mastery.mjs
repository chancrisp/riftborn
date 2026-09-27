import assert from 'node:assert/strict';
import {loadProfile,saveProfile,equipCosmetic,PROFILE_KEY} from '../dist/profile.js';

const load = value => loadProfile({getItem:key=>{assert.equal(key,PROFILE_KEY);return JSON.stringify(value)}});
const legacy={version:1,lastUsername:' Ash ',enemies:{ironmaw:{seen:true,defeated:3}},milestones:['trial','warden'],cosmetics:{badge:'skull',trail:'ember'},runs:[{id:'legacy-run',name:'Ash',score:432,gameplay_version:'builds-1',death_mode:false}],scoreBests:{'builds-1:normal':999}};
const migrated=load(legacy);
assert.deepEqual(migrated.mastery?.weaponKills,[0,0,0,0,0],'Old profiles gain empty mastery without fabricating credited weapon kills');
assert.equal(migrated.version,1);
assert.equal(migrated.lastUsername,'Ash');
assert.deepEqual(migrated.cosmetics,{badge:'skull',trail:'ember'});
assert.equal(migrated.enemies.ironmaw.defeated,3);
assert.equal(migrated.runs[0].id,'legacy-run');
assert.equal(migrated.scoreBests['builds-1:normal'],999);

const malformed=load({...legacy,mastery:{weaponKills:[-1,74,999999999,3.5,'75',75],discoveries:['void-memorial','invented','meadow-shrine','meadow-shrine'],challenges:{cleanMaw:'true',cursedVictory:true,unknown:true},tracked:'not-a-goal',runIds:['same','same',null,'x'.repeat(129),...Array.from({length:300},(_,i)=>`run-${i}`)]}});
assert.deepEqual(malformed.mastery.weaponKills,[0,74,75,0,0],'Malformed counters must not unlock rewards or grow past their target');
assert.deepEqual(malformed.mastery.discoveries,['meadow-shrine','void-memorial']);
assert.deepEqual(malformed.mastery.challenges,{cleanMaw:false,cursedVictory:true});
assert.equal(malformed.mastery.tracked,null);
assert.equal(malformed.mastery.runIds.length,256,'Saved outcome deduplication must stay bounded');
assert.equal(new Set(malformed.mastery.runIds).size,256);
for(const mastery of [null,[],false,'invalid',{weaponKills:{0:75},discoveries:{},challenges:[],runIds:{}}]){
 const p=load({mastery});
 assert.deepEqual(p.mastery.weaponKills,[0,0,0,0,0]);
 assert.deepEqual(p.mastery.discoveries,[]);
 assert.deepEqual(p.mastery.runIds,[]);
}

const mastery=await import('../dist/mastery.js');
assert.equal(typeof mastery.recordWeaponKill,'function','Credited kill progress requires an explicit eligibility boundary');
const {recordWeaponKill,recordDiscovery}=mastery;
const kills=loadProfile(null),uncredited=structuredClone(kills);
for(const eligible of [false,undefined,null,0,1,'true'])assert.equal(recordWeaponKill(kills,0,eligible),false);
for(const index of [-1,5,1.5,'0',null,NaN,Infinity])assert.equal(recordWeaponKill(kills,index,true),false);
assert.deepEqual(kills,uncredited,'Ineligible runs and unattributed kills must leave all profile data untouched');
for(let i=0;i<74;i++)assert.equal(recordWeaponKill(kills,0,true),true);
assert.deepEqual(kills.mastery.weaponKills,[74,0,0,0,0]);
assert.equal(recordWeaponKill(kills,0,true),true);
assert.equal(recordWeaponKill(kills,0,true),false,'Capped mastery kills must stop causing persistence writes');
assert.deepEqual(kills.mastery.weaponKills,[75,0,0,0,0]);

const discoveries=loadProfile(null);
for(const eligible of [false,undefined,null,1,'true'])assert.equal(recordDiscovery(discoveries,'meadow-shrine',eligible),false);
for(const id of ['unknown','toString','__proto__',0,null])assert.equal(recordDiscovery(discoveries,id,true),false);
assert.deepEqual(discoveries.mastery.discoveries,[]);
assert.equal(recordDiscovery(discoveries,'void-memorial',true),true);
assert.equal(recordDiscovery(discoveries,'void-memorial',true),false,'Revisiting a landmark does not count a second discovery');
assert.equal(recordDiscovery(discoveries,'meadow-shrine',true),true);
assert.deepEqual(discoveries.mastery.discoveries,['meadow-shrine','void-memorial']);

assert.equal(typeof mastery.completeMasteryRun,'function','Run challenges need deduplicated outcome credit');
const {completeMasteryRun}=mastery;
const run={id:'challenge-run',victory:true,damage:[100,200,300,400,500],statues:3,mawDefeated:true,mawUntouched:true};
const isolated=loadProfile(null),isolatedBefore=structuredClone(isolated);
for(const eligible of [false,undefined,null,0,1,'true'])assert.equal(completeMasteryRun(isolated,run,eligible),false);
for(const id of ['',null,15,'unsafe id','x'.repeat(129)])assert.equal(completeMasteryRun(isolated,{...run,id},true),false);
assert.equal(completeMasteryRun(isolated,null,true),false);
assert.deepEqual(isolated,isolatedBefore);
assert.equal(completeMasteryRun(isolated,{...run,victory:false,mawUntouched:false},true),true);
assert.deepEqual(isolated.mastery.challenges,{cleanMaw:false,cursedVictory:false});
assert.equal(completeMasteryRun(isolated,run,true),false,'A duplicate outcome cannot rewrite an earlier failed challenge');
const reloaded=load(isolated);
assert.equal(completeMasteryRun(reloaded,run,true),false,'Reloading must retain outcome deduplication');
assert.deepEqual(reloaded.mastery.challenges,{cleanMaw:false,cursedVictory:false});
assert.equal(completeMasteryRun(reloaded,{...run,id:'maw-only',victory:false,statues:0},true),true);
assert.deepEqual(reloaded.mastery.challenges,{cleanMaw:true,cursedVictory:false},'Clean Maw completion survives losing the rest of the run');
assert.equal(completeMasteryRun(reloaded,{...run,id:'cursed-win',mawUntouched:false},true),true);
assert.deepEqual(reloaded.mastery.challenges,{cleanMaw:true,cursedVictory:true});
assert.deepEqual(reloaded.mastery.weaponKills,[0,0,0,0,0],'Run damage totals must never fabricate credited kills');

for(const [id,change] of Object.entries({defeat:{victory:false},few:{statues:2},fractional:{statues:3.1},coerced:{statues:'3'},infinite:{statues:Infinity},truthy:{victory:'true'}})){
 const p=loadProfile(null);
 completeMasteryRun(p,{...run,...change,id,mawUntouched:false},true);
 assert.equal(p.mastery.challenges.cursedVictory,false,id);
}
for(const [id,change] of Object.entries({alive:{mawDefeated:false},hit:{mawUntouched:false},unknown:{mawUntouched:undefined},truthy:{mawUntouched:'true'}})){
 const p=loadProfile(null);
 completeMasteryRun(p,{...run,...change,id,victory:false},true);
 assert.equal(p.mastery.challenges.cleanMaw,false,id);
}
for(let i=0;i<300;i++)completeMasteryRun(reloaded,{id:`bounded-${i}`},true);
assert.equal(reloaded.mastery.runIds.length,256);
assert.equal(reloaded.mastery.runIds[0],'bounded-299');
assert.equal(completeMasteryRun(reloaded,{id:'bounded-299'},true),false);
assert.deepEqual(reloaded.mastery.challenges,{cleanMaw:true,cursedVictory:true},'Pruning old run IDs must never remove earned challenges');

assert.equal(typeof mastery.masteryEntries,'function','Journal progress must be derived from bounded profile data');
const {masteryEntries,trackMastery,cosmeticAvailable,COSMETICS}=mastery;
const entryIds=['weapon-rifle','weapon-stinger','weapon-scatter','weapon-lancer','weapon-havoc','clean-maw','cursed-victory','world-discoverer'];
const initial=masteryEntries(loadProfile(null));
assert.deepEqual(initial.map(e=>e.id),entryIds);
assert.ok(initial.every(e=>e.current===0&&!e.complete&&e.target>0&&e.title&&e.description));
assert.deepEqual(masteryEntries(kills).filter(e=>e.complete).map(e=>e.id),['weapon-rifle']);
assert.equal(masteryEntries(discoveries).find(e=>e.id==='world-discoverer').current,2);
assert.deepEqual(masteryEntries(reloaded).filter(e=>e.complete).map(e=>e.id),['clean-maw','cursed-victory']);
const tracked=loadProfile(null);
assert.equal(trackMastery(tracked,'weapon-lancer'),true);
assert.equal(trackMastery(tracked,'weapon-lancer'),false);
assert.equal(trackMastery(tracked,'invalid'),false);
assert.equal(tracked.mastery.tracked,'weapon-lancer');
assert.equal(load(tracked).mastery.tracked,'weapon-lancer');
assert.equal(trackMastery(tracked,null),true);
assert.equal(trackMastery(tracked,null),false);

const locked=loadProfile(null);
for(const [slot,value] of [['badge','iron'],['badge','crown'],['trail','aurora'],['badge','skull'],['trail','ember']]){
 assert.equal(cosmeticAvailable(locked,slot,value),false);
 assert.equal(equipCosmetic(locked,slot,value),false);
}
assert.equal(cosmeticAvailable(locked,'badge','none'),true);
assert.equal(cosmeticAvailable(locked,'trail','normal'),true);
assert.equal(cosmeticAvailable(locked,'badge','aurora'),false);
assert.equal(cosmeticAvailable(locked,'trail','invented'),false);
assert.deepEqual(load({...legacy,mastery:null,cosmetics:{badge:'crown',trail:'aurora'}}).cosmetics,{badge:'none',trail:'normal'},'Saved selections must not bypass unlock requirements');
const almost=load({mastery:{weaponKills:[0,0,0,0,74]}});
assert.equal(cosmeticAvailable(almost,'trail','aurora'),false);
recordWeaponKill(almost,4,true);
assert.equal(cosmeticAvailable(almost,'trail','aurora'),true,'Each weapon can independently earn the trail');
assert.equal(equipCosmetic(almost,'trail','aurora'),true);
assert.equal(load(almost).cosmetics.trail,'aurora');
const explorer=loadProfile(null);
for(const id of ['meadow-shrine','quarry-engine','caldera-reliquary','citadel-archive'])recordDiscovery(explorer,id,true);
assert.equal(cosmeticAvailable(explorer,'trail','aurora'),false);
recordDiscovery(explorer,'void-memorial',true);
assert.equal(cosmeticAvailable(explorer,'trail','aurora'),true);
assert.equal(masteryEntries(explorer).find(e=>e.id==='world-discoverer').complete,true);
assert.equal(cosmeticAvailable(reloaded,'badge','iron'),true);
assert.equal(cosmeticAvailable(reloaded,'badge','crown'),true);
assert.equal(equipCosmetic(reloaded,'badge','crown'),true);
assert.equal(load(reloaded).cosmetics.badge,'crown');
assert.equal(cosmeticAvailable(migrated,'badge','skull'),true);
assert.equal(cosmeticAvailable(migrated,'trail','ember'),true);
for(const entry of masteryEntries(reloaded))assert.ok(COSMETICS.some(c=>c.slot===entry.reward.slot&&c.value===entry.reward.value&&c.label===entry.reward.label));
const view=masteryEntries(kills);view[0].current=0;view[0].reward.label='changed';
assert.equal(masteryEntries(kills)[0].current,75,'Journal views must not be able to mutate saved mastery');
assert.notEqual(masteryEntries(kills)[0].reward.label,'changed');
let saved;
assert.equal(saveProfile({setItem:(_,value)=>{saved=value}},reloaded),true);
assert.deepEqual(loadProfile({getItem:()=>saved}),reloaded,'All mastery state and selections survive a profile storage round trip');

console.log('PASS mastery migration: legacy progress, score history, personal best and original cosmetics are preserved.');
console.log('PASS mastery: eligible credited kills, discoveries, challenge outcomes, bounded deduplication, tracked goals and cosmetic unlocks.');
