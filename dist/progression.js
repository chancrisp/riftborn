// Run-only builds. Nothing here grants permanent combat strength.
export const GAMEPLAY_VERSION='builds-1';
export const BALANCE={splinter:.35,stormHits:7,stormTargets:3,stormRadius:7,stormDamage:.7,graveRange:8,graveFragments:5,graveDamage:.6,scarLife:1.4,scarTick:.3,scarDamage:.18,maxScars:12,pullLife:.45,pullRadius:5,pullSpeed:7,maxPulls:8,echoWindow:2,echoDamage:.5,wakeLife:2,wakeSlow:.6,maxWake:24};
export const MODS=[
 {name:'Splinter Rounds',weapon:'RIFLE',text:'First hit splits two 35% diagonal rounds. Splinters never split again.'},
 {name:'Storm Needle',weapon:'STINGER',text:'Seven connected trigger pulls chain to up to three nearby targets. Charge survives switching.'},
 {name:'Graveburst',weapon:'SCATTER',text:'A primary kill within 8m casts five 60% bone fragments. Once per trigger pull.'},
 {name:'Rift Scar',weapon:'LANCER',text:'Leaves a 1.4s damaging trace along its flight. Cover stops the scar.'},
 {name:'Event Horizon',weapon:'HAVOC',text:'Impact pulls ordinary enemies for 0.45s, then detonates once. Bosses resist.'}
];
export const DASH_TRAITS=[
 {id:'echo',name:'Rift Echo',text:'Next fired volley within 2s repeats from your old position at 50% damage. Echoes cannot trigger weapon mods.'},
 {id:'wake',name:'Void Wake',text:'Your traversed dash leaves a 2s slowing trail. Bosses resist; slows do not stack.'}
];
export function createBuild(){return {mods:[],ordinary:{},dash:null,charge:0}}
export function shuffled(items,random=Math.random){const a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
export function modOffer(build,random=Math.random){return shuffled(MODS.map((_,i)=>i).filter(i=>!build.mods.includes(i)),random).slice(0,3)}
export class RewardQueue{
 constructor(){this.events=[];this.seen=new Set()}
 add(key,type,done=null){if(this.seen.has(key))return false;this.seen.add(key);this.events.push({key,type,done});return true}
 next(){return this.events.shift()||null}
 get pending(){return this.events.length>0}
}
