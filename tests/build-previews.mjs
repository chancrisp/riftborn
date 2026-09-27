import assert from 'node:assert/strict';
import * as previews from '../dist/upgrades.js';
import {WEAPONS} from '../dist/rules.js';

assert.equal(typeof previews.modPreview,'function','Mod cards need formula-derived build previews');
assert.equal(typeof previews.dashPreview,'function','Dash cards need formula-derived build previews');
const {modPreview,dashPreview}=previews;
const base={rate:1,damage:1,extra:0,pierce:0,crit:.1,max:100,hp:100,magnet:3.8,speed:6.4,regen:0};
const upgraded={...base,damage:1.25,extra:2,rate:1.18,pierce:1,crit:.4};

// Hand-checked values catch forgetting ordinary damage, multiplying by the
// primary crit, and counting every pellet as a separate trigger/pull.
const split=modPreview(upgraded,0,WEAPONS[0]);
assert.match(split,/2 × 8\.75 base dmg/);assert.match(split,/3 primary rounds can each split/);
const storm=modPreview(upgraded,1,WEAPONS[1]);
assert.match(storm,/7 connected pulls/);assert.match(storm,/3 arcs × 7\.88 non-critical base dmg/);assert.match(storm,/7m\/hop/);assert.match(storm,/3 shots still give 1 charge\/pull/);
const grave=modPreview(upgraded,2,WEAPONS[2]);
assert.match(grave,/within 8m/);assert.match(grave,/5 × 9 base dmg/);assert.match(grave,/once\/pull/);assert.match(grave,/9 pellets still give one burst/);
const scar=modPreview(upgraded,3,WEAPONS[3]);
assert.match(scar,/21\.38 non-critical base dmg\/target every 0\.3s for 1\.4s/);assert.match(scar,/shared across scars/);assert.match(scar,/not tick rate/);
const havoc=modPreview(upgraded,4,WEAPONS[4]);
assert.match(havoc,/within 5m for 0\.45s/);assert.match(havoc,/90 base blast dmg/);assert.match(havoc,/3\.5m radius/);assert.match(havoc,/3 rockets each pull and blast/);

// Temporary cadence must use the same shot interval as combat. Forked Chamber
// changes shot count but does not change Storm Needle's charge denominator.
const rapid=modPreview({...base,rate:1.18},1,WEAPONS[1],{rapid:5});
assert.match(rapid,/0\.0424s/);
assert.match(modPreview({...base,pierce:2},0,WEAPONS[0]),/splinters pierce 2 extra targets/);
assert.match(modPreview({...base,crit:.4},4,WEAPONS[4]),/one critical roll per blast/);

// Echo repeats upgraded volley count/damage once; it never inherits the equipped
// mod. No displayed total promises every pellet will hit.
const echo=dashPreview(upgraded,'echo',WEAPONS[2],{}, {mods:[2],ordinary:{'Forked chamber':2}});
assert.match(echo,/SCATTER echo: 9 × 7\.5 base dmg/);assert.match(echo,/from dash origin/);assert.match(echo,/within 2s/);assert.match(echo,/once\/dash, no mod triggers/);assert.match(echo,/extra shots repeat/);
assert.match(dashPreview(base,'echo',WEAPONS[4],{}, {mods:[4]}),/36 base dmg/);
assert.match(dashPreview(base,'echo',WEAPONS[0],{}, {mods:[0]}),/Your mod stays on the primary volley/);
assert.doesNotMatch(dashPreview(base,'echo',WEAPONS[0],{}, {mods:[4]}),/Your mod stays on the primary volley/,'An unequipped weapon mod must not imply the current volley has that mod');
const wake=dashPreview(base,'wake',WEAPONS[3],{}, {mods:[3]});
assert.match(wake,/2s trail/);assert.match(wake,/60% speed \(40% slow\)/);assert.match(wake,/No stacking; bosses resist/);assert.match(wake,/your Rift Scars/);
assert.match(dashPreview(base,'wake',WEAPONS[4],{}, {mods:[4]}),/your delayed Havoc blast/);

// Frozen inputs protect the read-only card contract; these are short detail
// blocks, not accumulated descriptions of every possible combination.
const frozen=Object.freeze({...upgraded}),boons=Object.freeze({rapid:5}),build=Object.freeze({mods:Object.freeze([0,1,2,3,4]),ordinary:Object.freeze({})});
for(let index=0;index<5;index++){
 const detail=modPreview(frozen,index,WEAPONS[index],boons);
 assert.ok(detail.length<=230,'Mod detail must fit a compact card');assert.equal((detail.match(/Tip:/g)||[]).length,1);
 for(const trait of ['echo','wake']){const text=dashPreview(frozen,trait,WEAPONS[index],boons,build);assert.ok(text.length<=230,'Dash detail must fit a compact card');assert.equal((text.match(/Tip:/g)||[]).length,1)}
}
assert.equal(modPreview(base,-1,WEAPONS[0]),'');
assert.equal(dashPreview(base,'unknown',WEAPONS[0]),'');
console.log('PASS build previews: scaled mod/echo damage, trigger/tick limits, real boon cadence, conditional synergy, compact read-only details.');
