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
};
// Screen-relative input rotated into world space; analog magnitude is preserved.
export function movementVector(x,y,yaw){const length=Math.max(1,Math.hypot(x,y));x/=length;y/=length;return {x:Math.cos(yaw)*x+Math.sin(yaw)*y,z:-Math.sin(yaw)*x+Math.cos(yaw)*y}}
// Swept collision avoids fast rail rounds tunneling through enemies.
export function segmentHit(ax,az,bx,bz,x,z,r){const dx=bx-ax,dz=bz-az,l=dx*dx+dz*dz;const t=l?Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/l)):0;return Math.hypot(ax+t*dx-x,az+t*dz-z)<=r}
