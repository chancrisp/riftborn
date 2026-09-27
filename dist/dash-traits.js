import {BALANCE as B} from './progression.js?v=17';
export class DashEffects{
 constructor(api){this.api=api;this.echo=null;this.wake=[]}
 clear(){if(this.echo)this.api.remove(this.echo.visual);for(const s of this.wake)this.api.remove(s.visual);this.echo=null;this.wake=[]}
 begin(origin){
  if(this.echo)this.api.remove(this.echo.visual);this.echo=null;
  if(this.api.trait()==='echo'&&this.api.valid(origin,origin))this.echo={origin:{...origin},life:B.echoWindow,visual:this.api.ghost(origin)};if(this.echo)this.api.event?.('echoReady');
 }
 shot(target,volley){if(!this.echo)return;const e=this.echo;this.echo=null;this.api.event?.('echoCancel');this.api.remove(e.visual);if(this.api.valid(e.origin,e.origin)&&this.api.fire(e.origin,{...target},volley))this.api.event?.('echo')}
 record(a,b){
  if(this.api.trait()!=='wake'||Math.hypot(a.x-b.x,a.z-b.z)<.05||!this.api.valid(a,b))return;
  if(this.wake.length>=B.maxWake)this.api.remove(this.wake.shift().visual);
  this.api.event?.('wake');this.wake.push({a:{...a},b:{...b},life:B.wakeLife,visual:this.api.line(a,b)});
 }
 slow(e){
  if(e.kind==='warden'||e.miniboss||e.fixed)return 1;
  return this.wake.some(s=>{const dx=s.b.x-s.a.x,dz=s.b.z-s.a.z,t=Math.max(0,Math.min(1,((e.x-s.a.x)*dx+(e.z-s.a.z)*dz)/(dx*dx+dz*dz||1)));return Math.hypot(e.x-s.a.x-t*dx,e.z-s.a.z-t*dz)<1.2})?B.wakeSlow:1;
 }
 tick(dt){if(this.echo){this.echo.life-=dt;if(this.echo.life<=0){this.api.event?.('echoExpired');this.api.remove(this.echo.visual);this.echo=null}}for(const s of this.wake){s.life-=dt;if(s.life<=0)this.api.remove(s.visual)}this.wake=this.wake.filter(s=>s.life>0)}
}
