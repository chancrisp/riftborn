import assert from 'node:assert/strict';
import {context,nodes,document,evaluate} from './harness.mjs';

const game=context.test;
const setup=nodes.get('#runForm');
let posts=0;
context.fetch=async(url,options)=>{if(options?.method==='POST')posts++;return {ok:true,json:async()=>({scores:[]})}};

game.start(true);
nodes.get('#start').onclick();
nodes.get('#playerName').value='Tester';
document.querySelector('#practiceRun').checked=true;
setup.onsubmit({preventDefault(){}});
assert.equal(game.state.mode,'play');
assert.equal(evaluate('practiceRun'),true);
assert.equal(evaluate('runId'),null,'Practice runs have no leaderboard ID');
assert.match(nodes.get('#endRun').textContent,/PRACTICE/);
game.update(1.1);
game.finishRun(false);
assert.equal(posts,0,'Practice results never reach the score API');
assert.equal(evaluate('pendingScores.size'),0,'Practice results never enter the retry queue');
assert.equal(evaluate('profile.runs.length'),0,'Practice results stay out of personal history');
assert.match(nodes.get('#scoreSave').textContent,/not saved/i);

nodes.get('#start').onclick();
nodes.get('#playerName').value='Tester';
document.querySelector('#practiceRun').checked=false;
setup.onsubmit({preventDefault(){}});
assert.equal(evaluate('practiceRun'),false);
assert.ok(evaluate('runId'),'A normal run gets a leaderboard ID');
game.update(1.1);
game.finishRun(false);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(posts,1,'A later normal run still submits its result');
console.log('PASS practice run score isolation and normal run recovery.');
