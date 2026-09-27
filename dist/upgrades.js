import {BALANCE as B,MODS} from './progression.js?v=17';
// One calculation path for combat and reward previews. No theoretical DPS claims.
export const UPGRADE_INFO=[
 ['Overclock','ϟ','All weapons: fire 18% faster.'],['Heavy rounds','✦','All weapons: 25% more base damage.'],
 ['Forked chamber','⑂','All weapons: one extra projectile.'],['Phase armor','⬡','Gain 20 max integrity and heal up to 45.'],
 ['Gravity well','◎','Collect shards from farther away.'],['Ghost rounds','➜','Bullets pierce +1 target. No rocket penetration.'],
 ['Rush circuit','»','Move 14% faster.'],['Deadeye','◇','Bullets and Havoc blasts: +15% critical chance, capped at 90%.'],['Repair field','✚','Recover 1 integrity each second.']
];
export function shotStats(p,w,boons={}){return {interval:w.cooldown/p.rate/(boons.rapid?1.5:1),damage:w.damage*p.damage,count:w.count+p.extra,pierce:w.rocket?0:w.pierce+p.pierce,crit:p.crit}}
export function applyUpgrade(p,id){switch(id){case 0:p.rate*=1.18;break;case 1:p.damage*=1.25;break;case 2:p.extra++;break;case 3:p.max+=20;p.hp=Math.min(p.max,p.hp+45);break;case 4:p.magnet+=2;break;case 5:p.pierce++;break;case 6:p.speed*=1.14;break;case 7:p.crit=Math.min(.9,p.crit+.15);break;case 8:p.regen++;break}return p}
export function upgradePreview(p,id,w,boons={}){
 const next=applyUpgrade({...p},id),a=shotStats(p,w,boons),b=shotStats(next,w,boons),f=n=>Number(n>0&&n<1?n.toPrecision(3):n.toFixed(2)),pair=(x,y,s='')=>`${f(x)}${s} → ${f(y)}${s}`;
 return [
  `${w.label} interval ${pair(a.interval,b.interval,'s')}${boons.rapid?' · Rapid Fire active':''}`,
  `${w.label} ${w.rocket?'base blast':'damage per projectile'} ${pair(a.damage,b.damage)}`,
  `${w.label} projectiles ${pair(a.count,b.count)}`,
  `Max integrity ${pair(p.max,next.max)} · Heal ${f(next.hp-p.hp)}`,
  `Shard reach ${pair(p.magnet,next.magnet,'m')}`,
  w.rocket?'Havoc unchanged · +1 penetration for the other four weapons':`${w.label} extra targets ${pair(a.pierce,b.pierce)}`,
  `Base speed ${pair(p.speed,next.speed,'m/s')}`,
  `Critical chance ${pair(p.crit*100,next.crit*100,'%')}`,
  `Recovery ${pair(p.regen,next.regen,' HP/s')}`
 ][id];
}

const previewNumber=n=>n>0&&n<1?Number(n.toPrecision(3)):Math.round((n+Number.EPSILON*Math.abs(n))*100)/100;
const withTip=(detail,tip)=>detail+' Tip: '+tip;
// Pass the offered mod's weapon (WEAPONS[id]), not the equipped weapon.
// Base damage excludes critical rolls and target-specific damage modifiers.
// Chain/scar damage never crits; secondary bullets and echoes may crit normally.
export function modPreview(p,id,w,boons={}){
 if(!Number.isInteger(id)||id<0||id>4)return '';
 const s=shotStats(p,w,boons),f=previewNumber;
 if(id===0)return withTip(`First hit/projectile: 2 × ${f(s.damage*B.splinter)} base dmg. Splinters cannot split again.`,
  p.extra>0?`Your ${s.count} primary rounds can each split.`:p.pierce>0?`Your splinters pierce ${p.pierce} extra targets.`:p.damage>1?'Heavy Rounds strengthens splinters too.':'Add Forked Chamber for more splitting rounds.');
 if(id===1)return withTip(`${B.stormHits} connected pulls → up to ${B.stormTargets} arcs × ${f(s.damage*B.stormDamage)} non-critical base dmg; ${B.stormRadius}m/hop, cover blocks.`,
  p.extra>0?`${s.count} shots still give 1 charge/pull.`:p.rate>1||boons.rapid?`Your ${f(s.interval)}s shot interval helps build charge.`:p.damage>1?'Heavy Rounds strengthens each arc.':'Add Overclock to connect pulls faster.');
 if(id===2)return withTip(`Primary kill within ${B.graveRange}m → ${B.graveFragments} × ${f(s.damage*B.graveDamage)} base dmg; once/pull.`,
  p.extra>0?`${s.count} pellets still give one burst/pull.`:p.pierce>0?`Your fragments pierce ${p.pierce} extra targets.`:p.damage>1?'Heavy Rounds strengthens fragments too.':'Add Heavy Rounds for stronger fragments.');
 if(id===3)return withTip(`${f(s.damage*B.scarDamage)} non-critical base dmg/target every ${B.scarTick}s for ${B.scarLife}s; shared across scars, cover blocks.`,
  p.extra>0?'Extra rails widen coverage, not tick rate.':p.damage>1?'Heavy Rounds strengthens every scar tick.':p.rate>1||boons.rapid?'Faster fire adds traces, not faster ticks.':'Add Heavy Rounds for stronger scar ticks.');
 return withTip(`Pull ordinary foes within ${B.pullRadius}m for ${B.pullLife}s → ${f(s.damage)} base blast dmg, ${w.radius}m radius; one blast/rocket. Bosses resist pull.`,
  p.extra>0?`Your ${s.count} rockets each pull and blast.`:p.crit>.1?'Deadeye: one critical roll per blast.':p.damage>1?'Heavy Rounds strengthens each blast.':'Add Forked Chamber for more pull/blast sites.');
}

// Pass 'echo'/'wake', the equipped weapon, and the current run build.
export function dashPreview(p,trait,w,boons={},build={}){
 const mods=build.mods||[],f=previewNumber;
 if(trait==='echo'){
  const s=shotStats(p,w,boons);
  return withTip(`${w.label} echo: ${s.count} × ${f(s.damage*B.echoDamage)} base dmg from dash origin. Next volley within ${B.echoWindow}s; once/dash, no mod triggers.`,
   p.extra>0?"Forked Chamber's extra shots repeat.":mods.some(id=>MODS[id]?.weapon===w.label)?'Your mod stays on the primary volley.':p.damage>1?'Heavy Rounds strengthens the echo too.':'Add Forked Chamber to repeat more shots.');
 }
 if(trait==='wake')return withTip(`${B.wakeLife}s trail: ordinary foes move at ${f(B.wakeSlow*100)}% speed (${f((1-B.wakeSlow)*100)}% slow). No stacking; bosses resist.`,
  mods.includes(3)?'Slow foes along your Rift Scars.':mods.includes(4)?'Slow foes near your delayed Havoc blast.':mods.includes(2)?`Slow foes to keep Graveburst kills within ${B.graveRange}m.`:mods.includes(1)?'Slow foes to connect your Storm Needle pulls.':w.count>1?'Slow foes for close Scatter volleys.':'Slow pursuers to line up your next volley.');
 return '';
}
