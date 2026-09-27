// MUSIC REFERENCE: scoreEvents composes sixteenth-note events; createMusicPlayer synthesizes each voice. Tune BPM in MUSIC_TEMPO and instrument levels in scoreEvents.
// Original arcade horror score: alternating 16-bar arrangements per mode and a
// separate restrained 16-bar menu theme. Context changes preserve transport.
export const MUSIC_TEMPO=Object.freeze({normal:140,death:168});
const pitch=(semitones)=>55*2**(semitones/12);
const hooks=[
 [12,null,19,15,null,12,10,null,12,15,19,null,22,19,15,null],
 [19,null,24,22,19,null,15,19,17,null,15,12,11,null,7,null],
 [24,null,null,19,null,null,15,null,22,null,null,19,null,null,11,null],
 [12,19,24,null,22,19,15,19,12,null,15,19,23,22,19,11]
];
const answers=[
 [19,null,15,12,null,10,12,15,19,22,null,24,23,null,19,null],
 [24,23,19,null,22,null,19,15,17,19,null,15,12,null,11,null],
 [31,null,null,null,27,null,26,null,24,null,null,null,23,null,19,null],
 [12,15,19,24,23,null,22,19,17,15,12,null,11,15,19,23]
];
const menuHooks=[
 [24,null,19,22],
 [19,15,null,12],
 [27,null,24,19],
 [23,19,15,null]
];

// Latch the requested arrangement at a bar boundary without resetting transport.
export class MusicIntensity{
 constructor(){this.reset()}
 reset(){this.current='normal'}
 at(step,target){if(step%16===0)this.current=['menu','quiet','normal','trial','boss'].includes(target)?target:'normal';return this.current}
}
export function scoreEvents(step,death=false,activity='normal'){
 const bar=Math.floor(step/16)%16,beat=step%16,section=Math.floor(bar/4),chord=bar%4,answer=Math.floor(step/256)%2===1;
 const root=(answer?[0,-2,-4,-5]:[0,-4,-2,-5])[chord],breakdown=section===2,climax=section===3;
 const sixteenth=60/(death?MUSIC_TEMPO.death:MUSIC_TEMPO.normal)/4,events=[];
 const add=(voice,gain,duration,semitones)=>events.push({voice,gain,duration,...(semitones===undefined?{}:{frequency:pitch(semitones)})});
 if(activity==='menu'){
  // Half-time phrases over the existing clock: no new timer, tempo, or reset.
  const chord=Math.floor(bar/2)%4,root=[0,-4,-2,-5][chord],upper=bar>=8?12:0;
  if(beat===0||beat===8)add('bass',.075,sixteenth*5,root+(beat===8?7:0));
  if(beat%4===0){const melody=menuHooks[bar%4][beat/4];if(melody!==null)add('pluck',.065,sixteenth*(beat===8?5.5:3),root+melody+upper)}
  if(beat===0&&bar%2===0)for(const interval of [0,chord===3?4:3,7])add('organ',.028,sixteenth*24,root+interval+12);
  if(beat===0&&bar%4===0)add('choir',.026,sixteenth*30,root+24);
  if(beat===14&&bar%2===1)add('bell',.042,1.6,root+31);
  return events;
 }
 // Syncopated bass leaves room for the kick. Death Mode adds octave answers and a dark semitone turn.
 const bass=(answer?[0,null,7,12,0,null,10,null,0,7,null,12,0,death?1:null,7,11]:[0,null,0,12,null,0,7,null,0,12,null,0,7,null,12,death?1:7])[beat];
 if(bass!==null&&(!breakdown||beat%4===0))add('bass',death?.36:.3,sixteenth*(beat%4===0?1.45:.8),root+bass);
 if(beat%4===0||(death&&!breakdown&&[3,10,14].includes(beat))||(climax&&beat===15))add('kick',.92,.22);
 if((breakdown?beat===8:beat===4||beat===12)||(bar%4===3&&beat>=14))add('snare',beat>=14?.31:.48,.16);
 if(!breakdown&&(beat%2===0||climax||death))add('hat',beat%4===2?.16:.075,beat%4===2?.11:.045);
 if(breakdown&&beat%4===2)add('hat',.08,.08);
 const melody=(answer?answers:hooks)[section][beat];
 if(melody!==null){
  // The final dominant chord raises its third, giving each phrase a gothic resolution.
  const note=root+melody+(chord===3&&melody%12===3?1:0);
  add('lead',breakdown?.12:death?.19:.17,sixteenth*(breakdown?2.7:1.3),note+12);
 }
 if(beat===0){
  for(const interval of [0,chord===3?4:3,7])add('organ',breakdown?.065:.045,sixteenth*(breakdown?15:10),root+interval+12);
  add('bell',.12,1.25,root+36+(bar%2?7:0));
 }
 if(beat===10&&bar%2===1)add('bell',.09,.85,root+31);
 if(climax&&beat===14)add('bell',.1,.8,root+36);
 // The return arrangement answers the lead with a glassy counterline, then opens
 // into a restrained synthetic choir. Both remain below the existing event cap.
 if(answer&&beat===0&&(breakdown||climax))for(const interval of [12,19])add('choir',breakdown?.037:.024,sixteenth*(breakdown?15:11),root+interval);
 if(answer&&!breakdown&&[6,14].includes(beat))add('pluck',death?.09:.075,sixteenth*1.7,root+[31,27,29,23][chord]+(beat===14?-5:0));
 if(activity==='quiet')return events.filter(n=>['bass','organ','bell','choir'].includes(n.voice)).map(n=>({...n,gain:n.gain*.7}));
 if(activity==='trial'||activity==='boss'){
  if(beat%4===2)add('bass',.1,sixteenth*.6,root+19+(death?1:0));
  if(activity==='boss'&&beat%4===2)add('bell',.06,.35,root+31);
  if(activity==='boss'&&beat%4===3)add('hat',.07,.035);
 }
 return events;
}

export function createMusicPlayer(ctx,bus){
 const voices=new Set(),metrics={peak:0,dropped:0};
 const compressor=ctx.createDynamicsCompressor();
 compressor.threshold.value=-15;compressor.knee.value=15;compressor.ratio.value=3;
 compressor.attack.value=.006;compressor.release.value=.18;compressor.connect(bus);
 const delay=ctx.createDelay(.5),feedback=ctx.createGain(),wet=ctx.createGain();
 delay.delayTime.value=.268;feedback.gain.value=.24;wet.gain.value=.19;
 delay.connect(feedback);feedback.connect(delay);delay.connect(wet);wet.connect(compressor);
 const noise=ctx.createBuffer(1,ctx.sampleRate,ctx.sampleRate),data=noise.getChannelData(0);
 let seed=9127;for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;data[i]=seed/2147483648}

 function envelope(time,duration,volume,attack=.005){
  const gain=ctx.createGain();gain.gain.setValueAtTime(.0001,time);
  gain.gain.linearRampToValueAtTime(volume,time+Math.min(attack,duration/3));
  gain.gain.exponentialRampToValueAtTime(.0001,time+duration);return gain;
 }
 function oscillator(frequency,type,time,duration,volume,{end,filter,echo=false,attack,pan=0}={}){
  if(voices.size>=96){metrics.dropped++;return}const osc=ctx.createOscillator(),gain=envelope(time,duration,volume,attack),nodes=[osc,gain];
  osc.type=type;osc.frequency.setValueAtTime(frequency,time);
  if(end)osc.frequency.exponentialRampToValueAtTime(end,time+duration);
  if(filter){const f=ctx.createBiquadFilter();f.type='lowpass';f.Q.value=.65;f.frequency.setValueAtTime(filter,time);f.frequency.exponentialRampToValueAtTime(Math.max(180,filter*.23),time+duration);osc.connect(f);f.connect(gain);nodes.push(f)}else osc.connect(gain);
  const stereo=ctx.createStereoPanner();stereo.pan.value=pan;gain.connect(stereo);stereo.connect(compressor);nodes.push(stereo);
  if(echo)stereo.connect(delay);
  voices.add(osc);metrics.peak=Math.max(metrics.peak,voices.size);osc.onended=()=>{voices.delete(osc);nodes.forEach(n=>n.disconnect())};osc.start(time);osc.stop(time+duration+.015);
 }
 function percussion(time,duration,volume,frequency,type){
  if(voices.size>=96){metrics.dropped++;return}const source=ctx.createBufferSource(),filter=ctx.createBiquadFilter(),gain=envelope(time,duration,volume,.002);
  source.buffer=noise;filter.type=type;filter.frequency.value=frequency;filter.Q.value=.65;
  source.connect(filter);filter.connect(gain);gain.connect(compressor);
  voices.add(source);metrics.peak=Math.max(metrics.peak,voices.size);source.onended=()=>{voices.delete(source);source.disconnect();filter.disconnect();gain.disconnect()};source.start(time);source.stop(time+duration+.01);
 }
 return {metrics,get active(){return voices.size},stop(){for(const voice of [...voices]){try{voice.stop()}catch{}voice.onended?.()}feedback.gain.value=0},schedule(step,time,death,volume=1,activity='normal'){
  if(volume<=0)return;
  feedback.gain.value=.24;for(const n of scoreEvents(step,death,activity)){
   const g=n.gain*volume,d=n.duration,f=n.frequency;
   switch(n.voice){
    case 'bass':oscillator(f,'sawtooth',time,d,g,{filter:death?2200:1500});oscillator(f/2,'sine',time,d,g*.4);break;
    case 'lead':oscillator(f,'sawtooth',time,d,g*.68,{filter:3200,echo:true,pan:-.17});oscillator(f*1.004,'square',time,d,g*.22,{filter:2400,echo:true,pan:.17});break;
    case 'organ':oscillator(f,'triangle',time,d,g,{attack:.035,pan:-.3});oscillator(f*2,'sine',time,d,g*.3,{attack:.045,pan:.3});break;
    case 'bell':oscillator(f,'sine',time,d,g,{echo:true,pan:.35});oscillator(f*2.76,'sine',time,d*.35,g*.2,{echo:true,pan:-.35});break;
    case 'choir':oscillator(f*.998,'triangle',time,d,g*.72,{filter:1250,attack:.13,pan:-.4});oscillator(f*1.002,'sawtooth',time,d,g*.2,{filter:850,attack:.17,echo:true,pan:.4});break;
    case 'pluck':oscillator(f,'triangle',time,d,g,{filter:2800,echo:true,pan:-.22});oscillator(f*2,'sine',time,d*.4,g*.22,{pan:.22});break;
    case 'kick':oscillator(145,'sine',time,d,g,{end:38});percussion(time,.015,g*.1,3000,'lowpass');break;
    case 'snare':percussion(time,d,g,1800,'bandpass');oscillator(190,'triangle',time,.085,g*.35,{end:95});break;
    case 'hat':percussion(time,d,g,6500,'highpass');break;
   }
  }
 }};
}
