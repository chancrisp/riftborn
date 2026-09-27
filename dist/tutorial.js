// TUTORIAL REFERENCE: steps advance only on their matching action. UI text is generated from current bindings and input device.
export const TUTORIAL_PORTAL=[0,-20];
export const TUTORIAL_GOAL=5;
const steps=['move','dash','shoot','weapon','combat','rift'];
export function createTutorial(){
 return {step:'move',distance:0,kills:0,initialWeapon:0,
  advance(action,value=0){
   const before=this.step;
   if(this.step==='move'&&action==='move'){this.distance+=value;if(this.distance>=5)this.step='dash'}
   else if(this.step==='dash'&&action==='dash')this.step='shoot';
   else if(this.step==='shoot'&&action==='shoot'){this.initialWeapon=value;this.step='weapon'}
   else if(this.step==='weapon'&&action==='weapon'&&value!==this.initialWeapon)this.step='combat';
   else if(this.step==='combat'&&action==='kill'){this.kills++;if(this.kills>=TUTORIAL_GOAL)this.step='rift'}
   return this.step!==before;
  },
  get number(){return steps.indexOf(this.step)+1}
 };
}

export function tutorialCopy(t,{bindings,keyLabel,input,weapon}){
 const key=action=>keyLabel(bindings[action]);
 const copy={
  move:['MOVE',input==='touch'?'Use the left stick to move.':input==='pad'?'Left stick · Move around the courtyard.':`${['forward','left','back','right'].map(key).join(' / ')} · Move around the courtyard.`],
  dash:['DASH',input==='touch'?'Tap DASH while moving.':input==='pad'?'A · Dash while moving.':`${key('dash')} · Dash while moving.`],
  shoot:['AIM & FIRE',input==='touch'?'Right stick to aim. Hold FIRE to shoot.':input==='pad'?'Right stick to aim. Right trigger to fire.':`Aim with the mouse. Hold ${key('fire')} to fire.`],
  weapon:['SWITCH WEAPONS',input==='touch'?'Tap a different weapon along the bottom.':input==='pad'?'Use either bumper to switch weapons.':`${key('weapon1')}–${key('weapon5')} or click a weapon slot. Try another weapon.`],
  combat:['DEFEAT '+TUTORIAL_GOAL+' ENEMIES',`${t.kills} / ${TUTORIAL_GOAL} · Try your weapons on these slow enemies.`],
  rift:['ENTER THE RIFT','Follow the arrow. Step into the rift to finish.']
 };
 const [title,hint]=copy[t.step];return {title,hint,weapon:`${weapon.label} · ${weapon.description}`};
}
