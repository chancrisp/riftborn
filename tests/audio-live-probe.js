// Development-only probe: load before game.js to inspect the real graph reaching the output.
const NativeContext=window.AudioContext||window.webkitAudioContext;
const report=document.createElement('output');report.id='audioProbe';report.style='position:fixed;z-index:100;bottom:2px;left:2px;background:#111;color:#fff;padding:6px;font:12px monospace';document.body.appendChild(report);
let context=null,analyser=null,peak=0,currentPeak=0,resumes=0,initialState=null;
window.AudioContext=class extends NativeContext{
 constructor(...args){super(...args);context=this;initialState=this.state;analyser=this.createAnalyser();analyser.fftSize=2048;
  const create=this.createGain.bind(this);this.createGain=()=>{const node=create(),connect=node.connect.bind(node);node.connect=(destination,...rest)=>{if(destination===this.destination)connect(analyser);return connect(destination,...rest)};return node};
 }
 resume(){resumes++;return super.resume()}
};
setInterval(()=>{
 currentPeak=0;if(analyser){const data=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(data);for(const n of data){peak=Math.max(peak,Math.abs(n));currentPeak=Math.max(currentPeak,Math.abs(n))}}
 report.textContent=JSON.stringify({initialState,state:context?.state||'not created',resumes,outputPeak:Number(peak.toFixed(5)),currentPeak:Number(currentPeak.toFixed(5)),audioOutput:peak>.0005?'PASS':'waiting'});
},100);
