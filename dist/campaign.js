// Campaign presentation and pacing are explicit, bounded state, separate from combat.
export const SEQUENCES={
 opening:{duration:2.8,title:'THE FIRST FRACTURE',text:'Five broken worlds. One way home. Find the rifts.'},
 stage:{duration:1.5,title:'BEYOND THE RIFT',text:'The fracture deepens.'},
 maw:{duration:2.4,title:'IRON MAW',text:'The quarry has a keeper. Bait its charge into solid cover.'},
 warden:{duration:3,title:'THE RIFT WARDEN',text:'The last rift is bound to its crown.'},
 phase:{duration:1.8,title:'THE CROWN BREAKS',text:'Destroy both charging nodes to expose the Warden.'},
 victory:{duration:4.5,title:'THE RIFT FALLS SILENT',text:'The crown is broken. For a moment, the worlds can breathe.'}
};
export class CampaignSequence{
 constructor(kind){this.kind=kind;this.age=0;this.paused=false;this.finished=false;this.definition=SEQUENCES[kind]||SEQUENCES.stage}
 get progress(){return Math.min(1,this.age/this.definition.duration)}
 tick(dt){if(this.finished||this.paused)return false;this.age+=Math.max(0,Math.min(.25,Number.isFinite(dt)?dt:0));return this.age>=this.definition.duration?this.skip():false}
 skip(){if(this.finished)return false;this.finished=true;return true}
}
export class EncounterPacing{
 constructor(){this.age=0;this.rest=3}
 tick(dt){this.age+=dt;this.rest=Math.max(0,this.rest-dt)}
 recover(seconds){this.rest=Math.max(this.rest,seconds)}
 allowSpawns(encounter=false){return this.rest<=0&&(encounter||this.age%32<26)}
}
// Faster braking and direction reversal reduce residual drift; top speed is unchanged.
export function movementResponse(current,target,dt){
 const stopping=Math.hypot(target.x,target.z)<.05,reversing=current.x*target.x+current.z*target.z<0;
 const response=1-Math.exp(-dt*(stopping?28:reversing?24:18));
 return {x:current.x+(target.x-current.x)*response,z:current.z+(target.z-current.z)*response};
}
export const STAGE_STORIES=[
 'The old paths still lead to the rift. Follow them.',
 'The miners dug until something answered.',
 'The mountain burns around a wound that will not close.',
 'The last defenders sealed their city from within.',
 'Every fracture ends beneath the same crown.'
];
