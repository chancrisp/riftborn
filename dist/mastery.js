// Bounded browser-local recognition only. These values never change combat stats.
const WEAPON_IDS=['rifle','stinger','scatter','lancer','havoc'];
export const LANDMARK_IDS=Object.freeze(['meadow-shrine','quarry-engine','caldera-reliquary','citadel-archive','void-memorial']);
export const MASTERY_KILL_TARGET=75;
export const MASTERY_RUN_LIMIT=256;
const ENTRY_IDS=[...WEAPON_IDS.map(id=>'weapon-'+id),'clean-maw','cursed-victory','world-discoverer'];
export const COSMETICS=Object.freeze([
 {slot:'badge',value:'none',label:'No badge',color:null},
 {slot:'badge',value:'skull',label:'Trial skull badge',color:'#f2af78'},
 {slot:'badge',value:'iron',label:'Iron Maw badge',color:'#b7d6e8'},
 {slot:'badge',value:'crown',label:'Cursed crown badge',color:'#e4b6ff'},
 {slot:'trail',value:'normal',label:'Normal trail',color:'#81ffff'},
 {slot:'trail',value:'ember',label:'Warden ember trail',color:'#f2af78'},
 {slot:'trail',value:'aurora',label:'Aurora trail',color:'#91cfff'}
].map(Object.freeze));
const validRunId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
export function normalizeMastery(raw){
 const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
 const kills=Array.isArray(source.weaponKills)?source.weaponKills:[];
 const discoveries=Array.isArray(source.discoveries)?source.discoveries:[];
 return {
  weaponKills:WEAPON_IDS.map((_,i)=>Number.isSafeInteger(kills[i])?Math.max(0,Math.min(MASTERY_KILL_TARGET,kills[i])):0),
  discoveries:LANDMARK_IDS.filter(id=>discoveries.includes(id)),
  challenges:{cleanMaw:source.challenges?.cleanMaw===true,cursedVictory:source.challenges?.cursedVictory===true},
  tracked:ENTRY_IDS.includes(source.tracked)?source.tracked:null,
  runIds:Array.isArray(source.runIds)?[...new Set(source.runIds.filter(validRunId))].slice(0,MASTERY_RUN_LIMIT):[]
 };
}
export function recordWeaponKill(profile,weaponIndex,eligible){
 if(eligible!==true||!profile||!Number.isInteger(weaponIndex)||weaponIndex<0||weaponIndex>=WEAPON_IDS.length)return false;
 const state=normalizeMastery(profile.mastery);
 if(state.weaponKills[weaponIndex]>=MASTERY_KILL_TARGET)return false;
 state.weaponKills[weaponIndex]++;profile.mastery=state;return true;
}
export function recordDiscovery(profile,landmarkId,eligible){
 if(eligible!==true||!profile||!LANDMARK_IDS.includes(landmarkId))return false;
 const state=normalizeMastery(profile.mastery);
 if(state.discoveries.includes(landmarkId))return false;
 state.discoveries=LANDMARK_IDS.filter(id=>id===landmarkId||state.discoveries.includes(id));profile.mastery=state;return true;
}
export function completeMasteryRun(profile,run,eligible){
 if(eligible!==true||!profile||!run||!validRunId(run.id))return false;
 const state=normalizeMastery(profile.mastery);
 if(state.runIds.includes(run.id))return false;
 // Keep recent outcome IDs independently of the shorter score-history list.
 state.runIds.unshift(run.id);state.runIds.length=Math.min(state.runIds.length,MASTERY_RUN_LIMIT);
 if(run.mawDefeated===true&&run.mawUntouched===true)state.challenges.cleanMaw=true;
 if(run.victory===true&&Number.isSafeInteger(run.statues)&&run.statues>=3)state.challenges.cursedVictory=true;
 profile.mastery=state;return true;
}
export function cosmeticAvailable(profile,slot,value){
 if(!COSMETICS.some(c=>c.slot===slot&&c.value===value))return false;
 const milestones=Array.isArray(profile?.milestones)?profile.milestones:[];
 if(slot==='badge'&&value==='none'||slot==='trail'&&value==='normal')return true;
 if(slot==='badge'&&value==='skull')return milestones.includes('trial');
 if(slot==='trail'&&value==='ember')return milestones.includes('warden');
 const state=normalizeMastery(profile?.mastery);
 if(slot==='badge'&&value==='iron')return state.challenges.cleanMaw;
 if(slot==='badge'&&value==='crown')return state.challenges.cursedVictory;
 return slot==='trail'&&value==='aurora'&&(state.weaponKills.some(k=>k>=MASTERY_KILL_TARGET)||state.discoveries.length===LANDMARK_IDS.length);
}
function entry(id,title,description,current,target,value){
 const cosmetic=COSMETICS.find(c=>c.value===value);
 return {id,title,description,current,target,complete:current>=target,reward:{slot:cosmetic.slot,value:cosmetic.value,label:cosmetic.label}};
}
export function masteryEntries(profile){
 const state=normalizeMastery(profile?.mastery);
 const entries=WEAPON_IDS.map((id,index)=>{
  const name=id[0].toUpperCase()+id.slice(1);
  return entry('weapon-'+id,name+' mastery','Credit 75 enemy kills to '+name+' across runs.',state.weaponKills[index],MASTERY_KILL_TARGET,'aurora');
 });
 entries.push(
  entry('clean-maw','Untouched by Iron','Defeat Iron Maw without taking damage during its encounter.',Number(state.challenges.cleanMaw),1,'iron'),
  entry('cursed-victory','Crowned in Curses','Win a run after activating at least 3 skull statues.',Number(state.challenges.cursedVictory),1,'crown'),
  entry('world-discoverer','World Discoverer','Discover the landmark in each of the 5 worlds.',state.discoveries.length,LANDMARK_IDS.length,'aurora')
 );
 return entries;
}
export function trackMastery(profile,id){
 if(!profile||id!==null&&!ENTRY_IDS.includes(id))return false;
 const state=normalizeMastery(profile.mastery);
 if(state.tracked===id)return false;
 state.tracked=id;profile.mastery=state;return true;
}
