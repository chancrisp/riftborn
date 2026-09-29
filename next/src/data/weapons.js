// BALANCE REFERENCE: damage is HP per projectile (Havoc: blast damage), speed and range
// are world units (m, m/s), cooldown is seconds between shots, spread is radians.
// Index = weapon slot = key 1..5 = the `sourceWeapon` recorded on every hit.
export const WEAPONS = Object.freeze([
  Object.freeze({ id: 0, label: "RIFLE", kind: "ASSAULT", icon: "⌁", color: "#6be7a6", description: "Accurate all-round automatic rifle", damage: 22, speed: 38, range: 32, count: 1, spread: 0.015, cooldown: 0.22, pierce: 0, sound: "rifle", sprite: "assets/weapon-0.png" }),
  Object.freeze({ id: 1, label: "STINGER", kind: "SMG", icon: "ϟ", color: "#6ad6ff", description: "High fire rate, wide spread", damage: 11, speed: 34, range: 23, count: 1, spread: 0.085, cooldown: 0.075, pierce: 0, sound: "smg", sprite: "assets/weapon-1.png" }),
  Object.freeze({ id: 2, label: "SCATTER", kind: "SHOTGUN", icon: "⋔", color: "#b899ff", description: "Seven close-range pellets", damage: 18, speed: 32, range: 12, count: 7, spread: 0.065, cooldown: 0.8, pierce: 0, sound: "shotgun", sprite: "assets/weapon-2.png" }),
  Object.freeze({ id: 3, label: "LANCER", kind: "RAILGUN", icon: "➜", color: "#f497ff", description: "Long-range piercing heavy shot", damage: 95, speed: 90, range: 48, count: 1, spread: 0, cooldown: 1.5, pierce: 4, sound: "rail", sprite: "assets/weapon-3.png" }),
  Object.freeze({ id: 4, label: "HAVOC", kind: "ROCKET", icon: "◆", color: "#ffca65", description: "Explosive splash damage in a 3.5m radius", damage: 72, speed: 19, range: 30, count: 1, spread: 0, cooldown: 1.3, pierce: 0, rocket: true, radius: 3.5, sound: "rocket", sprite: "assets/weapon-4.png" }),
]);

// Per-weapon feel: recoil (also the enemy hit-squash strength), muzzle PointLight
// intensity, muzzle particles, camera shake, hit particles.
export const WEAPON_FEEDBACK = Object.freeze([
  Object.freeze({ recoil: 0.62, flash: 5, particles: 3, shake: 0, hit: 3 }),
  Object.freeze({ recoil: 0.32, flash: 2.5, particles: 1, shake: 0, hit: 2 }),
  Object.freeze({ recoil: 1, flash: 7, particles: 8, shake: 0.045, hit: 5 }),
  Object.freeze({ recoil: 0.9, flash: 5, particles: 3, shake: 0.035, hit: 7 }),
  Object.freeze({ recoil: 1, flash: 6, particles: 6, shake: 0.06, hit: 4 }),
]);

export const MAX_SHOTS = 320; // live projectiles (player + enemy); new ones are dropped above this
