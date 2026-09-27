export function renderHeight(pixelation,mobile=false,reduced=false){return pixelation==='auto'?(mobile||reduced?240:320):pixelation}
export function fogRange(amount,night){if(amount===0)return {near:1000,far:1200};const strength=.5+amount/100;return {near:(night?45:48)/strength,far:(night?120:135)/strength}}
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
