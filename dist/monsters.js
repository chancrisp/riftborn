import * as T from 'three';

// Shared low-poly creature meshes; no soldier equipment or per-spawn geometry.
const shapes={flesh:new T.IcosahedronGeometry(1,0),limb:new T.CylinderGeometry(.65,.4,1,5),claw:new T.ConeGeometry(1,1,4),box:new T.BoxGeometry(1,1,1)};
const palettes={runner:['#75885a','#b2b58c'],skitter:['#67743b','#cad094'],gunner:['#78904a','#c6bc78'],charger:['#9c5146','#c8b591'],brute:['#756552','#b3a682'],mortar:['#697747','#b8c37c'],sniper:['#8a596f','#c5aaa3'],leaper:['#92663e','#c4ac77'],splitter:['#507c68','#99bea0'],stormer:['#55567d','#b3abca'],warden:['#705269','#d0baa0'],revenant:['#7e262d','#d8aaa0'],hexer:['#622944','#d7a0b0'],broodmother:['#552b32','#b8836e']};

export function createMonster(kind,material){
 const g=new T.Group(),body=new T.Group();g.add(body);
 const [hide,bone]=palettes[kind]||palettes.runner,legs=[],arms=[],appendages=[];
 function part(shape,color,x,y,z,sx,sy,sz,parent=body,tile=0){const m=new T.Mesh(shapes[shape],material(color,tile));m.position.set(x,y,z);m.scale.set(sx,sy,sz);parent.add(m);return m}
 function spike(x,y,z,sx,sy,angle=0,parent=body){const m=part('claw',bone,x,y,z,sx,sy,sx,parent,13);m.rotation.z=angle;return m}
 const crawler=['skitter','leaper','broodmother'].includes(kind),floating=['stormer','hexer'].includes(kind);
 const fat=['brute','mortar','splitter','broodmother'].includes(kind);
 part('flesh',hide,0,1.38,0,fat?.66:.43,fat?.67:.53,crawler?.57:.33);
 // Exposed rib plates and an angular open jaw read at the game's internal resolution.
 for(let i=0;i<3;i++)part('box',bone,0,1.55-i*.18,.29,.5-i*.05,.065,.065,body,13);
 const headY=crawler?1.45:1.96,headZ=crawler?.55:.14;
 part('flesh',bone,0,headY,headZ,.29,.34,.29);
 part('box','#271d22',0,headY-.16,headZ+.255,.35,.15,.09);
 for(const side of [-1,1]){
  part('box','#211921',side*.14,headY+.055,headZ+.255,.13,.12,.055);
  part('box',kind==='runner'?'#d3b77a':'#d77b65',side*.145,headY+.04,headZ+.288,.055,.055,.025);
  for(let i=0;i<2;i++)spike(side*(.055+i*.085),headY-.17,headZ+.31,.035,.12,Math.PI);
  const leg=new T.Group();leg.position.set(side*(crawler?.36:.23),1.03,-.04);body.add(leg);legs.push(leg);
  part('limb',hide,0,-.24,0,.28,.52,.26,leg);
  part('limb',bone,0,-.64,.02,.17,.35,.17,leg,13);
  part('flesh',hide,0,-.92,.14,.19,.12,.32,leg);
  const arm=new T.Group();arm.position.set(side*.44,1.7,0);body.add(arm);arms.push(arm);
  part('limb',hide,side*.05,-.26,0,.24,.58,.25,arm);
  part('limb',bone,side*.1,-.7,.05,.16,.43,.17,arm,13);
  for(let i=0;i<3;i++)spike(side*.1+(i-1)*.08,-.99,.13,.035,.25,Math.PI,arm);
  if(crawler){const limb=new T.Group();limb.position.set(side*.4,1.12,-.34);body.add(limb);appendages.push(limb);const upper=part('limb',hide,side*.22,-.25,0,.19,.8,.19,limb);upper.rotation.z=side*.9;spike(side*.48,-.68,.1,.075,.55,Math.PI,limb)}
 }
 let armPose=-.95;
 if(kind==='runner'){body.rotation.z=.08;arms[0].scale.y=1.2;part('box','#443f34',0,1.02,-.05,.52,.25,.36,body,1)}
 if(kind==='skitter'){g.scale.set(.9,.48,1.1);armPose=-1.45;for(const side of [-1,1])spike(side*.22,1.35,.85,.08,.55,side*1.1)}
 if(kind==='gunner'){part('flesh','#a6af55',0,1.76,.5,.3,.34,.33);part('box','#34432a',0,1.77,.79,.21,.2,.06);armPose=-.25}
 if(kind==='charger'){g.scale.set(1.15,1.05,1.1);for(const side of [-1,1]){const horn=spike(side*.34,2.23,.32,.13,.85,-side*.7);horn.rotation.x=.8}part('flesh','#51473e',0,1.64,-.22,.6,.48,.4)}
 if(kind==='brute'){g.scale.set(1.6,1.45,1.5);for(const side of [-1,1])part('flesh',hide,side*.61,.72,.15,.33,.34,.33);armPose=-.18}
 if(kind==='mortar'){g.scale.set(1.12,1.03,1.18);for(const side of [-1,1])part('flesh','#afaa53',side*.3,1.65,-.35,.37,.49,.4);spike(0,2.07,-.2,.2,.5);armPose=-.3}
 if(kind==='sniper'){g.scale.set(.82,1.18,.85);for(let i=0;i<4;i++)spike((i-1.5)*.18,2.27,0,.055,.4+(i%2)*.3,(i-1.5)*.4);spike(0,1.97,.63,.12,.8).rotation.x=Math.PI/2;armPose=-.4}
 if(kind==='leaper'){g.scale.set(1.1,.72,1.2);for(const side of [-1,1])part('flesh',hide,side*.46,.65,-.32,.35,.4,.38);armPose=-1.6}
 if(kind==='splitter'){g.scale.set(1.18,1.05,1.16);for(const side of [-1,1])for(let j=0;j<2;j++)part('flesh','#b9c28e',side*.5,1.25+j*.36,-.25,.28,.28,.28);armPose=-.4}
 if(floating){legs.forEach(l=>l.visible=false);part('flesh',hide,0,1.25,-.18,.65,.65,.52);for(let i=0;i<5;i++){const tendril=new T.Group();tendril.position.set((i-2)*.2,1.02,-.05);body.add(tendril);appendages.push(tendril);spike(0,-.3,0,.1,.8,Math.PI+(i-2)*.1,tendril)}for(const side of [-1,1])spike(side*.47,1.99,0,.1,.6,-side*.85);armPose=-1.5}
 if(kind==='warden'){g.scale.set(2.25,2.4,2.05);for(const side of [-1,1]){spike(side*.33,2.44,0,.13,.8,-side*.4);spike(side*.66,1.86,0,.2,.6,-side*1.1)}part('flesh','#382a3b',0,1.5,-.3,.68,.69,.3);armPose=-.4}
 if(kind==='revenant'){g.scale.set(.85,1.15,.9);arms.forEach(a=>a.scale.y=1.25);for(const side of [-1,1])spike(side*.19,2.34,-.07,.06,.55,-side*.3);armPose=-1.4}
 if(kind==='hexer'){g.scale.set(1.04,1.12,1.04);for(let i=0;i<3;i++)spike((i-1)*.28,2.35,0,.09,.55,(-1+i)*.45)}
 if(kind==='broodmother'){g.scale.set(1.65,.78,1.6);part('flesh','#8f4545',0,1.22,-.6,.68,.7,.78);for(const side of [-1,1])part('flesh','#bc8170',side*.4,1.65,-.72,.25,.28,.26);armPose=-1.25}
 const gunMount=new T.Group();gunMount.visible=false;body.add(gunMount);
 return {g,body,legs,arms,appendages,gunMount,weapon:null,monster:true,kind,crawler,floating,armPose};
}
