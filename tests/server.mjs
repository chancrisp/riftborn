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
for(const path of ['/monsters.js','/graphics.js','/assets/death-skull.png','/assets/trophy-gold.svg','/assets/trophy-silver.svg','/assets/trophy-bronze.svg','/retro.js','/ballistics.js','/retro.css','/assets/ps1-atlas.png','/assets/weapons.png','/assets/crypt-pixel.ttf']){
 const response=await worker.fetch(new Request('https://game.test'+path),env);assert.equal(response.status,200);
 if(path.endsWith('.svg'))assert.equal(response.headers.get('Content-Type'),'image/svg+xml','Trophy sprites must have SVG MIME type');
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync('dist'+path),'Bundled asset must preserve all bytes: '+path);
}
console.log('PASS: D1 schema, score insert/ranking, idempotent retries, invalid payloads, public asset serving.');
const metaRun={...run,id:'55555555-5555-4555-8555-555555555555',death_mode:false,gameplay_version:'builds-1',outcome:'defeat',statue_count:2,statue_modifier:110};
assert.equal((await post(metaRun)).status,200);
const ranked=async(mode,version)=> (await (await worker.fetch(new Request(`https://game.test/api/scores?mode=${mode}&version=${version}`),env)).json());
const filtered=await ranked('normal','builds-1');assert.equal(filtered.capabilities?.modeFilter,true,'Backend must explicitly support full mode filtering');assert.equal(filtered.scores.length,1);assert.equal(filtered.scores[0].statue_count,2);assert.equal(filtered.scores[0].outcome,'defeat');
for(let i=0;i<30;i++)await post({...metaRun,id:`66666666-6666-4666-8666-${String(i).padStart(12,'0')}`,score:5000+i,death_mode:true});
assert.equal((await ranked('normal','builds-1')).scores.length,1,'Filter before LIMIT despite 30 higher Death scores');assert.equal((await ranked('death','builds-1')).scores.length,10,'Death board returns only its top 10');assert.equal((await ranked('unknown','all')).scores[0].gameplay_version,null,'Legacy version stays unknown');
for(let i=0;i<24;i++)await post({...metaRun,id:`77777777-7777-4777-8777-${String(i).padStart(12,'0')}`,score:2000+i,gameplay_version:i%2?'builds-1':'campaign-2'});
const normalAll=await ranked('normal','all');assert.equal(normalAll.scores.length,20,'Normal board returns only its top 20 across versions');
assert.ok(normalAll.scores.some(s=>s.gameplay_version==='builds-1')&&normalAll.scores.some(s=>s.gameplay_version==='campaign-2'),'Normal ranking combines versions');
assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM scores WHERE death_mode=0').get().count,26,'Lower scores remain stored for run history');
for(const patch of [{statue_count:-1},{statue_modifier:101},{outcome:'fake'},{gameplay_version:'<script>'}])assert.equal((await post({...metaRun,...patch})).status,400);
assert.ok(sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM scores WHERE death_mode=0 AND gameplay_version=? ORDER BY score DESC,wave DESC,seconds DESC LIMIT 20').all('builds-1').some(r=>r.detail.includes('idx_scores_mode_version')));
console.log('PASS ranking: additive metadata, preserved unknowns, mode limits, mode/version index and validation.');
const logError=console.error;console.error=()=>{}; // the Worker logs the simulated failures below
// game_version: the release a run was played on. Production's hand-made database lacks the column,
// so the Worker adds it lazily, once per DB binding, and never lets that check break scores.
const legacyDb=(upTo='0004')=>{const db=new DatabaseSync(':memory:');for(const file of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')&&f.slice(0,4)<=upTo).sort())db.exec(fs.readFileSync('drizzle/'+file,'utf8'));return db;};
const standIn=(db,hook=()=>{})=>{const log=[];return {log,env:{DB:{prepare(sql){log.push(sql);let values=[];return {bind(...v){values=v;return this},async run(){hook(sql);return db.prepare(sql).run(...values)},async all(){hook(sql);return {results:db.prepare(sql).all(...values)}}};}}}};};
const at=(env,path='/api/scores')=>worker.fetch(new Request('https://game.test'+path),env);
const send=(env,p)=>worker.fetch(new Request('https://game.test/api/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}),env);
const columns=db=>db.prepare("PRAGMA table_info('scores')").all().map(c=>c.name);
assert.ok(columns(sqlite).includes('game_version')&&columns(sqlite).includes('rift_score'),'Migration 0005 adds game_version and rift_score');
const versioned={...run,id:'88888888-8888-4888-8888-000000000001',score:7777,death_mode:false,gameplay_version:'keepers-2',game_version:'2.1.0'};
assert.equal((await post(versioned)).status,200);
assert.equal((await ranked('normal','keepers-2')).scores[0].game_version,'2.1.0','A migrated database returns game_version');
for(const bad of ['v2.1','2.1','2.1.0.1','<script>','12345.1.1','1.2.3 ','',2.1,null,{},[]])assert.equal((await post({...versioned,id:'88888888-8888-4888-8888-000000000002',game_version:bad})).status,400,'Rejects game_version '+JSON.stringify(bad));
{
 const db=legacyDb();db.exec("INSERT INTO scores (id,name,score,kills,wave,seconds,created_at,played_at,death_mode,gameplay_version) VALUES ('old','Old Timer',500,3,2,40,1700000000000,1700000000000,0,'campaign-2')");
 assert.ok(!columns(db).includes('game_version')&&!columns(db).includes('rift_score'));
 const {env:legacyEnv,log}=standIn(db);
 const first=await (await at(legacyEnv)).json();
 assert.ok(columns(db).includes('game_version')&&columns(db).includes('rift_score'),'The first request adds the missing columns');
 assert.equal(first.scores[0].game_version,null,'Rows recorded before the column return null');
 assert.equal(log.filter(s=>s.startsWith('PRAGMA')).length,1);assert.equal(log.filter(s=>s.startsWith('ALTER')).length,3,'game_version, rift_score and (v2.2) account_id');
 assert.equal((await send(legacyEnv,{...versioned,id:'99999999-9999-4999-8999-000000000001'})).status,200);
 assert.equal((await send(legacyEnv,{...run,id:'99999999-9999-4999-8999-000000000002',score:600,death_mode:false})).status,200,'Clients without game_version still save');
 const rows=(await (await at(legacyEnv,'/api/scores?mode=normal&version=all')).json()).scores;
 assert.deepEqual(rows.map(r=>[r.name,r.score,r.game_version]),[['Test Runner',7777,'2.1.0'],['Test Runner',600,null],['Old Timer',500,null]]);
 assert.equal(log.filter(s=>s.startsWith('PRAGMA')).length,1,'The column is checked once per isolate and binding');
 assert.equal(log.filter(s=>s.startsWith('ALTER')).length,3);
}
{
 // Another isolate added the column between the check and the ALTER: continue with it.
 const db=legacyDb();const {env:raceEnv,log}=standIn(db);
 raceEnv.DB.prepare=(orig=>sql=>sql.startsWith('PRAGMA')?{bind(){return this},async all(){log.push(sql);db.exec('ALTER TABLE scores ADD COLUMN game_version TEXT');return {results:[{name:'id'}]}}}:orig(sql))(raceEnv.DB.prepare);
 assert.equal((await send(raceEnv,{...versioned,id:'99999999-9999-4999-8999-000000000003'})).status,200);
 assert.equal((await (await at(raceEnv)).json()).scores[0].game_version,'2.1.0','A duplicate-column race still uses the column');
}
for(const failing of [sql=>{if(sql.startsWith('PRAGMA'))throw new Error('D1_ERROR: not authorized')},sql=>{if(sql.startsWith('ALTER'))throw new Error('D1_ERROR: not authorized: SQLITE_AUTH')}]){
 // The check or the ALTER fails: scores are saved and read exactly as before.
 const db=legacyDb();db.exec("INSERT INTO scores (id,name,score,kills,wave,seconds,created_at) VALUES ('old','Old Timer',500,3,2,40,1700000000000)");
 const {env:downEnv}=standIn(db,failing);
 assert.equal((await send(downEnv,{...versioned,id:'99999999-9999-4999-8999-000000000004'})).status,200,'Saving works without the column');
 assert.equal((await send(downEnv,{...run,id:'99999999-9999-4999-8999-000000000005',score:100})).status,200);
 const rows=(await (await at(downEnv)).json()).scores;
 assert.deepEqual(rows.map(r=>[r.score,r.game_version]),[[7777,null],[500,null],[100,null]]);
 assert.ok(!columns(db).includes('game_version')&&!columns(db).includes('rift_score'));
}
{
 // The column vanished after the check: the query falls back instead of failing.
 const db=legacyDb('0005');const {env:lostEnv}=standIn(db);
 assert.equal((await at(lostEnv)).status,200);
 db.exec('ALTER TABLE scores DROP COLUMN game_version');
 assert.equal((await send(lostEnv,{...versioned,id:'99999999-9999-4999-8999-000000000006'})).status,200);
 assert.equal((await (await at(lostEnv)).json()).scores[0].game_version,null);
}
console.error=logError;
console.log('PASS game_version: migration, validation, lazy idempotent column, legacy nulls, failure fallbacks.');
{
 // ruleset filter: KEEPERS and ORIGINAL rankings no longer crowd each other out; absent = as before.
 const db=legacyDb('0005');const {env:rsEnv}=standIn(db);
 const uid=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
 const base={name:'Keeper',kills:40,wave:5,seconds:125,stage:3,played_at:Date.UTC(2026,8,27),death_mode:false,statue_count:2,statue_modifier:110,outcome:'defeat'};
 const game={...base,id:uid(1),name:'Crowned',score:90000,stage:5,wave:21,seconds:612,death_mode:true,statue_count:3,statue_modifier:115,outcome:'victory',gameplay_version:'keepers-2',game_version:'2.1.0',rift_score:123456789};
 assert.equal((await send(rsEnv,game)).status,200,'A KEEPERS payload as the game sends it is accepted');
 for(const [i,score,rift,version] of [[2,5000,90000,'keepers-2'],[3,9000,40000,'keepers-2'],[4,7000,60000,'keepers-1'],[5,8000,undefined,'original-1'],[6,6000,undefined,'campaign-2'],[7,4000,undefined,undefined]])
  assert.equal((await send(rsEnv,{...base,id:uid(i),score,...(rift===undefined?{}:{rift_score:rift}),...(version?{gameplay_version:version}:{})})).status,200);
 const board=async q=>(await (await at(rsEnv,'/api/scores?'+q)).json());
 const all=await board('mode=normal&version=all');
 assert.equal(all.capabilities.rulesetFilter,true);assert.equal(all.ranking.ruleset,'all');
 assert.deepEqual(all.scores.map(r=>r.score),[9000,8000,7000,6000,5000,4000],'Without ruleset every run ranks by score, as before');
 const keepers=await board('mode=normal&version=all&ruleset=keepers');
 assert.deepEqual(keepers.scores.map(r=>[r.rift_score,r.gameplay_version]),[[90000,'keepers-2'],[60000,'keepers-1'],[40000,'keepers-2']],'KEEPERS rank by Rift Score');
 const original=await board('mode=normal&version=all&ruleset=original');
 assert.deepEqual(original.scores.map(r=>[r.score,r.gameplay_version]),[[8000,'original-1'],[6000,'campaign-2'],[4000,null]],'ORIGINAL keeps legacy and unstamped runs');
 assert.deepEqual((await board('mode=death&version=all&ruleset=keepers')).scores.map(r=>[r.name,r.rift_score,r.stage,r.outcome,r.game_version]),[['Crowned',123456789,5,'victory','2.1.0']]);
 assert.equal((await board('mode=normal&version=keepers-2&ruleset=keepers')).scores.length,2,'ruleset combines with version');
 for(const bad of ['','all','KEEPERS','rift','keepers-2'])assert.equal((await at(rsEnv,'/api/scores?mode=normal&ruleset='+encodeURIComponent(bad))).status,400,'Rejects ruleset '+JSON.stringify(bad));
 for(let i=0;i<25;i++){
  await send(rsEnv,{...base,id:uid(100+i),score:1000+i,death_mode:true,gameplay_version:'keepers-2',rift_score:2000+i});
  await send(rsEnv,{...base,id:uid(200+i),score:1000+i,death_mode:true,gameplay_version:'original-1'});
 }
 assert.equal((await board('mode=death&version=all&ruleset=keepers')).scores.length,20,'KEEPERS Death ranks its top 20');
 assert.equal((await board('mode=death&version=all&ruleset=original')).scores.length,10,'ORIGINAL Death keeps its top 10');
 assert.equal((await board('mode=death&version=all')).scores.length,10,'Death without ruleset keeps its top 10');
 for(const patch of [{rift_score:-1},{rift_score:1.5},{rift_score:'9'},{rift_score:1e11},{rift_score:5,gameplay_version:'original-1'},{rift_score:5,gameplay_version:undefined}])
  assert.equal((await send(rsEnv,{...game,id:uid(300),...patch})).status,400,'Rejects rift_score patch '+JSON.stringify(patch));
}
console.log('PASS ruleset: KEEPERS/ORIGINAL filters, Rift Score ranking and validation, unchanged default board.');
