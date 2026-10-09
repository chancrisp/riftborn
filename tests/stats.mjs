// Player metrics on the leaderboard Worker (server/stats-api.js, server/stats-counters.js, server/admin-auth.js):
// anonymous run reports into one-dimensional daily counters with a daily write ceiling, the sign-ups counter,
// and the admin read behind the inbox's admin key. Local only: an in-memory SQLite database stands in for D1.
// The last line of this file is the PASS line; later tasks add their blocks above it.
import assert from 'node:assert/strict';
import * as auth from '../server/admin-auth.js';
import * as feedback from '../server/feedback-api.js';

// ---- Task 1.1: the inbox admin helpers moved into server/admin-auth.js without a change in behaviour -------------
for (const name of ['corsHeaders', 'json', 'originAllowed', 'adminOnlyOrigin', 'sameSecret', 'limitAdmin', 'authorize']) {
  assert.equal(typeof auth[name], 'function', `admin-auth.js exports ${name}`);
}
assert.deepEqual(auth.ADMIN_LIMIT, { scope: 'feedback-admin', retryAfter: 60 });
assert.equal(feedback.ADMIN_LIMIT, auth.ADMIN_LIMIT, 'feedback-api.js exports the identical object');
assert.equal(auth.CORS_METHODS, 'GET, POST, PATCH, OPTIONS');
assert.equal(auth.CORS_ALLOW_HEADERS, 'Content-Type, Authorization');
assert.equal(await auth.sameSecret('abc', 'abc'), true);
assert.equal(await auth.sameSecret('abc', 'abd'), false);
assert.equal(auth.adminOnlyOrigin('https://feedback.riftborn.us', { FEEDBACK_ADMIN_ORIGINS: 'https://feedback.riftborn.us' }), true);
assert.equal(auth.adminOnlyOrigin(null, { FEEDBACK_ADMIN_ORIGINS: 'https://feedback.riftborn.us' }), false);
assert.equal(auth.originAllowed(null, {}), true);

console.log('PASS stats: the inbox admin helpers live in server/admin-auth.js and feedback-api.js still exports ADMIN_LIMIT.');
