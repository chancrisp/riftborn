import {BALANCE as B} from './progression.js?v=15';
// Bounded secondary effects use the same collision and damage functions as primary
// weapons. Shot groups are shared by all pellets from one trigger pull.
export class CombatEffects{
 constructor(api){this.api=api;this.scars=[];this.pulls=[];this.scarTicks=new Map()}
 clear(){for(const e of [...this.scars,...this.pulls])this.api.remove(e.visual);this.scars=[];this.pulls=[];this.scarTicks.clear()}
 enabled(b,id){return b.generation===0&&b.sourceWeapon===id&&this.api.build().mods.includes(id)}
 hit(b,e,p,killed){
  const a=this.api,angle=Math.atan2(b.vx,b.vz),group=b.group;
  if(this.enabled(b,0)&&!b.split){b.split=true;for(const offset of [-.45,.45])a.secondary(b,p,angle+offset,B.splinter,16)}
  if(this.enabled(b,1)&&!group.charged){group.charged=true;const build=a.build();build.charge++;
   if(build.charge>=B.stormHits){build.charge=0;let origin=p;const visited=new Set([e.id]);
    for(let i=0;i<B.stormTargets;i++){
     const next=a.targets().filter(t=>t.hp>0&&!visited.has(t.id)&&Math.hypot(t.x-origin.x,t.z-origin.z)<=B.stormRadius&&a.clear(origin,a.center(t))).sort((x,y)=>Math.hypot(x.x-origin.x,x.z-origin.z)-Math.hypot(y.x-origin.x,y.z-origin.z))[0];if(!next)break;
     const end=a.center(next);a.flash(origin,end,'#89cbd7');a.damage(next,b.damage*B.stormDamage,false,{...b,generation:1});visited.add(next.id);origin=end;
    }
   }
  }
  if(this.enabled(b,2)&&killed&&!group.grave&&Math.hypot(e.x-b.origin.x,e.z-b.origin.z)<=B.graveRange){group.grave=true;for(let i=0;i<B.graveFragments;i++)a.secondary(b,p,angle+(i-2)*.16,B.graveDamage,10)}
 }
 travel(b,from,to){
  if(!this.enabled(b,3)||Math.hypot(to.x-from.x,to.y-from.y,to.z-from.z)<.001)return;
  let scar=this.scars.find(s=>s.b===b);
  if(!scar){if(this.scars.length>=B.maxScars){const old=this.scars.shift();this.api.remove(old.visual)}scar={b,from:{...from},to:{...to},life:B.scarLife,ticks:new Map(),visual:this.api.line(from,to,'#c3a4d4')};this.scars.push(scar)}
  scar.to={...to};this.api.lineUpdate(scar.visual,scar.from,to);
 }
 impact(b,p){
  if(b.detonated)return;b.detonated=true;
  if(this.enabled(b,4)){
   // Overflow resolves immediately instead of losing the rocket's damage.
   if(this.pulls.length>=B.maxPulls){const old=this.pulls.shift();this.detonate(old)}
   this.pulls.push({b,p,life:B.pullLife,visual:this.api.orb(p,B.pullRadius,'#b891cf')});
  }else this.api.explode(p,b);
 }
 detonate(p){this.api.remove(p.visual);this.api.explode(p.p,p.b)}
 tick(dt){
  const a=this.api;for(const [id,t] of this.scarTicks){if(t<=dt)this.scarTicks.delete(id);else this.scarTicks.set(id,t-dt)}
  for(const s of this.scars){s.life-=dt;
   for(const e of a.targets())if(e.hp>0&&(this.scarTicks.get(e.id)||0)<=0&&a.hit(s.from,s.to,e)){this.scarTicks.set(e.id,B.scarTick);a.damage(e,s.b.damage*B.scarDamage,false,{...s.b,generation:1})}
   if(s.life<=0)a.remove(s.visual);
  }this.scars=this.scars.filter(s=>s.life>0);
  for(const p of this.pulls){p.life-=dt;for(const e of a.targets()){
   if(e.hp<=0||e.kind==='warden'||e.miniboss||e.fixed)continue;
   const dx=p.p.x-e.x,dz=p.p.z-e.z,d=Math.hypot(dx,dz);if(d>.4&&d<B.pullRadius&&a.clear(a.center(e),p.p))a.move(e,dx/d*Math.min(d-.4,B.pullSpeed*dt),dz/d*Math.min(d-.4,B.pullSpeed*dt));
  }if(p.life<=0)this.detonate(p)}this.pulls=this.pulls.filter(p=>p.life>0);
 }
}
