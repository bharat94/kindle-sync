const test = require('node:test');
const assert = require('node:assert/strict');
const { allowTestRuntime } = require('../src/main/runtime-policy');
const { resolveGoogleClientId } = require('../src/main/google-auth-service');

test('packaged builds cannot enable test-only runtime hooks', () => {
  assert.equal(allowTestRuntime({ isPackaged: true, testMode: '1' }), false);
  assert.equal(allowTestRuntime({ isPackaged: false, testMode: '1' }), true);
  assert.equal(allowTestRuntime({ isPackaged: false, testMode: '0' }), false);
});

test('packaged OAuth client resolution ignores environment substitution', () => {
  const previous = process.env.KINDLESYNC_GOOGLE_CLIENT_ID;
  process.env.KINDLESYNC_GOOGLE_CLIENT_ID = 'attacker.apps.googleusercontent.com';
  try {
    const packageConfig = { kindleSync: { googleOAuthClientId: 'release.apps.googleusercontent.com' } };
    assert.equal(resolveGoogleClientId(packageConfig, { allowEnvironment: false }), 'release.apps.googleusercontent.com');
    assert.equal(resolveGoogleClientId(packageConfig, { allowEnvironment: true }), 'attacker.apps.googleusercontent.com');
  } finally {
    if (previous === undefined) delete process.env.KINDLESYNC_GOOGLE_CLIENT_ID;
    else process.env.KINDLESYNC_GOOGLE_CLIENT_ID = previous;
  }
});
