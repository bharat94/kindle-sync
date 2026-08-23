const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '../..');

async function launch(testInfo, extraEnv = {}) {
  const userData = testInfo.outputPath('user-data');
  await fs.mkdir(userData, { recursive: true });
  const application = await electron.launch({
    args: [appRoot],
    env: {
      ...process.env,
      KINDLESYNC_TEST_MODE: '1',
      KINDLESYNC_USER_DATA_DIR: userData,
      ...extraEnv
    }
  });
  const window = await application.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { application, window, userData };
}

test('boots securely and queues a book through the real preload bridge', async ({}, testInfo) => {
  const { application, window } = await launch(testInfo);
  try {
    await expect(window).toHaveTitle('KindleSync');
    await expect(window.getByRole('heading', { name: 'Drop books to send' })).toBeVisible();
    const boundary = await window.evaluate(() => ({
      requireType: typeof window.require,
      processType: typeof window.process,
      apiKeys: Object.keys(window.kindleSync).sort()
    }));
    expect(boundary.requireType).toBe('undefined');
    expect(boundary.processType).toBe('undefined');
    expect(boundary.apiKeys).not.toContain('getPathForFile');
    expect(boundary.apiKeys).not.toContain('ipcRenderer');
    const sessionStoragePath = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.storagePath);
    expect(sessionStoragePath).toBeNull();

    const fixture = path.join(appRoot, 'test/fixtures/sample.epub');
    await application.evaluate(({ dialog }, filePaths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
    }, [fixture]);
    await window.getByRole('button', { name: 'Choose Books…' }).click();
    await expect(window.locator('.file-row')).toHaveCount(1);
    await expect(window.locator('.file-name')).toHaveText('sample.epub');
    await expect(window.locator('.file-state')).toHaveText('Ready');
    await expect(window.getByRole('button', { name: 'Finish Wireless Setup' })).toBeEnabled();
  } finally {
    await application.close();
  }
});

test('hostile filenames render as text and cannot create injected elements', async ({}, testInfo) => {
  const hostileDir = testInfo.outputPath('files');
  await fs.mkdir(hostileDir, { recursive: true });
  const hostile = path.join(hostileDir, '<img onerror=alert(1)>.epub');
  await fs.writeFile(hostile, 'ebook');
  const { application, window } = await launch(testInfo);
  try {
    await application.evaluate(({ dialog }, filePaths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
    }, [hostile]);
    await window.getByRole('button', { name: 'Choose Books…' }).click();
    await expect(window.locator('.file-name')).toHaveText('<img onerror=alert(1)>.epub');
    await expect(window.locator('.file-row img')).toHaveCount(0);
    expect(await window.evaluate(() => window.__hostileExecuted)).toBeUndefined();
  } finally {
    await application.close();
  }
});

test('wireless setup stores only an encrypted envelope and redacted renderer state', async ({}, testInfo) => {
  const { application, window, userData } = await launch(testInfo);
  try {
    await window.locator('#settingsButton').click();
    await expect(window.getByRole('dialog')).toBeVisible();
    await window.locator('#kindleEmail').fill('reader@kindle.com');
    await window.locator('#smtpProvider').selectOption('custom');
    await window.locator('#senderEmail').fill('me@example.com');
    await window.locator('#approvedSender').check();
    await window.locator('#smtpHost').fill('smtp.example.com');
    await window.locator('#smtpUser').fill('me@example.com');
    await window.locator('#smtpPass').fill('super-secret-app-password');
    await window.locator('#saveSettingsButton').click();
    await expect(window.getByText('Wireless ready')).toBeVisible();
    const config = await window.evaluate(() => window.kindleSync.getState().then(value => value.config));
    expect(config.hasSmtpPassword).toBe(true);
    expect(config.smtpPass).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('super-secret-app-password');
    const raw = await fs.readFile(path.join(userData, 'kindle-sync-config.json'), 'utf8');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['protectedDataCiphertext', 'schemaVersion']);
    expect(raw).not.toContain('reader@kindle.com');
    expect(raw).not.toContain('me@example.com');
    expect(raw).not.toContain('smtp.example.com');
    expect(raw).not.toContain('super-secret-app-password');
  } finally {
    await application.close();
  }
});

test('erase all data clears settings, queue, history, and the encrypted envelope', async ({}, testInfo) => {
  const { application, window, userData } = await launch(testInfo);
  try {
    const fixture = path.join(appRoot, 'test/fixtures/sample.epub');
    await application.evaluate(({ dialog }, filePaths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, [fixture]);
    await window.getByRole('button', { name: 'Choose Books…' }).click();
    await window.locator('#settingsButton').click();
    await window.locator('#kindleEmail').fill('reader@kindle.com');
    await window.locator('#smtpProvider').selectOption('custom');
    await window.locator('#senderEmail').fill('me@example.com');
    await window.locator('#smtpHost').fill('smtp.example.com');
    await window.locator('#smtpUser').fill('me@example.com');
    await window.locator('#smtpPass').fill('secret');
    await window.locator('#saveSettingsButton').click();
    await window.locator('#settingsButton').click();
    await window.locator('#eraseDataButton').click();
    await expect(window.getByText('All KindleSync data was erased from this Mac.')).toBeVisible();
    await expect(window.locator('.file-row')).toHaveCount(0);
    const config = await window.evaluate(() => window.kindleSync.getState().then(value => value.config));
    expect(config.kindleEmail).toBe('');
    await expect(fs.access(path.join(userData, 'kindle-sync-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await application.close();
  }
});

test('settings fit the initial window and Gmail connects without SMTP fields', async ({}, testInfo) => {
  const { application, window } = await launch(testInfo, { KINDLESYNC_TEST_GOOGLE_SIGN_IN: '1' });
  try {
    await window.locator('#settingsButton').click();
    const windowSizing = await application.evaluate(({ BrowserWindow, screen }) => {
      const appWindow = BrowserWindow.getAllWindows()[0];
      const display = screen.getDisplayMatching(appWindow.getBounds());
      return { actualHeight: appWindow.getBounds().height, availableHeight: display.workAreaSize.height };
    });
    expect(windowSizing.actualHeight).toBeLessThanOrEqual(940);
    if (windowSizing.availableHeight >= 988) expect(windowSizing.actualHeight).toBe(940);
    const layout = await window.evaluate(() => {
      const dialog = document.querySelector('#settingsDialog').getBoundingClientRect();
      const footer = document.querySelector('#settingsDialog .dialog-footer').getBoundingClientRect();
      const body = document.querySelector('#settingsDialog .dialog-body');
      return { viewport: innerHeight, dialogTop: dialog.top, dialogBottom: dialog.bottom, footerBottom: footer.bottom, bodyClientHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight };
    });
    expect(layout.dialogTop).toBeGreaterThanOrEqual(0);
    expect(layout.dialogBottom).toBeLessThanOrEqual(layout.viewport);
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.viewport);
    if (layout.viewport >= 850) expect(layout.bodyScrollHeight).toBeLessThanOrEqual(layout.bodyClientHeight);
    else expect(layout.bodyScrollHeight).toBeGreaterThanOrEqual(layout.bodyClientHeight);

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 700));
    const constrainedLayout = await window.evaluate(() => {
      const dialog = document.querySelector('#settingsDialog').getBoundingClientRect();
      const footer = document.querySelector('#settingsDialog .dialog-footer').getBoundingClientRect();
      const body = document.querySelector('#settingsDialog .dialog-body');
      return { viewport: innerHeight, dialogTop: dialog.top, dialogBottom: dialog.bottom, footerBottom: footer.bottom, bodyClientHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight };
    });
    expect(constrainedLayout.dialogTop).toBeGreaterThanOrEqual(0);
    expect(constrainedLayout.dialogBottom).toBeLessThanOrEqual(constrainedLayout.viewport);
    expect(constrainedLayout.footerBottom).toBeLessThanOrEqual(constrainedLayout.viewport);
    expect(constrainedLayout.bodyScrollHeight).toBeGreaterThanOrEqual(constrainedLayout.bodyClientHeight);
    await expect(window.locator('#smtpFields')).toBeHidden();
    await window.locator('#googleSignInButton').click();
    await expect(window.getByText('reader.sender@gmail.com', { exact: true }).first()).toBeVisible();
    await expect(window.locator('#senderEmail')).toHaveValue('reader.sender@gmail.com');
    const config = await window.evaluate(() => window.kindleSync.getState().then(value => value.config));
    expect(config.hasGoogleAccount).toBe(true);
    expect(config.googleRefreshTokenCiphertext).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('test-refresh-token');
  } finally {
    await application.close();
  }
});

test('a connected modern Kindle is shown as unsupported MTP, never as ready', async ({}, testInfo) => {
  const { application, window } = await launch(testInfo, { KINDLESYNC_TEST_DEVICE_STATE: 'mtp_detected_unsupported' });
  try {
    await window.getByRole('button', { name: 'USB' }).click();
    await expect(window.getByRole('heading', { name: 'Modern Kindle detected' })).toBeVisible();
    await expect(window.getByText('MTP handoff needed')).toBeVisible();
    await expect(window.getByRole('button', { name: 'Amazon USB help' })).toBeVisible();
  } finally {
    await application.close();
  }
});
