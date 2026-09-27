// GRAPHICS REFERENCE: fog ranges are world units. Keep the near distance beyond the camera/player gap; FPS pacing must never slow simulation.
export function renderHeight(pixelation,mobile=false,reduced=false){return pixelation==='auto'?(mobile||reduced?240:320):pixelation}
export function fogRange(amount,nightmare,viewDistance=36){if(amount===0)return {near:1000,far:1200};if(nightmare){const near=Math.max(viewDistance+3,43-amount*.08);return {near,far:near+22-amount*.12}}const strength=.5+amount/100;return {near:48/strength,far:135/strength}}
// Render pacing only. Input, physics and combat retain their own animation clock.
export class FramePacer{
 constructor(){this.next=null;this.cap=null}
 ready(now,cap){
  if(!cap){this.next=null;this.cap=cap;return true}
  const interval=1000/cap;
  if(cap!==this.cap||this.next===null){this.cap=cap;this.next=now+interval;return true}
  if(now+.01<this.next)return false;
  this.next+=(Math.max(0,Math.floor((now-this.next+.01)/interval))+1)*interval;return true;
 }
}
