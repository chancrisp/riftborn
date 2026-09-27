import * as T from 'three';
import {retroMaterial} from './retro.js?v=16';
import {randomSource} from './terrain.js?v=16';

// BALANCE: drops expire quickly and refresh their timer instead of stacking strength.
// Durations are seconds; movement/fire multipliers are applied by game.js.
export const DROP_CHANCE=.18, DROP_LIFETIME=14, MAX_DROPS=4, STATUE_BONUS=5;
export const POWERUPS={
 speed:{label:'SPEED BOOST',duration:8,color:'#76bce3',shape:'gem'},
 rapid:{label:'RAPID FIRE',duration:8,color:'#e4c16c',shape:'gem'},
 execution:{label:'INSTA KILL',duration:5,color:'#d87e8c',shape:'ico'},
 ward:{label:'BONE WARD',duration:10,color:'#d3d7ba',shape:'box'},
 heal:{label:'MEND +20',duration:0,color:'#8fce95',shape:'ico'}
};
// DROP ROLL — first choose whether anything drops, then choose one of the five equally likely rewards.
export function rollPowerup(random=Math.random){if(random()>=DROP_CHANCE)return null;const keys=Object.keys(POWERUPS);return keys[Math.min(keys.length-1,Math.floor(random()*keys.length))]}

// A fresh object per run prevents temporary bonuses leaking into the next run.
export function createBoons(){return {speed:0,rapid:0,execution:0,ward:0,shield:0}}
// COLLECTION — health applies immediately; temporary effects refresh their duration without multiplying strength.
export function collectBoon(boons,kind,player){
 if(kind==='heal'){player.hp=Math.min(player.max,player.hp+20);return}
 boons[kind]=POWERUPS[kind].duration;if(kind==='ward')boons.shield=30;
}
// SIMULATION CLOCK — only call while playing, so paused runs preserve remaining buff time.
export function tickBoons(boons,dt){for(const kind of ['speed','rapid','execution','ward'])boons[kind]=Math.max(0,boons[kind]-dt);if(!boons.ward)boons.shield=0}
// SHIELD — return the damage still owed to health after consuming available absorption.
export function absorbDamage(boons,damage){const blocked=Math.min(boons.shield,damage);boons.shield-=blocked;if(!boons.shield)boons.ward=0;return damage-blocked}

// Statues use the existing skull sprite above a solid stone plinth: PS1 billboard scenery.
const skullTexture=typeof document!=='undefined'&&document.createElementNS?new T.TextureLoader().load('./assets/death-skull.png'):null;
if(skullTexture){skullTexture.magFilter=skullTexture.minFilter=T.NearestFilter;skullTexture.generateMipmaps=false;skullTexture.colorSpace=T.SRGBColorSpace}
export function createStatues(terrain,world,seed){
 const random=randomSource(seed+29831),group=new T.Group(),statues=[],box=new T.BoxGeometry(1,1,1),plane=new T.PlaneGeometry(2.4,2.4),stone=retroMaterial('#969991',5),materials=[stone];
 const choices=terrain.reachable.map(terrain.position).filter(p=>Math.hypot(p.x,p.z)>13&&Math.hypot(p.x,p.z)<49&&terrain.routeAt(p.x,p.z).distance>7&&terrain.clear(p.x,p.z,3.4));
 // Pick up to four separated sites. All interactions stand on the shared navigation surface.
 for(let n=0;n<80&&statues.length<4&&choices.length;n++){
  const p=choices[Math.floor(random()*choices.length)];if(statues.some(s=>Math.hypot(s.x-p.x,s.z-p.z)<13)||!terrain.clear(p.x,p.z,3.4))continue;
  const y=terrain.height(p.x,p.z),base=new T.Mesh(box,stone),pillar=new T.Mesh(box,stone);
  base.position.set(p.x,y+.2,p.z);base.scale.set(2,.4,2);pillar.position.set(p.x,y+1.1,p.z);pillar.scale.set(1.1,1.8,1.1);group.add(base,pillar);
  const mat=new T.MeshBasicMaterial({map:skullTexture,color:skullTexture?'#ffffff':'#b53738',transparent:true,alphaTest:.15,side:T.DoubleSide});materials.push(mat);
  const skull=new T.Mesh(plane,mat);skull.position.set(p.x,y+2.75,p.z);group.add(skull);
  statues.push({x:p.x,z:p.z,y,skull,used:false});terrain.obstacles.push({x:p.x,z:p.z,r:1.05});
  world.covers.push({shape:'box',x:p.x,y:y+1,z:p.z,sx:1.3,sy:2,sz:1.3,rotation:0});
 }
 terrain.rebuildNavigation();
 return {group,statues,
  nearby(player){return statues.find(s=>!s.used&&Math.hypot(player.x-s.x,player.z-s.z)<3.1)||null},
  face(camera){for(const s of statues)s.skull.rotation.y=Math.atan2(camera.position.x-s.x,camera.position.z-s.z)},
  activate(statue){if(!statue||statue.used)return false;statue.used=true;statue.skull.material.color.set('#51474a');return true},
  dispose(){group.removeFromParent();box.dispose();plane.dispose();materials.forEach(m=>m.dispose())}
 };
}
