// A designated roster, never the ambient population, determines trial victory.
// Cleanup calls abandon, never defeat. Register descendants before removing a parent.
export class SkullTrial{
 constructor(stage){this.id='trial:'+stage;this.stage=stage;this.state='available';this.roster=new Set();this.statue=null}
 activate(ids,applyCurse){if(this.state!=='available'||!ids.length)return false;this.roster=new Set(ids);this.state='active';applyCurse();return true}
 descendant(parent,id){if(this.state==='active'&&this.roster.has(parent))this.roster.add(id)}
 defeat(id){if(this.state!=='active'||!this.roster.delete(id))return false;if(this.roster.size)return false;this.state='completed';return true}
 claim(){if(this.state!=='completed')return false;this.state='claimed';return true}
 abandon(){if(['active','completed'].includes(this.state)){this.state='abandoned';this.roster.clear();return true}return false}
}
export const TRIAL_NAMES=['HUNT THE RESTLESS','QUARRY HUNT','VENT HUNT','ANCHOR GUARD'];
// Validate all placements before consuming a statue. safeNear must find distinct,
// traversable sites, not silently clamp the roster into the same blocked cell.
export function trialLocations(terrain,statue,count=4,player=null){
 const sites=[];
 for(let i=0;i<32&&sites.length<count;i++){
  const a=i*Math.PI*2/13,r=5+Math.floor(i/13)*2,p=terrain.safeNear(statue.x+Math.sin(a)*r,statue.z+Math.cos(a)*r,1.2);
  if(!p||(player&&Math.hypot(p.x-player.x,p.z-player.z)<6)||!terrain.clear(p.x,p.z,1.2)||Math.hypot(p.x-statue.x,p.z-statue.z)>13||sites.some(s=>Math.hypot(s.x-p.x,s.z-p.z)<3))continue;
  sites.push(p);
 }
 return sites.length===count?sites:[];
}
