// Device-local, visual-only progress. Never use this profile for combat stats.
export const PROFILE_KEY='riftborn-profile-v1';
export const BESTIARY={
 runner:['Restless','Chases directly. Keep moving and use open firing lanes.'],skitter:['Skitter','Fast, weaving crawler. Standing-height bullets can hit it.'],gunner:['Spitter','Keeps its distance and fires a three-shot fan. Strafe across its aim.'],charger:['Charger','Warns before a straight rush. Move sideways during the windup.'],brute:['Brute','Slow, tough, with a delayed close slam. Leave its marked circle.'],mortar:['Mortar','Targets your predicted position. Change direction after the warning.'],sniper:['Sniper','Telegraphs a long shot. Cross its line or break sight with cover.'],leaper:['Leaper','Leaps after a windup and blasts its landing. Keep clear of the marker.'],splitter:['Splitter','Death releases two weakened crawlers. Save space for the children.'],stormer:['Stormer','Circles and fires eight radial shots. Use the gaps or solid cover.'],revenant:['Revenant','Death Mode: a brief warned rush. Sidestep, then fire during recovery.'],hexer:['Hexer','Death Mode: five delayed cross blasts. Move beyond the cross.'],broodmother:['Broodmother','Death Mode: summons crawlers. Attack the mother to stop new summons.'],ironmaw:['Iron Maw','Quarry guardian. Bait a committed charge into solid cover for 2s of vulnerability.'],warden:['Rift Warden','Alternates rings and ground blasts. Below half health, destroy both charging nodes to expose it.']
};
const fresh=()=>({version:1,lastUsername:'',enemies:{},milestones:[],cosmetics:{badge:'none',trail:'normal'},scoreBests:{},runs:[]});
export function loadProfile(storage){
 const p=fresh();let raw;try{raw=JSON.parse(storage?.getItem(PROFILE_KEY)||'null')}catch{return p}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return p;
 if(typeof raw.lastUsername==='string')p.lastUsername=raw.lastUsername.trim().slice(0,16);
 for(const [k,v] of Object.entries(raw.enemies||{}))if(BESTIARY[k]&&v&&typeof v==='object')p.enemies[k]={seen:!!v.seen,defeated:Number.isSafeInteger(v.defeated)?Math.max(0,Math.min(v.defeated,1e7)):0};
 p.milestones=['trial','quarry','warden'].filter(k=>Array.isArray(raw.milestones)&&raw.milestones.includes(k));
 equipCosmetic(p,'badge',raw.cosmetics?.badge);equipCosmetic(p,'trail',raw.cosmetics?.trail);
 if(Array.isArray(raw.runs))p.runs=raw.runs.filter(r=>r&&typeof r.id==='string'&&typeof r.name==='string'&&Number.isFinite(r.score)).slice(0,50);
 for(const [key,value] of Object.entries(raw.scoreBests||{}))if(/^[a-z0-9-]+:(normal|death)$/.test(key)&&Number.isFinite(value)&&value>=0)p.scoreBests[key]=value;
 for(const r of p.runs)rememberBest(p,r);
 return p;
}
export function saveProfile(storage,p){try{if(!storage)return false;storage.setItem(PROFILE_KEY,JSON.stringify(p));return true}catch{return false}}
export function award(p,key,eligible){if(!eligible||!['trial','quarry','warden'].includes(key)||p.milestones.includes(key))return false;p.milestones.push(key);return true}
export function recordEnemy(p,key,defeated,eligible){if(!eligible||!BESTIARY[key])return;const e=p.enemies[key]||(p.enemies[key]={seen:true,defeated:0});e.seen=true;if(defeated)e.defeated++}
export function equipCosmetic(p,slot,value){
 if(slot==='badge'&&['none','skull'].includes(value)&&(value==='none'||p.milestones.includes('trial'))){p.cosmetics.badge=value;return true}
 if(slot==='trail'&&['normal','ember'].includes(value)&&(value==='normal'||p.milestones.includes('warden'))){p.cosmetics.trail=value;return true}return false;
}
function rememberBest(p,run){if(typeof run.death_mode!=='boolean'||!run.gameplay_version)return;const key=run.gameplay_version+':'+(run.death_mode?'death':'normal');p.scoreBests[key]=Math.max(p.scoreBests[key]||0,run.score)}
export function rememberRun(p,run){rememberBest(p,run);if(p.runs.some(r=>r.id===run.id))return;p.runs.unshift({...run});p.runs=p.runs.slice(0,50)}
