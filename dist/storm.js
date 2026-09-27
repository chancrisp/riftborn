import * as T from 'three';

// Bounded weather geometry renders through the same low-resolution PS1 pipeline.
export function createStorm({mobile=false,reduced=false}={}){
 const group=new T.Group(),count=mobile?280:560,positions=new Float32Array(count*6),drops=new Float32Array(count*3);
 let seed=93127;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
 for(let i=0;i<count;i++){drops[i*3]=(random()-.5)*64;drops[i*3+1]=random()*34;drops[i*3+2]=(random()-.5)*64}
 const geometry=new T.BufferGeometry(),attribute=new T.BufferAttribute(positions,3);attribute.setUsage(T.DynamicDrawUsage);geometry.setAttribute('position',attribute);
 const material=new T.LineBasicMaterial({color:'#a5b6c3',transparent:true,opacity:.32,depthWrite:false});
 const rain=new T.LineSegments(geometry,material);rain.frustumCulled=false;group.add(rain);
 const light=new T.DirectionalLight('#bcc8d6',0);light.position.set(-20,35,-15);light.target=group;group.add(light);
 const boltGeometry=new T.BufferGeometry();boltGeometry.setAttribute('position',new T.BufferAttribute(new Float32Array(24),3));
 const boltMaterial=new T.LineBasicMaterial({color:'#c0cbd5',transparent:true,opacity:0,fog:false});
 const bolt=new T.Line(boltGeometry,boltMaterial);bolt.frustumCulled=false;group.add(bolt);
 let enabled=false,age=0,nextStrike=3.5,flashAge=2,thunderDelay=-1;
 group.visible=false;
 return {group,rain,light,bolt,count,
  setEnabled(value){enabled=value;group.visible=value;light.intensity=0;boltMaterial.opacity=0;flashAge=2;thunderDelay=-1;nextStrike=age+3.5},
  update(dt,time,player,ground){
   if(!enabled)return false;
   age+=dt;group.position.set(player.x,ground-4,player.z);
   const wind=7+Math.sin(time*.65)*3;
   for(let i=0;i<count;i++){
    const j=i*3,k=i*6;drops[j]+=wind*dt;drops[j+1]-=(reduced?19:31)*dt;drops[j+2]+=dt*2;
    if(drops[j]>32)drops[j]-=64;if(drops[j+2]>32)drops[j+2]-=64;if(drops[j+1]<0)drops[j+1]+=34;
    positions[k]=drops[j];positions[k+1]=drops[j+1];positions[k+2]=drops[j+2];
    positions[k+3]=drops[j]-.45;positions[k+4]=drops[j+1]+(reduced?.8:1.2);positions[k+5]=drops[j+2]-.1;
   }
   attribute.needsUpdate=true;
   if(age>=nextStrike){
    nextStrike=age+7+random()*7;flashAge=0;thunderDelay=.5+random()*.7;
    const a=random()*Math.PI*2,x=Math.cos(a)*38,z=Math.sin(a)*38,vertices=boltGeometry.attributes.position;
    for(let i=0;i<8;i++)vertices.setXYZ(i,x+(random()-.5)*3,35-i*4,z+(random()-.5)*2);
    vertices.needsUpdate=true;
   }
   flashAge+=dt;
   // One soft flash per strike; reduced motion suppresses lightning entirely.
   const flash=!reduced&&flashAge<.9?Math.sin(flashAge/.9*Math.PI)**2:0;
   light.intensity=flash*.95;boltMaterial.opacity=flash*.65;
   if(thunderDelay>=0){thunderDelay-=dt;if(thunderDelay<0)return true}
   return false;
  },
  dispose(){geometry.dispose();material.dispose();boltGeometry.dispose();boltMaterial.dispose();group.removeFromParent()}
 };
}
