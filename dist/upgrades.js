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
