import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../dist/server/index.js';
const sqlite=new DatabaseSync(':memory:');
for(const file of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()){
 sqlite.exec(fs.readFileSync('drizzle/'+file,'utf8'));
 if(file.startsWith('0000'))sqlite.exec("INSERT INTO scores VALUES ('legacy','Existing Player',10,1,1,10,1700000000000)");
}
const legacy=sqlite.prepare("SELECT * FROM scores WHERE id='legacy'").get();
assert.equal(legacy.name,'Existing Player');assert.equal(legacy.stage,null);assert.equal(legacy.played_at,1700000000000,'Migration preserves the original score date');
assert.equal(legacy.death_mode,null,'Historical runs have an unknown mode, not an invented Death Mode label');
sqlite.exec("DELETE FROM scores WHERE id='legacy'");
const env={DB:{prepare(sql){
 let values=[];
 return {bind(...v){values=v;return this},async run(){return sqlite.prepare(sql).run(...values)},async all(){return {results:sqlite.prepare(sql).all(...values)}}};
}}};
const get=()=>worker.fetch(new Request('https://game.test/api/scores'),env);
const post=p=>worker.fetch(new Request('https://game.test/api/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}),env);
assert.deepEqual((await (await get()).json()).scores,[]);
const run={id:'11111111-1111-4111-8111-111111111111',name:'Test Runner',score:250,kills:2,wave:2,seconds:35,stage:3,played_at:Date.UTC(2026,8,26,12)};
const deathRun={...run,id:'44444444-4444-4444-8444-444444444444',name:'Death Runner',death_mode:true};
assert.equal((await post(deathRun)).status,200);
assert.equal((await (await get()).json()).scores[0].death_mode,true,'Death Mode is returned as a boolean');
assert.equal((await post({...deathRun,death_mode:false})).status,200);
assert.equal((await (await get()).json()).scores[0].death_mode,true,'Retries cannot rewrite the recorded mode');
sqlite.exec("DELETE FROM scores WHERE id='44444444-4444-4444-8444-444444444444'");
for(const invalid of ['true',1,0,null,{},[]])assert.equal((await post({...deathRun,death_mode:invalid})).status,400);
assert.equal((await post(run)).status,200);assert.equal((await post(run)).status,200);
assert.equal((await (await get()).json()).scores.length,1,'Retries must not duplicate scores');
assert.equal((await (await get()).json()).scores[0].death_mode,null,'Older clients without a mode stay compatible');
assert.equal((await (await get()).json()).scores[0].stage,3,'Stage is the reached world, not the timed wave');
assert.equal((await (await get()).json()).scores[0].played_at,run.played_at,'The run date survives delayed/repeated submission');
assert.equal((await post({...run,stage:6})).status,400);
assert.equal((await post({...run,played_at:Date.now()+3600000})).status,400);
assert.equal((await post({...run,id:'22222222-2222-4222-8222-222222222222',score:900,death_mode:false})).status,200);
assert.equal((await (await get()).json()).scores[0].score,900);
assert.equal((await (await get()).json()).scores[0].death_mode,false,'Normal mode stays distinct from unknown historical data');
assert.equal((await post({...run,score:-1})).status,400);assert.equal((await post({...run,name:'a'.repeat(100)})).status,400);
assert.equal((await post({...run,name:'  '})).status,400,'Blank usernames are rejected by the server');
assert.equal((await post({...run,id:'33333333-3333-4333-8333-333333333333',name:'  Ash Runner  ',score:1000})).status,200);
assert.equal((await (await get()).json()).scores[0].name,'Ash Runner');
for(const path of ['/','/game.js','/terrain.js','/scenery.js','/preferences.js','/menus.css','/vendor/three.module.js'])assert.equal((await worker.fetch(new Request('https://game.test'+path),env)).status,200);
assert.equal((await worker.fetch(new Request('https://game.test/server/index.js'),env)).status,404);
for(const path of ['/monsters.js','/graphics.js','/assets/death-skull.png','/retro.js','/ballistics.js','/retro.css','/assets/ps1-atlas.png','/assets/weapons.png','/assets/crypt-pixel.ttf']){
 const response=await worker.fetch(new Request('https://game.test'+path),env);assert.equal(response.status,200);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync('dist'+path),'Bundled asset must preserve all bytes: '+path);
}
console.log('PASS: D1 schema, score insert/ranking, idempotent retries, invalid payloads, public asset serving.');
const metaRun={...run,id:'55555555-5555-4555-8555-555555555555',death_mode:false,gameplay_version:'builds-1',outcome:'defeat',statue_count:2,statue_modifier:110};
assert.equal((await post(metaRun)).status,200);
const ranked=async(mode,version)=> (await (await worker.fetch(new Request(`https://game.test/api/scores?mode=${mode}&version=${version}`),env)).json());
const filtered=await ranked('normal','builds-1');assert.equal(filtered.capabilities?.modeFilter,true,'Backend must explicitly support full mode filtering');assert.equal(filtered.scores.length,1);assert.equal(filtered.scores[0].statue_count,2);assert.equal(filtered.scores[0].outcome,'defeat');
for(let i=0;i<30;i++)await post({...metaRun,id:`66666666-6666-4666-8666-${String(i).padStart(12,'0')}`,score:5000+i,death_mode:true});
assert.equal((await ranked('normal','builds-1')).scores.length,1,'Filter before LIMIT despite 30 higher Death scores');assert.equal((await ranked('death','builds-1')).scores.length,25);assert.equal((await ranked('unknown','all')).scores[0].gameplay_version,null,'Legacy version stays unknown');
for(const patch of [{statue_count:-1},{statue_modifier:101},{outcome:'fake'},{gameplay_version:'<script>'}])assert.equal((await post({...metaRun,...patch})).status,400);
assert.ok(sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM scores WHERE death_mode=0 AND gameplay_version=? ORDER BY score DESC,wave DESC,seconds DESC LIMIT 25').all('builds-1').some(r=>r.detail.includes('idx_scores_mode_version')));
console.log('PASS ranking: additive metadata, preserved unknowns, filters before top 25, mode/version index and validation.');
