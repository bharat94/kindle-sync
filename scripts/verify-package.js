const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const packageConfig = require('../package.json');
const appPath = path.join(root, 'dist', 'mac-universal', 'KindleSync.app');
const executable = path.join(appPath, 'Contents', 'MacOS', 'KindleSync');
const archive = path.join(appPath, 'Contents', 'Resources', 'app.asar');
const artifactStem = `KindleSync-${packageConfig.version}-universal`;
const dmgPath = path.join(root, 'dist', `${artifactStem}.dmg`);
const zipPath = path.join(root, 'dist', `${artifactStem}.zip`);

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForDebugger(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited before its renderer was ready (exit ${child.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the packaged renderer.');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function verifyStaticPackage() {
  for (const required of [appPath, executable, archive, dmgPath, zipPath]) await fs.access(required);

  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  run('lipo', [executable, '-verify_arch', 'x86_64', 'arm64']);
  run('hdiutil', ['verify', dmgPath]);
  run('unzip', ['-tq', zipPath]);

  const fuseCli = path.join(root, 'node_modules', '.bin', 'electron-fuses');
  const fuseOutput = run(fuseCli, ['read', '--app', appPath], { capture: true });
  const expectedFuses = [
    'RunAsNode is Disabled',
    'EnableCookieEncryption is Enabled',
    'EnableNodeOptionsEnvironmentVariable is Disabled',
    'EnableNodeCliInspectArguments is Disabled',
    'EnableEmbeddedAsarIntegrityValidation is Enabled',
    'OnlyLoadAppFromAsar is Enabled',
    'LoadBrowserProcessSpecificV8Snapshot is Disabled',
    'GrantFileProtocolExtraPrivileges is Disabled',
    'WasmTrapHandlers is Enabled'
  ];
  for (const expected of expectedFuses) assert.match(fuseOutput, new RegExp(expected), `Unexpected Electron fuse state: ${expected}`);

  const entries = await asar.listPackage(archive);
  const forbidden = entries.filter(entry => /(^|\/)(test|tests|scripts|docs)(\/|$)|(^|\/)\.?env($|\.)|kindle-sync-config\.json|^\/(README|PLAN|SECURITY)\.md$/i.test(entry));
  assert.deepEqual(forbidden, [], `Development/private files entered app.asar: ${forbidden.join(', ')}`);
  for (const required of ['/main.js', '/preload.js', '/renderer/index.html', '/src/main/app.js']) assert(entries.includes(required), `Missing packaged file: ${required}`);
  const productionPackages = new Set(entries.filter(entry => entry.startsWith('/node_modules/')).map(entry => entry.split('/')[2]).filter(Boolean));
  assert.deepEqual([...productionPackages].sort(), ['nodemailer']);

  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-dmg-'));
  try {
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath]);
    const mountedApp = path.join(mountPoint, 'KindleSync.app');
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', mountedApp]);
    run('lipo', [path.join(mountedApp, 'Contents', 'MacOS', 'KindleSync'), '-verify_arch', 'x86_64', 'arm64']);
  } finally {
    try { run('hdiutil', ['detach', mountPoint]); } catch {}
    await fs.rm(mountPoint, { recursive: true, force: true });
  }

  const checksums = run('shasum', ['-a', '256', dmgPath, zipPath], { capture: true })
    .replaceAll(`${path.dirname(dmgPath)}/`, '');
  await fs.writeFile(path.join(root, 'dist', 'SHA256SUMS'), checksums, { mode: 0o644 });
  process.stdout.write(`\nVerified package structure, signatures, universal architectures, disk image, ZIP, ASAR allowlist, and fuses.\n${checksums}`);
}

async function smokePackagedApp() {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-packaged-smoke-'));
  const userData = path.join(runtimeRoot, 'actual-user-data');
  const ignoredUserData = path.join(runtimeRoot, 'ignored-test-hook');
  const port = await getFreePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${port}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      KINDLESYNC_TEST_MODE: '1',
      KINDLESYNC_TEST_GOOGLE_SIGN_IN: '1',
      KINDLESYNC_TEST_DEVICE_STATE: 'mtp_detected_unsupported',
      KINDLESYNC_USER_DATA_DIR: ignoredUserData,
      KINDLESYNC_GOOGLE_CLIENT_ID: 'attacker.apps.googleusercontent.com'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-8_000); });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });

  let browser;
  try {
    await waitForDebugger(port, child);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('kindlesync://'));
    assert(page, 'The packaged app did not open its local renderer.');
    await page.locator('#settingsButton').waitFor();

    const state = await page.evaluate(() => window.kindleSync.getState());
    assert.equal(page.url(), 'kindlesync://app/index.html');
    assert.equal(await page.title(), 'KindleSync');
    assert.equal(state.config.googleOAuthAvailable, Boolean(packageConfig.kindleSync.googleOAuthClientId));
    assert.equal(state.config.hasGoogleAccount, false);
    assert.deepEqual(await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process })), { require: 'undefined', process: 'undefined' });

    if (process.env.CI) {
      const saved = await page.evaluate(() => window.kindleSync.saveConfig({
        deliveryMode: 'email',
        kindleEmail: 'ci_reader@kindle.com',
        senderEmail: 'ci_sender@example.com',
        approvedSenderConfirmed: true,
        smtpProvider: 'custom',
        smtpHost: 'smtp.ci.example',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: 'ci_sender@example.com',
        smtpPass: 'ci-only-fake-password',
        smtpMaxMb: 24
      }));
      assert.equal(saved.hasSmtpPassword, true);
      assert.equal(saved.smtpPass, undefined);

      const configPath = path.join(userData, 'kindle-sync-config.json');
      const raw = await fs.readFile(configPath, 'utf8');
      assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['protectedDataCiphertext', 'schemaVersion']);
      for (const privateValue of ['ci_reader', 'ci_sender', 'smtp.ci.example', 'ci-only-fake-password']) assert(!raw.includes(privateValue), `${privateValue} leaked into packaged config`);
      const decodedCiphertext = Buffer.from(JSON.parse(raw).protectedDataCiphertext, 'base64').toString('utf8');
      assert(!decodedCiphertext.startsWith('test:'), 'Packaged app enabled reversible test crypto.');
      await assert.rejects(fs.access(path.join(ignoredUserData, 'kindle-sync-config.json')), { code: 'ENOENT' });
    } else {
      process.stdout.write('\nSkipped packaged persistence write locally to avoid a macOS Keychain access prompt; CI covers it in a disposable account.\n');
    }

    const persistenceCoverage = process.env.CI ? 'ciphertext-only persistence' : 'production persistence policy';
    process.stdout.write(`\nPackaged renderer smoke passed: local protocol, sandbox boundary, production runtime policy, and ${persistenceCoverage}.\n`);
  } catch (error) {
    error.message += `\nPackaged stdout:\n${stdout}\nPackaged stderr:\n${stderr}`;
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopChild(child);
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
}

(async () => {
  if (process.platform !== 'darwin') throw new Error('Package verification must run on macOS.');
  await verifyStaticPackage();
  await smokePackagedApp();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
