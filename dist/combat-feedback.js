// One subordinate build cue; per-family cooldowns prevent pellets from flooding it.
export const WEAPON_FEEDBACK=[
 {recoil:.62,flash:5,particles:3,shake:0,hit:3},
 {recoil:.32,flash:2.5,particles:1,shake:0,hit:2},
 {recoil:1,flash:7,particles:8,shake:.045,hit:5},
 {recoil:.9,flash:5,particles:3,shake:.035,hit:7},
 {recoil:1,flash:6,particles:6,shake:.06,hit:4}
];
const copy={splinter:'SPLINTER · SPLIT',storm:'STORM NEEDLE · ARC',stormEmpty:'STORM NEEDLE · DISCHARGED',grave:'GRAVEBURST',scar:'RIFT SCAR · ACTIVE',pull:'EVENT HORIZON · PULL',detonate:'EVENT HORIZON · DETONATE',echoReady:'RIFT ECHO · READY',echoExpired:'RIFT ECHO · EXPIRED',echo:'RIFT ECHO · VOLLEY',wake:'VOID WAKE · TRAIL'};
export class BuildFeedback{
 constructor(){this.clear()}
 clear(){this.text='';this.life=0;this.cooldowns={};this.serial=0}
 emit(type){if(type==='echoCancel'){if(this.text===copy.echoReady){this.text='';this.life=0}return false}if(!copy[type]||this.cooldowns[type]>0)return false;this.text=copy[type];this.life=1.1;this.cooldowns[type]=type==='scar'||type==='wake'?2:1.2;this.serial++;return true}
 tick(dt){this.life=Math.max(0,this.life-dt);if(!this.life)this.text='';for(const k in this.cooldowns)this.cooldowns[k]=Math.max(0,this.cooldowns[k]-dt)}
}
