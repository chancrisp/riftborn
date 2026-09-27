// Pure encounter decisions are separated from scene objects for deterministic tests.
export const CHALLENGE={quarryHP:680,quarryWindup:1.05,quarryCharge:.85,quarrySpeed:20,quarryStagger:2,quarryVulnerability:1.5,anchorHP:120,nodeHP:110,nodeDeadline:6,nodeCooldown:15,nodeEvents:3,ventWarning:1.5,ventActive:1.4,ventRecovery:2,ventDamage:26};
export const quarryImpact=(state,hit)=>state==='charge'&&hit?.kind==='structure';
export const anchorMultiplier=count=>Math.round((1-Math.min(3,Math.max(0,count))*.2)*10)/10;
export class NodeCharge{
 constructor(ids){this.nodes=new Set(ids);this.remaining=CHALLENGE.nodeDeadline;this.state='charging'}
 destroy(id){if(this.state==='charging')this.nodes.delete(id)}
 tick(dt){if(this.state!=='charging')return this.state;if(!this.nodes.size)this.state='interrupted';else if((this.remaining-=dt)<=0)this.state='attack';return this.state}
}
