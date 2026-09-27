import assert from 'node:assert/strict';
import {ScoreOutbox} from '../dist/score-outbox.js';
import {compareRun} from '../dist/run-history.js';
class Store{constructor(){this.rows=[];this.chain=Promise.resolve()}read(){return Promise.resolve(structuredClone(this.rows))}change(fn){const result=this.chain.then(()=>{const rows=structuredClone(this.rows),r=fn(rows);this.rows=rows;return r});this.chain=result.catch(()=>{});return result}}
let now=1000,calls=0;const store=new Store(),run={id:'run-1',name:'Ash',score:10,stage:2,seconds:60,outcome:'defeat',death_mode:false,gameplay_version:'builds-1'};
const send=async()=>{calls++;return {ok:true,status:200}},a=new ScoreOutbox({store,send,now:()=>now,owner:'a'}),b=new ScoreOutbox({store,send,now:()=>now,owner:'b'});
await a.add(run);await b.add({...run,score:999});await Promise.all([a.flush(),b.flush()]);assert.equal(calls,1);assert.equal((await store.read()).length,0);
const offline=new ScoreOutbox({store,send:async()=>{throw Error('offline')},now:()=>now});await offline.add(run);await offline.flush();assert.equal((await store.read())[0].attempts,1);await offline.flush();assert.equal((await store.read())[0].attempts,1);now+=5000;await b.flush();assert.equal((await store.read()).length,0);
const full=new ScoreOutbox({store:{read:async()=>{throw Error('blocked')},change:async()=>{throw Error('full')}},send:async()=>{throw Error('offline')},now:()=>now});await full.add(run);await full.flush();assert.equal((await full.list()).length,1);assert.equal(full.storageFailed,true);
const bad=new ScoreOutbox({store,send:async()=>({ok:false,status:400}),now:()=>now});await bad.add(run);await bad.flush();assert.equal((await bad.list())[0].status,'failed');now+=1e9;await bad.flush();assert.equal((await bad.list())[0].attempts,1);await bad.retry();assert.equal((await bad.list())[0].status,'pending');
assert.match(compareRun({...run,id:"new",score:20},[run]).join(' '),/PERSONAL BEST/);assert.doesNotMatch(compareRun({...run,seconds:1},[run]).join(' '),/faster/);assert.deepEqual(compareRun(run,[{...run,id:'other',death_mode:true}]),[]);
assert.match(compareRun({...run,id:'new',outcome:'victory',seconds:55},[{...run,outcome:'victory'}]).join(' '),/5s faster/);
console.log('PASS durable scores: immutable records, transactional claims, reload recovery, backoff, storage failure, rejected payload retention and comparable personal results.');

const quotaStore=new Store();quotaStore.change=fn=>{const rows=structuredClone(quotaStore.rows),result=fn(rows);if(rows.length>quotaStore.rows.length)return Promise.reject(Error('Quota full'));quotaStore.rows=rows;return Promise.resolve(result)};
let fallbackCalls=0;const quota=new ScoreOutbox({store:quotaStore,send:async()=>{fallbackCalls++;throw Error('offline')},now:()=>now});await quota.add(run);await quota.flush();assert.equal(fallbackCalls,1);assert.equal(quota.storageFailed,true);assert.equal((await quota.list()).length,1);
await quota.retry();quota.send=send;await quota.flush();assert.equal((await quota.list()).length,0);
console.log('PASS readable/full storage: fallback is uploaded, retained on failure, and accurately disclosed.');

const leased=new Store();await leased.change(rows=>rows.push({id:run.id,payload:run,status:'pending',attempts:1,nextAt:0,leaseOwner:'crashed-tab',leaseUntil:now+30000}));let recovered=0;const recovery=new ScoreOutbox({store:leased,send:async()=>{recovered++;return {ok:true}},now:()=>now});await recovery.flush();assert.equal(recovered,0);now+=30001;await recovery.flush();assert.equal(recovered,1);
assert.doesNotMatch(compareRun({...run,id:'new'},[{...run,stage:undefined}]).join(' '),/NaN/);assert.match(compareRun({...run,score:110},[],{'builds-1:normal':100}).join(' '),/PERSONAL BEST/);

const corrupted=new Store();corrupted.rows=[{id:'broken',payload:null}];const corrupt=new ScoreOutbox({store:corrupted,send:async()=>{throw Error('Must not submit malformed row')}});await corrupt.flush();assert.equal((await corrupt.list()).length,1);assert.equal((await corrupt.list())[0].status,'failed');

assert.doesNotMatch(compareRun({...run,id:'new'},[{...run,stage:null}]).join(' '),/stages/);
