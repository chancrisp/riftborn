// The Worker's username rules must be a byte-identical copy of the game's
// (riftborn/src/data/username-rules.js): the game pre-checks with them, the Worker decides.
// Compared when the game source sits next to this repo (../riftborn); skipped otherwise (CI).
// Line endings are normalised first, so a CRLF checkout on one side does not count as a change.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkUsername, usernameKey } from '../server/username-rules.js';

const serverCopy = new URL('../server/username-rules.js', import.meta.url);
const gameCopy = new URL('../../riftborn/src/data/username-rules.js', import.meta.url);
const text = url => fs.readFileSync(url, 'utf8').replace(/\r\n/g, '\n');

if (fs.existsSync(gameCopy)) {
  assert.equal(text(serverCopy), text(gameCopy),
    'server/username-rules.js differs from riftborn/src/data/username-rules.js: copy the game file over it unchanged');
  console.log('PASS username rules: identical to the game copy.');
} else {
  console.log('SKIP username rules comparison: ../riftborn not found.');
}

assert.deepEqual(checkUsername('  Rifter_01 '), { ok: true, name: 'Rifter_01' });
assert.equal(checkUsername('ab').reason, 'invalid');
assert.equal(checkUsername('no spaces').reason, 'invalid');
assert.equal(checkUsername('Admin').reason, 'reserved');
assert.equal(checkUsername('exile-00ff').reason, 'reserved', 'Anonymised names cannot be claimed');
assert.equal(checkUsername('Sh1t_Lord').detail, 'profanity');
assert.equal(checkUsername('Dickens').ok, true, 'No false positive on innocent names');
assert.equal(usernameKey(' Rifter '), usernameKey('rifter'));
console.log('PASS username rules: basic checks on the Worker copy.');
