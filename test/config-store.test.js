const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore, CURRENT_SCHEMA_VERSION } = require('../src/main/config-store');

const cryptoProvider = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => Buffer.from(`encrypted:${value}`),
  decryptStringAsync: async value => ({ result: value.toString().replace(/^encrypted:/, ''), shouldReEncrypt: false })
};

test('migrates plaintext credentials and never returns them publicly', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'kindle-sync-config.json');
  await fs.writeFile(filePath, JSON.stringify({ smtpPass: 'secret', senderEmail: 'me@example.com' }));
  const store = new ConfigStore({ filePath, cryptoProvider });
  await store.init();
  assert.equal(store.publicConfig().hasSmtpPassword, true);
  assert.equal(store.publicConfig().smtpPass, undefined);
  assert.equal(await store.getSecret(), 'secret');
  const raw = await fs.readFile(filePath, 'utf8');
  const envelope = JSON.parse(raw);
  assert.deepEqual(Object.keys(envelope).sort(), ['protectedDataCiphertext', 'schemaVersion']);
  assert.equal(envelope.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(raw.includes('"smtpPass"'), false);
  assert.equal(raw.includes('me@example.com'), false);
  assert.equal(raw.includes('secret'), false);
});

test('persists safe history and can clear credential and history', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new ConfigStore({ filePath: path.join(dir, 'config.json'), cryptoProvider });
  await store.init();
  await store.save({ smtpPass: 'app-password', kindleEmail: 'reader@kindle.com' });
  await store.save({ usbDocumentsPath: '/Volumes/Kindle/documents' });
  await store.addHistory({ id: 'receipt-1', files: [{ name: 'book.epub' }] });
  assert.equal(store.publicConfig().history.length, 1);
  assert.equal(store.publicConfig().usbDocumentsPath, undefined);
  assert.equal(store.internalConfig().usbDocumentsPath, '/Volumes/Kindle/documents');
  await store.clearHistory();
  await store.clearSecret();
  assert.equal(store.publicConfig().history.length, 0);
  assert.equal(store.publicConfig().hasSmtpPassword, false);
});

test('encrypts Google refresh tokens and exposes only connected account state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-google-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'config.json');
  const store = new ConfigStore({ filePath, cryptoProvider });
  await store.init();
  await store.setGoogleRefreshToken('refresh-token-secret');
  await store.save({ googleEmail: 'reader@gmail.com', senderEmail: 'reader@gmail.com', smtpProvider: 'gmail' });
  assert.equal(store.publicConfig().hasGoogleAccount, true);
  assert.equal(store.publicConfig().googleEmail, 'reader@gmail.com');
  assert.equal(store.publicConfig().googleRefreshTokenCiphertext, undefined);
  assert.equal(await store.getGoogleRefreshToken(), 'refresh-token-secret');
  assert.equal((await fs.readFile(filePath, 'utf8')).includes('refresh-token-secret'), false);
  await store.clearGoogleAccount();
  assert.equal(store.publicConfig().hasGoogleAccount, false);
  assert.equal(store.publicConfig().senderEmail, '');
});

test('v3 encrypts all personal metadata and decrypts it after restart', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-v3-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'config.json');
  const first = new ConfigStore({ filePath, cryptoProvider });
  await first.init();
  await first.save({
    kindleEmail: 'private_reader@kindle.com',
    senderEmail: 'private_sender@example.com',
    smtpProvider: 'custom',
    smtpHost: 'smtp.private.example',
    smtpPort: 587,
    smtpUser: 'private_sender@example.com',
    smtpPass: 'private-app-password',
    usbDocumentsPath: '/Volumes/Private Kindle/documents'
  });
  await first.addHistory({ id: 'receipt-private', files: [{ name: 'private-book-title.epub' }], createdAt: '2026-01-01T00:00:00Z' });
  const raw = await fs.readFile(filePath, 'utf8');
  for (const privateValue of ['private_reader', 'private_sender', 'private-app-password', 'Private Kindle', 'private-book-title', 'smtp.private.example']) {
    assert.equal(raw.includes(privateValue), false, `${privateValue} must not appear in the envelope`);
  }
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['protectedDataCiphertext', 'schemaVersion']);

  const restarted = new ConfigStore({ filePath, cryptoProvider });
  await restarted.init();
  assert.equal(restarted.publicConfig().kindleEmail, 'private_reader@kindle.com');
  assert.equal(restarted.publicConfig().history[0].files[0].name, 'private-book-title.epub');
  assert.equal(await restarted.getSecret(), 'private-app-password');
});

test('saved SMTP password is invalidated when its server identity changes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-binding-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new ConfigStore({ filePath: path.join(dir, 'config.json'), cryptoProvider });
  await store.init();
  await store.save({ smtpProvider: 'custom', smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'me', smtpPass: 'bound-secret' });
  assert.equal(store.publicConfig().hasSmtpPassword, true);
  await store.save({ smtpHost: 'attacker.example.com' });
  assert.equal(store.publicConfig().hasSmtpPassword, false);
  assert.equal(await store.getSecret(), '');
});

test('erase resets memory and removes the encrypted config envelope', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-reset-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'config.json');
  const store = new ConfigStore({ filePath, cryptoProvider });
  await store.save({ kindleEmail: 'reader@kindle.com' });
  await store.reset();
  assert.equal(store.publicConfig().kindleEmail, '');
  await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
});

test('a user-supplied Google client survives restart and its secret stays private', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-config-'));
  const filePath = path.join(dir, 'kindle-sync-config.json');
  try {
    const store = new ConfigStore({ filePath, cryptoProvider });
    await store.init();
    await store.save({
      googleClientId: '000-mine.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-user-secret',
      kindleEmail: 'reader@kindle.com'
    });

    const publicView = store.publicConfig();
    assert.equal(publicView.googleClientId, '000-mine.apps.googleusercontent.com');
    assert.equal(publicView.hasGoogleClientSecret, true);
    assert.equal(publicView.googleClientSecret, undefined, 'the secret must never reach the renderer');
    assert.equal(store.internalConfig().googleClientSecret, undefined);

    // Nothing readable on disk, and the values come back on the next launch.
    const raw = await fs.readFile(filePath, 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['protectedDataCiphertext', 'schemaVersion']);
    assert.ok(!raw.includes('GOCSPX-user-secret'));
    assert.ok(!raw.includes('mine.apps.googleusercontent.com'));

    const restarted = new ConfigStore({ filePath, cryptoProvider });
    await restarted.init();
    assert.deepEqual(restarted.googleClient(), {
      clientId: '000-mine.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-user-secret'
    });
    assert.equal(restarted.publicConfig().kindleEmail, 'reader@kindle.com');

    // A blank secret on a later save means "keep what is stored", matching smtpPass.
    await restarted.save({ googleClientId: '000-mine.apps.googleusercontent.com', googleClientSecret: '' });
    assert.equal(restarted.googleClient().clientSecret, 'GOCSPX-user-secret');

    await restarted.clearGoogleClient();
    assert.deepEqual(restarted.googleClient(), { clientId: '', clientSecret: '' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('disconnecting the Google account keeps the client registration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-config-'));
  try {
    const store = new ConfigStore({ filePath: path.join(dir, 'kindle-sync-config.json'), cryptoProvider });
    await store.init();
    await store.save({ googleClientId: 'own.apps.googleusercontent.com', googleClientSecret: 'GOCSPX-keep', googleEmail: 'reader@gmail.com' });
    store.setGoogleRefreshToken('refresh');
    await store.clearGoogleAccount();
    assert.equal(store.publicConfig().hasGoogleAccount, false);
    assert.deepEqual(store.googleClient(), { clientId: 'own.apps.googleusercontent.com', clientSecret: 'GOCSPX-keep' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
