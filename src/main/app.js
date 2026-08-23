const {
  app, BrowserWindow, Menu, Notification, dialog, ipcMain, net,
  safeStorage, screen, session, shell
} = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ConfigStore } = require('./config-store');
const { FileRegistry } = require('./file-registry');
const { DeviceService } = require('./device-service');
const { CalibreService } = require('./calibre-service');
const { MailService } = require('./mail-service');
const { GmailService } = require('./gmail-service');
const { GoogleAuthService, resolveGoogleClientId } = require('./google-auth-service');
const { UsbService } = require('./usb-service');
const { validateEmailConfig, createEmailBatches } = require('./delivery-policy');
const { allowTestRuntime } = require('./runtime-policy');

const HELP_LINKS = Object.freeze({
  amazonSettings: 'https://www.amazon.com/hz/mycd/myx#/home/settings/payment',
  sendToKindle: 'https://www.amazon.com/sendtokindle',
  amazonUsbHelp: 'https://digprjsurvey.amazon.com/csad/help/node/TCUBEdEkbIhK07ysFu',
  googleAppPasswords: 'https://support.google.com/accounts/answer/185833',
  calibre: 'https://calibre-ebook.com/download_osx'
});

const FILTERS = [{ name: 'Books and documents', extensions: ['epub', 'pdf', 'doc', 'docx', 'txt', 'rtf', 'htm', 'html', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'zip', 'azw', 'azw3', 'mobi', 'kfx'] }];

let mainWindow;
let appSession;
let rendererReady = false;
let pendingOpenPaths = [];
let store;
let registry;
let deviceService;
let mailService;
let gmailService;
let googleAuthService;
let usbService;

const testCrypto = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => Buffer.from(`test:${value}`),
  decryptStringAsync: async value => ({ result: value.toString().replace(/^test:/, ''), shouldReEncrypt: false })
};

function isTestRuntime() {
  return allowTestRuntime({ isPackaged: app.isPackaged, testMode: process.env.KINDLESYNC_TEST_MODE });
}

async function probeDevice() {
  if (isTestRuntime() && process.env.KINDLESYNC_TEST_DEVICE_STATE) {
    return {
      state: process.env.KINDLESYNC_TEST_DEVICE_STATE,
      targets: [],
      mtpDetected: process.env.KINDLESYNC_TEST_DEVICE_STATE === 'mtp_detected_unsupported',
      calibre: { available: false, path: '' }
    };
  }
  return deviceService.probe();
}

async function probePublicDevice() {
  const probe = await probeDevice();
  const selectedPath = store.internalConfig().usbDocumentsPath;
  const selected = probe.targets.find(target => target.documentsPath === selectedPath && target.writable);
  return {
    state: selected ? 'legacy_ready' : probe.state,
    targets: probe.targets.map(target => ({ label: target.label, writable: target.writable })),
    selectedTargetLabel: selected?.label || '',
    mtpDetected: probe.mtpDetected,
    calibre: { available: Boolean(probe.calibre?.available) }
  };
}

function assertTrusted(event) {
  let url;
  try { url = new URL(event.senderFrame?.url || ''); } catch {}
  const mainFrame = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.mainFrame : null;
  if (!url || url.protocol !== 'kindlesync:' || url.host !== 'app' || event.senderFrame !== mainFrame || event.sender !== mainWindow.webContents) {
    throw Object.assign(new Error('Untrusted IPC sender'), { code: 'untrusted_sender' });
  }
}

function safeIds(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || ids.some(id => typeof id !== 'string' || id.length > 100)) {
    throw Object.assign(new Error('Invalid file selection'), { code: 'invalid_file_ids' });
  }
  return ids;
}

function command(name) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:command', name);
}

function installMenu() {
  const template = [
    { label: 'KindleSync', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => command('settings') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'Add Books…', accelerator: 'CommandOrControl+O', click: () => command('add') }, { label: 'Send Books', accelerator: 'CommandOrControl+Enter', click: () => command('send') }, { type: 'separator' }, { role: 'close' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Device', submenu: [{ label: 'Detect Kindle', accelerator: 'CommandOrControl+Shift+K', click: () => command('detect') }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools', visible: !app.isPackaged }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Amazon Send to Kindle', click: () => shell.openExternal(HELP_LINKS.sendToKindle) }, { label: 'USB transfer help', click: () => shell.openExternal(HELP_LINKS.amazonUsbHelp) }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function installProtocol() {
  const rendererRoot = path.resolve(__dirname, '..', '..', 'renderer');
  await appSession.protocol.handle('kindlesync', request => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const target = path.resolve(rendererRoot, relative);
    if (target !== rendererRoot && !target.startsWith(`${rendererRoot}${path.sep}`)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });
}

function createWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const availableHeight = display.workAreaSize.height;
  const initialHeight = Math.min(940, Math.max(700, availableHeight - 48));
  mainWindow = new BrowserWindow({
    width: 880, height: initialHeight, minWidth: 680, minHeight: 620,
    title: 'KindleSync', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: '#f3f0e8', show: false,
    webPreferences: {
      preload: path.resolve(__dirname, '..', '..', 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      session: appSession
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('did-finish-load', async () => {
    rendererReady = true;
    await flushOpenPaths();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; rendererReady = false; });
  mainWindow.loadURL('kindlesync://app/index.html');
}

function publicConfig() {
  return { ...store.publicConfig(), googleOAuthAvailable: googleAuthService.available || Boolean(isTestRuntime() && process.env.KINDLESYNC_TEST_GOOGLE_SIGN_IN) };
}

function safeConfigPatch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings');
  const text = key => typeof input[key] === 'string' ? input[key].trim().slice(0, 500) : '';
  const provider = ['gmail', 'icloud', 'outlook', 'custom'].includes(input.smtpProvider) ? input.smtpProvider : 'custom';
  return {
    deliveryMode: input.deliveryMode === 'usb' ? 'usb' : 'email',
    kindleEmail: text('kindleEmail').toLowerCase(), senderEmail: text('senderEmail').toLowerCase(),
    approvedSenderConfirmed: input.approvedSenderConfirmed === true,
    smtpProvider: provider, smtpHost: text('smtpHost'),
    smtpPort: Math.min(65535, Math.max(1, Number(input.smtpPort) || 587)),
    smtpSecure: input.smtpSecure === true, smtpUser: text('smtpUser'),
    smtpMaxMb: Math.min(50, Math.max(1, Number(input.smtpMaxMb) || 24)),
    smtpPass: typeof input.smtpPass === 'string' ? input.smtpPass.slice(0, 1000) : ''
  };
}

function registerIpc() {
  ipcMain.handle('app:get-state', async event => {
    assertTrusted(event);
    const config = publicConfig();
    return { config, history: config.history || [], appVersion: app.getVersion() };
  });
  ipcMain.handle('files:pick', async event => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters: FILTERS });
    return result.canceled ? { added: [], rejected: [] } : registry.addPaths(result.filePaths);
  });
  ipcMain.handle('files:register-drop', async (event, paths) => {
    assertTrusted(event);
    if (!Array.isArray(paths) || paths.length > 500 || paths.some(item => typeof item !== 'string')) throw new Error('Invalid dropped files');
    return registry.addPaths(paths);
  });
  ipcMain.handle('files:remove', (event, id) => { assertTrusted(event); return registry.remove(typeof id === 'string' ? id : ''); });
  ipcMain.handle('config:save', async (event, input) => { assertTrusted(event); await store.save(safeConfigPatch(input)); return publicConfig(); });
  ipcMain.handle('config:forget-secret', async event => { assertTrusted(event); await store.clearSecret(); return publicConfig(); });
  ipcMain.handle('google:sign-in', async event => {
    assertTrusted(event);
    const account = isTestRuntime() && process.env.KINDLESYNC_TEST_GOOGLE_SIGN_IN
      ? { email: 'reader.sender@gmail.com', refreshToken: 'test-refresh-token' }
      : await googleAuthService.signIn();
    await store.setGoogleRefreshToken(account.refreshToken);
    await store.save({ smtpProvider: 'gmail', googleEmail: account.email, senderEmail: account.email, smtpMaxMb: 24 });
    return publicConfig();
  });
  ipcMain.handle('google:disconnect', async event => {
    assertTrusted(event);
    const token = await store.getGoogleRefreshToken();
    const revoked = isTestRuntime() ? true : await googleAuthService.revoke(token);
    await store.clearGoogleAccount();
    return { ...publicConfig(), googleRevocationFailed: Boolean(token && !revoked) };
  });
  ipcMain.handle('smtp:test', async event => {
    assertTrusted(event);
    const config = store.internalConfig();
    const issues = validateEmailConfig(config);
    if (issues.length) return { ok: false, code: 'wireless_setup_incomplete', issues };
    if (config.smtpProvider === 'gmail') {
      try { await googleAuthService.refresh(await store.getGoogleRefreshToken()); return { ok: true }; }
      catch (error) { return { ok: false, code: error.code || 'google_connection_failed' }; }
    }
    return mailService.test(config, await store.getSecret());
  });
  ipcMain.handle('delivery:email', async (event, ids) => {
    assertTrusted(event);
    const records = await registry.resolve(safeIds(ids));
    const config = store.internalConfig();
    const setupIssues = validateEmailConfig(config);
    const policy = createEmailBatches(records, config);
    if (setupIssues.length || !policy.ok) return { ok: false, code: 'email_preflight_failed', issues: [...setupIssues, ...policy.issues] };
    let result;
    if (config.smtpProvider === 'gmail') {
      try {
        const token = await googleAuthService.refresh(await store.getGoogleRefreshToken());
        result = await gmailService.send(records, config, token.accessToken);
      } catch (error) {
        result = { ok: false, code: error.code || 'google_connection_failed', message: 'Reconnect your Google account and try again.' };
      }
    } else {
      result = await mailService.send(records, config, await store.getSecret());
    }
    if (result.receipt) await store.addHistory(result.receipt);
    if (result.ok && Notification.isSupported() && !isTestRuntime()) new Notification({ title: 'Books submitted', body: `${records.length} book${records.length === 1 ? '' : 's'} submitted by email.` }).show();
    return result;
  });
  ipcMain.handle('device:probe', async event => { assertTrusted(event); return probePublicDevice(); });
  ipcMain.handle('device:pick-target', async event => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose the Kindle documents folder', properties: ['openDirectory'] });
    if (result.canceled) return { ok: false, canceled: true };
    const documentsPath = await deviceService.validateDocumentsPath(result.filePaths[0]);
    if (!documentsPath) return { ok: false, code: 'invalid_usb_target' };
    await store.save({ usbDocumentsPath: documentsPath });
    return { ok: true, label: path.basename(path.dirname(documentsPath)) };
  });
  ipcMain.handle('delivery:usb', async (event, ids) => {
    assertTrusted(event);
    const records = await registry.resolve(safeIds(ids));
    const config = store.internalConfig();
    const probe = await probeDevice();
    const target = probe.targets.find(item => item.documentsPath === config.usbDocumentsPath) || probe.targets.find(item => item.writable);
    if (!target) return { ok: false, code: probe.state === 'mtp_detected_unsupported' ? probe.state : 'no_usb_target' };
    const result = await usbService.send(records, target.documentsPath, probe.calibre);
    if (result.receipt) await store.addHistory(result.receipt);
    if (result.ok && Notification.isSupported() && !isTestRuntime()) new Notification({ title: 'Kindle copy complete', body: `${records.length} book${records.length === 1 ? '' : 's'} copied and verified.` }).show();
    return result;
  });
  ipcMain.handle('history:clear', async event => { assertTrusted(event); await store.clearHistory(); return { ok: true }; });
  ipcMain.handle('privacy:erase-all', async event => {
    assertTrusted(event);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Erase all KindleSync data?',
      message: 'Erase all KindleSync data from this Mac?',
      detail: 'This removes account connections, addresses, settings, delivery history, and the current queue. Your original books and files already copied to a Kindle are not deleted.',
      buttons: ['Cancel', 'Erase All Data'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (confirmation.response !== 1) return { ok: false, canceled: true };
    const token = await store.getGoogleRefreshToken();
    const revoked = isTestRuntime() ? true : await googleAuthService.revoke(token);
    registry.clear();
    await store.reset();
    await Promise.all([
      appSession.clearStorageData().catch(() => {}),
      session.defaultSession.clearStorageData().catch(() => {}),
      session.defaultSession.clearCache().catch(() => {})
    ]);
    return { ok: true, config: publicConfig(), googleRevocationFailed: Boolean(token && !revoked) };
  });
  ipcMain.handle('external:open', async (event, key) => {
    assertTrusted(event);
    const url = HELP_LINKS[key];
    if (!url) return { ok: false, code: 'link_not_allowed' };
    await shell.openExternal(url);
    return { ok: true };
  });
}

async function flushOpenPaths() {
  if (!rendererReady || !mainWindow || !pendingOpenPaths.length) return;
  const result = await registry.addPaths(pendingOpenPaths);
  pendingOpenPaths = [];
  mainWindow.webContents.send('files:opened', result);
}

function start() {
  if (isTestRuntime() && process.env.KINDLESYNC_USER_DATA_DIR) app.setPath('userData', process.env.KINDLESYNC_USER_DATA_DIR);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('open-file', (event, filePath) => { event.preventDefault(); pendingOpenPaths.push(filePath); flushOpenPaths(); });
  app.on('second-instance', (_event, argv) => {
    pendingOpenPaths.push(...argv.filter(item => !item.startsWith('-')));
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    flushOpenPaths();
  });
  app.whenReady().then(async () => {
    appSession = session.fromPartition('kindlesync-ephemeral', { cache: false });
    await installProtocol();
    appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    appSession.setPermissionCheckHandler(() => false);
    store = new ConfigStore({ filePath: path.join(app.getPath('userData'), 'kindle-sync-config.json'), cryptoProvider: isTestRuntime() ? testCrypto : safeStorage });
    await store.init();
    await CalibreService.cleanupStaleTempDirs();
    registry = new FileRegistry();
    deviceService = new DeviceService();
    mailService = new MailService();
    gmailService = new GmailService();
    googleAuthService = new GoogleAuthService({ clientId: resolveGoogleClientId(require('../../package.json'), { allowEnvironment: !app.isPackaged }), openExternal: url => shell.openExternal(url) });
    usbService = new UsbService({ deviceService, calibreServiceFactory: executable => new CalibreService({ executable }) });
    registerIpc(); installMenu(); createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => { dialog.showErrorBox('KindleSync could not start', error.message); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

module.exports = { start, HELP_LINKS, safeConfigPatch };
