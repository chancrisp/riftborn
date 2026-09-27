import assert from 'node:assert/strict';
import {context,document,evaluate} from './harness.mjs';

const game=context.test;
const node=id=>document.querySelector(id);
node('#playerIndicatorsOpacity').value='35';
node('#playerIndicatorsOpacity').oninput({target:node('#playerIndicatorsOpacity')});
assert.equal(game.prefs.playerIndicatorsOpacity,35);
assert.equal(node('#playerIndicatorsOpacityValue').textContent,'35%');
assert.equal(node('#playerVitals').style.opacity,.35);
assert.equal(node('#dashPips').style.opacity,.35);
game.start();
assert.equal(game.state.player.dashCharges,2);
game.dash();
assert.equal(game.state.player.dashCharges,1);
assert.ok(game.state.player.dashCD>0);
game.update(.23);
game.dash();
assert.equal(game.state.player.dashCharges,0,'Second dash is available before recharge');
game.update(.23);
game.dash();
assert.equal(game.state.player.dashCharges,0,'Third dash waits for recharge');
game.update(1.35);
assert.equal(game.state.player.dashCharges,1,'First spent charge refills on the original cooldown');
game.update(1.8);
assert.equal(game.state.player.dashCharges,2,'Second charge refills independently');
assert.equal(game.state.player.dashCD,0);

game.updateHUD?.();
assert.equal(node('#dashFill1').style.height,'100%');
assert.equal(node('#dashFill2').style.height,'100%');
game.dash();game.update(.4);
assert.ok(parseFloat(node('#dashFill2').style.height)>0,'Spent icon visibly refills');
assert.ok(parseFloat(node('#dashFill2').style.height)<100);
const pausedCooldown=game.state.player.dashCD;
game.pause();game.update(2);
assert.equal(game.state.player.dashCD,pausedCooldown,'Recharge stops while paused');
game.pause();

for(const [hp,color] of [[100,'#7bdc8f'],[60,'#e6cf67'],[35,'#ec9a54'],[10,'#d85d57']]){
 game.state.player.hp=hp;
 evaluate('updateHUD()');
 assert.equal(node('#playerHealthNumber').textContent,String(hp));
 assert.equal(node('#playerHealthFill').style.backgroundColor,color);
}
evaluate('cameraUpdate(.016,elapsed)');
assert.match(node('#playerVitals').style.left,/px$/);
assert.match(node('#dashPips').style.top,/px$/);
game.start();
assert.equal(game.state.player.dashCharges,2,'A new run restores both dashes');
console.log('PASS two dash charges, sequential refill, player icons and overhead health colors.');
