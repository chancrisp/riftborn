import {EXTRA_SOUNDS,EXTRA_LAYERS,EFFECT_GAPS,ENEMY_VOICES,STEP_SOUNDS,AMBIENT_SOUNDS} from '../dist/audio-effects.js';
import {recordWeaponKill,recordDiscovery,completeMasteryRun,masteryEntries,trackMastery,cosmeticAvailable,COSMETICS} from '../dist/mastery.js';
import {createLandmark,LANDMARKS} from '../dist/landmarks.js';
import {CampaignSequence,EncounterPacing,movementResponse,STAGE_STORIES} from '../dist/campaign.js';
import {updateCutaway} from '../dist/occlusion.js';
import {BuildFeedback,WEAPON_FEEDBACK} from '../dist/combat-feedback.js';
import {dangerMarker,disposeMarker,chargePath} from '../dist/warnings.js';
import {ScoreOutbox} from '../dist/score-outbox.js';
import {compareRun} from '../dist/run-history.js';
import {UPGRADE_INFO,shotStats,applyUpgrade,upgradePreview,modPreview,dashPreview} from '../dist/upgrades.js';
import {loadProfile,saveProfile,award,recordEnemy,equipCosmetic,rememberRun,BESTIARY} from '../dist/profile.js';
import {CHALLENGE,NodeCharge,quarryImpact,anchorMultiplier} from '../dist/challenges.js';
import {DashEffects} from '../dist/dash-traits.js';
import {SkullTrial,TRIAL_NAMES,trialLocations} from '../dist/trials.js';
import {CombatEffects} from '../dist/combat-effects.js';
import {createBuild,RewardQueue,MODS,DASH_TRAITS,modOffer,shuffled,BALANCE,GAMEPLAY_VERSION} from '../dist/progression.js';
import {SimulationClock,PadMenu} from '../dist/simulation.js';
import {POWERUPS,DROP_LIFETIME,MAX_DROPS,STATUE_BONUS,rollPowerup,createBoons,collectBoon,tickBoons,absorbDamage,createStatues} from '../dist/encounters.js';
import {createTutorial,tutorialCopy,TUTORIAL_PORTAL,TUTORIAL_GOAL} from '../dist/tutorial.js';
import {createStorm} from '../dist/storm.js';
import {createMusicPlayer,scoreEvents,MusicIntensity} from '../dist/soundtrack.js';
import {renderHeight,fogRange,FramePacer} from '../dist/graphics.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createTerrain,randomSource} from '../dist/terrain.js';
import {buildStageWorld} from '../dist/scenery.js';
import {webcrypto} from 'node:crypto';
import * as Three from 'three';
import {traceWorld,hitBody,pointAt} from '../dist/ballistics.js';
import {retroMaterial,retroCharacter,retroResolution,RetroShader} from '../dist/retro.js';
import {WEAPONS,ENEMY_TYPES,DEATH_TYPES,RUN_MODES,enemyPool,movementVector,segmentHit} from '../dist/rules.js';
import {DEFAULT_BINDINGS,ACTION_LABELS,keyLabel,loadPreferences,assignBinding} from '../dist/preferences.js';

assert.equal(WEAPONS.length,5);assert.equal(Object.keys(ENEMY_TYPES).length,10);
for(let i=0;i<360;i++){
 const a=i*Math.PI/180,v=movementVector(Math.sin(a),Math.cos(a),.6);
 assert.ok(Math.abs(Math.hypot(v.x,v.z)-1)<1e-10);
}
assert.equal(Math.hypot(...Object.values(movementVector(.3,.4,0))),.5);
assert.ok(segmentHit(0,0,10,0,5,.2,.4));assert.ok(!segmentHit(0,0,10,0,5,2,.4));

class Element {
 constructor(){this.tagName='BUTTON';this.type='button';this.children=[];this.textContent='';this.style={setProperty(){}};this.classList={add(){},remove(){},toggle(){}};this.disabled=false}
 get firstElementChild(){return this.children[0]} appendChild(el){this.children.push(el)} replaceChildren(){this.children=[]} querySelector(){return new Element()}
 addEventListener(){} setAttribute(){} focus(){document.activeElement=this} click(){this.onclick?.()} closest(){return null} getClientRects(){return [1]} querySelectorAll(){return this.children} remove(){} setPointerCapture(){} getBoundingClientRect(){return {left:0,top:0,width:110,height:110}}
}
const listeners=new Map();
const nodes=new Map();const document={body:new Element(),querySelector(s){if(!nodes.has(s))nodes.set(s,new Element());return nodes.get(s)},querySelectorAll(s){return s==='.weapon'?nodes.get('#weapons').children:[]},createElement(){return new Element()},addEventListener(){}};
class Renderer {constructor(){this.shadowMap={};this.info={reset(){}}}setPixelRatio(){}setSize(){}}
class Composer {addPass(){}render(){}setSize(){}setPixelRatio(){}}
const context={EXTRA_SOUNDS,EXTRA_LAYERS,EFFECT_GAPS,ENEMY_VOICES,STEP_SOUNDS,AMBIENT_SOUNDS,recordWeaponKill,recordDiscovery,completeMasteryRun,masteryEntries,trackMastery,cosmeticAvailable,COSMETICS,createLandmark,LANDMARKS,CampaignSequence,EncounterPacing,movementResponse,STAGE_STORIES,updateCutaway,BuildFeedback,WEAPON_FEEDBACK,dangerMarker,disposeMarker,chargePath,ScoreOutbox,compareRun,UPGRADE_INFO,shotStats,applyUpgrade,upgradePreview,modPreview,dashPreview,randomSource,loadProfile,saveProfile,award,recordEnemy,equipCosmetic,rememberRun,BESTIARY,CHALLENGE,NodeCharge,quarryImpact,anchorMultiplier,DashEffects,SkullTrial,TRIAL_NAMES,trialLocations,CombatEffects,createBuild,RewardQueue,MODS,DASH_TRAITS,modOffer,shuffled,BALANCE,GAMEPLAY_VERSION,SimulationClock,PadMenu,T:{...Three,WebGLRenderer:Renderer},EffectComposer:Composer,RenderPass:class{},UnrealBloomPass:class{},OutputPass:class{},WEAPONS,ENEMY_TYPES,DEATH_TYPES,RUN_MODES,enemyPool,movementVector,segmentHit,DEFAULT_BINDINGS,ACTION_LABELS,keyLabel,loadPreferences,assignBinding,document,window:{__RIFTBORN_TEST__:true},navigator:{getGamepads:()=>[]},matchMedia:()=>({matches:false}),devicePixelRatio:1,innerWidth:1280,innerHeight:800,performance,crypto:webcrypto,console:{...console,error(...args){if(args[0]!=='Audio startup failed')console.error(...args)}},setTimeout:()=>0,clearTimeout(){},requestAnimationFrame(){},addEventListener(name,fn){listeners.set(name,fn)},fetch:async()=>({ok:true,json:async()=>({scores:[]})})};
Object.assign(context,{POWERUPS,DROP_LIFETIME,MAX_DROPS,STATUE_BONUS,rollPowerup,createBoons,collectBoon,tickBoons,absorbDamage,createStatues,createTutorial,tutorialCopy,TUTORIAL_PORTAL,TUTORIAL_GOAL,createStorm,createMusicPlayer,MusicIntensity,renderHeight,fogRange,FramePacer,traceWorld,hitBody,pointAt,createTerrain,buildStageWorld,retroMaterial,retroCharacter,retroResolution,RetroShader,ShaderPass:class{}});
vm.createContext(context);
const source=fs.readFileSync(new URL('../dist/game.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
vm.runInContext(source+`\n globalThis.test={height,start,update,equip,spawnEnemy,dash,fire,enemyUpdate,levelUp,hero,scene,updateEffects,pause,openPanel,closePanel,prefs,finishRun,activatePortal,enterStage,hurtEnemy,bossUpdate,updateCombatUI,moveWithCollision,portalBearing,setNightmare,ambient,sun,rim,storm, get state(){return {player,mode,enemies,shots,hazards,kills,score,elapsed,stage,stageKills,stageGoal,portalActive,bossSpawned,victory,gems,portal:stagePortal.position}},setAim(v){aim=v;aimPitch=0},setKeys(v){keys=v},setStick(v){aimStick=v},setMode(v){mode=v}}`,context);

export {context,nodes,listeners,document,Element};
export function evaluate(code){return vm.runInContext(code,context)}
