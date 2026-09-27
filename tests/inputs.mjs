import assert from 'node:assert/strict';
import {context,nodes,document,Element,listeners,evaluate as ev} from './harness.mjs';
const t=context.test;
let pad={axes:[0,0,0,0],buttons:Array.from({length:16},()=>({pressed:false}))};context.navigator.getGamepads=()=>[pad];
function release(){pad.buttons.forEach(b=>b.pressed=false);ev('pollPad()')}
function press(index){pad.buttons[index].pressed=true;ev('pollPad()');}
// Real pad dispatcher, with minimal DOM focus plumbing supplied by the VM harness.
t.start(true);document.querySelector('#menu').children=[nodes.get('#start'),nodes.get('#menuSettings')];nodes.get('#start').focus();press(0);assert.equal(ev('overlay'),'#runSetup');assert.equal(t.state.mode,'menu');ev('pollPad()');assert.equal(t.state.mode,'menu','Held opening press must not start the run');release();
const name=nodes.get('#playerName');name.tagName='INPUT';name.type='text';name.value='';nodes.get('#nameKeyboard').parentElement={open:false};nodes.set('#nameKeyboard button',nodes.get('#nameKeyboard').children[0]);
const begin=new Element();begin.onclick=()=>nodes.get('#runForm').onsubmit({preventDefault(){}});nodes.get('#runSetup').children=[name,...nodes.get('#nameKeyboard').children,begin,nodes.get('#cancelRun')];
name.focus();press(0);release();assert.equal(nodes.get('#nameKeyboard').parentElement.open,true);press(0);release();assert.equal(name.value,'A');begin.focus();press(0);release();assert.equal(t.state.mode,'play');assert.equal(ev('runName'),'A');
press(7);t.update(1/60);assert.ok(t.state.shots.length);release();press(9);release();assert.equal(t.state.mode,'pause');const time=t.state.elapsed;t.update(1);assert.equal(t.state.elapsed,time);
nodes.get('#pauseMenu').children=[nodes.get('#resume')];nodes.get('#resume').focus();press(0);release();assert.equal(t.state.mode,'play');assert.equal(ev('gamepadFire'),false);
ev("rewards.add('pad-mod','major');showReward()");nodes.get('#choice').children=nodes.get('#cards').children;nodes.get('#choice').children[0].focus();press(0);release();assert.equal(ev('build.mods.length'),1);assert.equal(t.state.mode,'play');
t.pause();nodes.get('#endRun').onclick();nodes.get('#start').focus();press(0);release();assert.equal(ev('overlay'),'#runSetup');t.closePanel();
// Touch fire uses the same recovery, and rebound keyboard selection cannot reset it.
t.start();t.equip(4);nodes.get('#fireTouch').onpointerdown({pointerId:1,preventDefault(){}});t.update(1/60);const remaining=ev('fireTimer');listeners.get('keydown')({code:'Digit5',preventDefault(){}});assert.equal(ev('fireTimer'),remaining);nodes.get('#fireTouch').onpointerup();
t.start();t.equip(2);ev("build.dash='echo';mouse.moved=false;player.extra=1");t.dash();assert.equal(t.state.shots.length,0);t.pause();const life=ev('dashEffects.echo.life');t.update(1);assert.equal(ev('dashEffects.echo.life'),life);t.pause();t.setKeys({Mouse0:true});t.update(1/60);assert.equal(t.state.shots.filter(b=>b.generation===1).length,8,'Held fire echoes the entire extra-pellet shotgun volley');assert.equal(ev('dashEffects.echo'),null);t.start();assert.equal(ev('dashEffects.wake.length'),0);
console.log('PASS input paths: pad username/menu/run/pause/draft/retry, touch fire, keyboard reselection, held-fire Echo and pause/reset.');
