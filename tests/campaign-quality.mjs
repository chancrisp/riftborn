import assert from 'node:assert/strict';
import {context,nodes,listeners,evaluate as ev} from './harness.mjs';
const t=context.test;
const failures=[];
function check(name,fn){try{fn();console.log('PASS',name)}catch(e){failures.push(name);console.error('FAIL',name,e.message)}}
check('capped Deadeye never consumes a reward slot',()=>{
 t.start();ev('player.crit=.9;runRandom=randomSource(12)');
 for(let i=0;i<60;i++)assert.equal(ev("ordinaryOptions().some(o=>o.name==='Deadeye')"),false);
 ev('player.crit=.89;runRandom=randomSource(12)');
 assert.ok(Array.from({length:60},()=>ev("ordinaryOptions().some(o=>o.name==='Deadeye')")).some(Boolean));
});
check('surges share the live ambient population budget',()=>{
 t.start();ev("stageGoal=10000;for(let i=0;i<55;i++)spawnEnemy('runner');elapsed=29.99;spawnTimer=10;player.inv=100");t.update(1/60);
 assert.ok(t.state.enemies.filter(e=>e.hp>0).length<=55);
});
check('splitter descendants cannot overflow the combat budget',()=>{
 t.start();ev("stage=3;stageGoal=10000;for(let i=0;i<54;i++)spawnEnemy('runner');spawnEnemy('splitter')");
 t.hurtEnemy(t.state.enemies.at(-1),1e8);assert.ok(t.state.enemies.filter(e=>e.hp>0).length<=55);
});
check('arriving ordinary monsters cannot deal immediate contact damage',()=>{
 t.start();ev("player.inv=0;const arrival=spawnEnemy('runner',{x:0,z:0});arrival.x=.2;enemyUpdate(arrival,1/60)");assert.equal(t.state.player.hp,100);
 ev('arrival.spawn=0;arrival.x=player.x+.2;arrival.z=player.z;enemyUpdate(arrival,1/60)');assert.ok(t.state.player.hp<100);
});
check('controller elevation assistance ignores a blocked target',()=>{
 t.start();ev("const blocked=spawnEnemy('runner',{x:0,z:5});blocked.c.g.position.y=8;stageWorld.covers.push({shape:'box',x:0,y:5,z:2.5,sx:2,sy:12,sz:1});const clear=spawnEnemy('runner',{x:2,z:18});clear.c.g.position.y=height(clear.x,clear.z)");
 const pitch=ev('assistedPitch(.08)');assert.ok(Math.abs(pitch)<.3,'Blocked high target stole vertical aim: '+pitch);
});
check('an active crawler still makes contact at exact overlap',()=>{
 t.start();ev("player.inv=0;const overlap=spawnEnemy('skitter',{x:0,z:0});overlap.spawn=0;overlap.x=player.x;overlap.z=player.z;enemyUpdate(overlap,1/60)");assert.ok(t.state.player.hp<100);
});
check('Rift Echo keeps the player material shader when it clones the silhouette',()=>{
 t.start();ev("build.dash='echo';globalThis.playerShader=null;hero.g.traverse(m=>{if(m.isMesh&&!playerShader)playerShader=m.material.onBeforeCompile});dash()");assert.equal(ev('dashEffects.echo.visual.children[0].children[0].material.onBeforeCompile===playerShader'),true);
});
check('ordinary drafts include offense and survival/movement without duplicates',()=>{
 t.start();for(let i=0;i<100;i++){
  const names=ev('ordinaryOptions().map(o=>o.name)');assert.equal(new Set(names).size,3);
  assert.ok(names.some(n=>['Overclock','Heavy rounds','Forked chamber','Ghost rounds','Deadeye'].includes(n)));
  assert.ok(names.some(n=>['Phase armor','Gravity well','Rush circuit','Repair field'].includes(n)));
 }
});
check('landmark inspection rewards once and stays separate from statue curses',()=>{
 t.start();ev('player.x=landmark.approach.x;player.z=landmark.approach.z;player.hp=50;interact()');assert.equal(t.state.mode,'upgrade');nodes.get('#cards').children[0].onclick();assert.equal(t.state.player.hp,62);assert.equal(ev('difficultyBonus'),0);
 ev('interact()');nodes.get('#cards').children[0].onclick();assert.equal(t.state.player.hp,62);assert.equal(ev('landmark.claimed'),true);
});
check('opening freezes simulation and skip restores clean controls',()=>{
 ev('window.__RIFTBORN_TEST_SEQUENCES__=true');t.start();assert.equal(t.state.mode,'sequence');
 const time=t.state.elapsed;t.update(1);assert.equal(t.state.elapsed,time);ev('skipSequence()');assert.equal(t.state.mode,'play');assert.equal(ev('cinematic'),null);
});
check('boss entrance clears immediate danger and waits for control return',()=>{
 ev('stage=2;setStageDecor();hazard(0,0,4,50,1,"mortar");startQuarry()');assert.equal(t.state.mode,'sequence');assert.equal(t.state.hazards.length,0);assert.equal(t.state.enemies.filter(e=>e.hp>0).length,1);
 ev('skipSequence()');assert.equal(t.state.mode,'play');assert.ok(t.state.player.inv>=1);
});
check('victory aftermath precedes results and completes only once',()=>{
 t.start();ev('skipSequence();stage=5;setStageDecor();summonBoss();skipSequence()');const boss=t.state.enemies.find(e=>e.kind==='warden');t.hurtEnemy(boss,1e8);assert.equal(t.state.mode,'sequence');assert.equal(ev('cinematic.kind'),'victory');ev('skipSequence();skipSequence()');assert.equal(t.state.mode,'dead');assert.equal(t.state.victory,true);
});
check('pause binding and controller Menu freeze a sequence',()=>{
 t.start();listeners.get('keydown')({code:t.prefs.bindings.pause,preventDefault(){}});assert.equal(ev('cinematic.paused'),true);
 listeners.get('keydown')({code:t.prefs.bindings.pause,preventDefault(){}});assert.equal(ev('cinematic.paused'),false);
 const pad={axes:[0,0,0,0],buttons:Array.from({length:16},()=>({pressed:false}))};context.navigator.getGamepads=()=>[pad];pad.buttons[9].pressed=true;ev('prevPad=[];pollPad()');assert.equal(ev('cinematic.paused'),true);context.navigator.getGamepads=()=>[];
});
check('abandoning a completed Quarry trial preserves the boss entrance',()=>{
 t.start();ev('skipSequence();stage=2;setStageDecor();beginTrial(statueWorld.statues[0]);stageKills=stageGoal;activatePortal();pause()');assert.equal(t.state.mode,'pause');nodes.get('#abandonTrial').onclick();assert.equal(t.state.mode,'sequence');assert.equal(ev('cinematic.kind'),'maw');ev('skipSequence()');assert.equal(t.state.mode,'play');
});
check('enraged Warden retains retro shaders and disposes after the aftermath',()=>{
 t.start();ev('skipSequence();stage=5;setStageDecor();summonBoss();skipSequence();globalThis.phaseBoss=enemies.find(e=>e.kind===\'warden\');globalThis.originalPhaseMesh=null;phaseBoss.c.g.traverse(m=>{if(m.isMesh&&!originalPhaseMesh)originalPhaseMesh=m});globalThis.phaseShader=originalPhaseMesh.material.onBeforeCompile;phaseBoss.hp=phaseBoss.max*.4;bossUpdate(phaseBoss,1/60)');
 assert.equal(ev('originalPhaseMesh.material.onBeforeCompile===phaseShader'),true);ev('skipSequence();globalThis.phaseDisposals=0;originalPhaseMesh.material.addEventListener(\'dispose\',()=>phaseDisposals++);hurtEnemy(phaseBoss,1e8)');assert.equal(ev('phaseDisposals'),0);ev('skipSequence()');assert.equal(ev('phaseDisposals'),1);ev('resetSequence()');assert.equal(ev('phaseDisposals'),1);
});
check('Continue via keyboard resumes a paused sequence instead of skipping',()=>{
 t.start();t.pause();listeners.get('keydown')({code:'Enter',preventDefault(){}});assert.equal(t.state.mode,'sequence');assert.equal(ev('cinematic.paused'),false);
});
check('a full arena defers a trial without consuming its statue or curse',()=>{
 t.start();ev('skipSequence();stage=3;setStageDecor();for(let i=0;i<55;i++)spawnEnemy(\'runner\')');assert.equal(ev('beginTrial(statueWorld.statues[0])'),false);assert.equal(ev('difficultyBonus'),0);assert.equal(ev('statueWorld.statues[0].used'),false);
 for(const e of t.state.enemies.slice(0,4))t.hurtEnemy(e,1e8);assert.equal(ev('beginTrial(statueWorld.statues[0])'),true);assert.ok(ev('liveHostiles()')<=55);
});
check('restart cleans up an interrupted sequence',()=>{t.start();t.start();assert.equal(t.state.mode,'sequence');ev('skipSequence();window.__RIFTBORN_TEST_SEQUENCES__=false');assert.equal(t.state.mode,'play')});
if(failures.length)throw new Error(failures.length+' campaign-quality regressions');
