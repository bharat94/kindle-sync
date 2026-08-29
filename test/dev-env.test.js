const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadDevEnv, parseEnv } = require('../src/main/dev-env');

async function withEnvFile(contents, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-devenv-'));
  try {
    await fs.writeFile(path.join(root, '.env'), contents);
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('packaged builds never read a local .env file', async () => {
  await withEnvFile('KINDLESYNC_GOOGLE_CLIENT_ID=attacker.apps.googleusercontent.com\n', root => {
    const env = {};
    const applied = loadDevEnv({ isPackaged: true, root, env });
    assert.deepEqual(applied, []);
    assert.deepEqual(env, {});
  });
});

test('development builds load the app namespace and leave the shell in control', async () => {
  await withEnvFile([
    '# a comment',
    '',
    'export KINDLESYNC_GOOGLE_CLIENT_ID="dev-id.apps.googleusercontent.com"',
    "KINDLESYNC_TEST_MODE='1'",
    'KINDLESYNC_ALREADY_SET=from-file'
  ].join('\n'), root => {
    const env = { KINDLESYNC_ALREADY_SET: 'from-shell' };
    const applied = loadDevEnv({ isPackaged: false, root, env });
    assert.equal(env.KINDLESYNC_GOOGLE_CLIENT_ID, 'dev-id.apps.googleusercontent.com');
    assert.equal(env.KINDLESYNC_TEST_MODE, '1');
    assert.equal(env.KINDLESYNC_ALREADY_SET, 'from-shell', 'an exported shell value must win over the file');
    assert.ok(!applied.includes('KINDLESYNC_ALREADY_SET'));
  });
});

test('keys outside the app namespace cannot be injected', async () => {
  await withEnvFile('NODE_OPTIONS=--inspect\nPATH=/tmp/evil\nELECTRON_RUN_AS_NODE=1\n', root => {
    const env = {};
    const applied = loadDevEnv({ isPackaged: false, root, env });
    assert.deepEqual(applied, []);
    assert.deepEqual(env, {});
  });
});

test('a missing or malformed .env is not a startup failure', async () => {
  const missing = loadDevEnv({ isPackaged: false, root: path.join(os.tmpdir(), 'kindlesync-absent-dir'), env: {} });
  assert.deepEqual(missing, []);
  assert.deepEqual([...parseEnv('no-separator\n=novalue\n  \n#only comment').keys()], []);
});
