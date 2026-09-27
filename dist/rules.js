import {MUSIC_TEMPO} from './soundtrack.js?v=11';
export const WEAPONS = [
 {label:'RIFLE',kind:'ASSAULT',icon:'⌁',color:'#6be7a6',description:'Accurate all-round automatic rifle',damage:20,speed:38,range:32,count:1,spread:.015,cooldown:.22,pierce:0,sound:'rifle'},
 {label:'STINGER',kind:'SMG',icon:'ϟ',color:'#6ad6ff',description:'High fire rate, wide spread',damage:9,speed:34,range:23,count:1,spread:.085,cooldown:.075,pierce:0,sound:'smg'},
 {label:'SCATTER',kind:'SHOTGUN',icon:'⋔',color:'#b899ff',description:'Seven close-range pellets',damage:12,speed:32,range:12,count:7,spread:.065,cooldown:.8,pierce:0,sound:'shotgun'},
 {label:'LANCER',kind:'RAILGUN',icon:'➜',color:'#f497ff',description:'Long-range piercing heavy shot',damage:95,speed:90,range:48,count:1,spread:0,cooldown:1.05,pierce:4,sound:'rail'},
 {label:'HAVOC',kind:'ROCKET',icon:'◆',color:'#ffca65',description:'Explosive splash damage in a 3.5m radius',damage:72,speed:19,range:30,count:1,spread:0,cooldown:1.3,pierce:0,rocket:true,radius:3.5,sound:'rocket'}
];
export const ENEMY_TYPES = {
 runner:{hp:50,speed:2.7,radius:.5,damage:10,score:100,xp:1,color:'#cb86ea'},
 skitter:{hp:27,speed:4.4,radius:.38,damage:7,score:90,xp:1,color:'#a2e48b'},
 gunner:{hp:64,speed:2.1,radius:.5,damage:9,score:160,xp:2,color:'#ffd080'},
 charger:{hp:125,speed:2.2,radius:.65,damage:17,score:220,xp:3,color:'#ff998b'},
 brute:{hp:310,speed:1.25,radius:.88,damage:22,score:400,xp:5,color:'#b99beb'},
 mortar:{hp:95,speed:1.8,radius:.5,damage:10,score:240,xp:3,color:'#93bfff'}
 ,sniper:{hp:76,speed:1.25,radius:.52,damage:28,score:330,xp:4,color:'#ff6fa5'}
 ,leaper:{hp:145,speed:2.9,radius:.62,damage:24,score:300,xp:4,color:'#ffad5c'}
 ,splitter:{hp:190,speed:1.9,radius:.7,damage:15,score:360,xp:5,color:'#65e7d1'}
 ,stormer:{hp:210,speed:2.35,radius:.72,damage:12,score:440,xp:6,color:'#6d96ff'}
};
// Screen-relative input rotated into world space; analog magnitude is preserved.
export const DEATH_TYPES=Object.freeze({
 revenant:{hp:100,speed:3.7,radius:.48,damage:16,score:250,xp:3,color:'#cf484e'},
 hexer:{hp:150,speed:2.3,radius:.6,damage:18,score:330,xp:4,color:'#dc7392'},
 broodmother:{hp:340,speed:1.5,radius:1.1,damage:22,score:500,xp:6,color:'#b5574e'}
});
export const RUN_MODES=Object.freeze({normal:Object.freeze({speed:1,damage:1,bpm:MUSIC_TEMPO.normal}),death:Object.freeze({speed:1.35,damage:1.5,bpm:MUSIC_TEMPO.death})});
export function enemyPool(pool,death,stage){return death?[...pool,'revenant','hexer',...(stage>1?['broodmother']:[])]:pool}
export function movementVector(x,y,yaw){const length=Math.max(1,Math.hypot(x,y));x/=length;y/=length;return {x:Math.cos(yaw)*x+Math.sin(yaw)*y,z:-Math.sin(yaw)*x+Math.cos(yaw)*y}}
// Swept collision avoids fast rail rounds tunneling through enemies.
export function segmentHit(ax,az,bx,bz,x,z,r){const dx=bx-ax,dz=bz-az,l=dx*dx+dz*dz;const t=l?Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/l)):0;return Math.hypot(ax+t*dx-x,az+t*dz-z)<=r}
