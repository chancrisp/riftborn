// Gameplay always advances in 1/60-second steps, independently of render cadence.
// Up to 15 steps (250 ms) are serviced. Longer stalls discard debt, so returning
// from a hidden tab or blocked main thread never unleashes a lethal catch-up burst.
export class SimulationClock {
 constructor(){this.debt=0;this.dropped=0;this.steps=0}
 reset(){this.debt=0}
 advance(raw,active,step){
  if(!active||!Number.isFinite(raw)||raw<0){this.reset();return 0}
  if(raw>.25){this.dropped+=raw;this.reset();return 0}
  this.debt+=raw;let n=0;
  while(this.debt+1e-9>=1/60&&n<15){this.debt-=1/60;n++;this.steps++;if(step(1/60)===false){this.reset();break}}
  return n;
 }
}

// One edge-triggered menu owner. A press opening a panel cannot confirm it too.
export class PadMenu {
 constructor(){this.direction=0;this.next=0}
 directionAt(p,now){
  const v=p.buttons[12]?.pressed?-1:p.buttons[13]?.pressed?1:p.buttons[14]?.pressed?-1:p.buttons[15]?.pressed?1:Math.abs(p.axes[1]||0)>.55?Math.sign(p.axes[1]):Math.abs(p.axes[0]||0)>.55?Math.sign(p.axes[0]):0;
  if(!v){this.direction=0;return 0}
  if(v!==this.direction){this.direction=v;this.next=now+.35;return v}
  if(now>=this.next){this.next=now+.14;return v}return 0;
 }
}
