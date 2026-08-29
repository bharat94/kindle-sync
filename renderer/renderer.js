const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

const MB = 1024 * 1024;
const EMAIL_FORMATS = new Set(['.pdf', '.epub', '.doc', '.docx', '.txt', '.rtf', '.htm', '.html', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.zip']);
const USB_FORMATS = new Set(['.pdf', '.txt', '.azw', '.azw3', '.mobi', '.kfx', '.epub']);
const PROVIDERS = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false, maxMb: 24 },
  icloud: { host: 'smtp.mail.me.com', port: 587, secure: false, maxMb: 19 },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false, maxMb: 24 },
  custom: { host: '', port: 587, secure: false, maxMb: 50 }
};

const els = {
  routeStatus: $('#routeStatus'), dropZone: $('#dropZone'), dropTitle: $('#dropTitle'), dropSubtitle: $('#dropSubtitle'),
  fileInput: $('#fileInput'), chooseButton: $('#chooseButton'), queueSection: $('#queueSection'), fileList: $('#fileList'),
  addMoreButton: $('#addMoreButton'), clearButton: $('#clearButton'), notice: $('#notice'), receipt: $('#receipt'),
  receiptTitle: $('#receiptTitle'), receiptStatement: $('#receiptStatement'), receiptMeta: $('#receiptMeta'),
  detailList: $('#detailList'), batchSummary: $('#batchSummary'), privacySummary: $('#privacySummary'), sendButton: $('#sendButton'),
  usbGuide: $('#usbGuide'), usbGuideTitle: $('#usbGuideTitle'), usbGuideText: $('#usbGuideText'), amazonUsbButton: $('#amazonUsbButton'),
  detectButton: $('#detectButton'), chooseUsbTargetButton: $('#chooseUsbTargetButton'), useWirelessButton: $('#useWirelessButton'), settingsButton: $('#settingsButton'),
  historyButton: $('#historyButton'), settingsDialog: $('#settingsDialog'), settingsForm: $('#settingsForm'),
  settingsMessage: $('#settingsMessage'), historyDialog: $('#historyDialog'), historyList: $('#historyList'), emptyHistory: $('#emptyHistory'),
  kindleEmail: $('#kindleEmail'), senderEmail: $('#senderEmail'), approvedSender: $('#approvedSender'), smtpProvider: $('#smtpProvider'),
  smtpHost: $('#smtpHost'), smtpPort: $('#smtpPort'), smtpSecure: $('#smtpSecure'), smtpUser: $('#smtpUser'), smtpPass: $('#smtpPass'),
  smtpMaxMb: $('#smtpMaxMb'), saveSettingsButton: $('#saveSettingsButton'), testButton: $('#testButton'), forgetPasswordButton: $('#forgetPasswordButton'),
  webFallbackButton: $('#webFallbackButton'), appPasswordHelp: $('#appPasswordHelp'), smtpFields: $('#smtpFields'),
  googleAccountPanel: $('#googleAccountPanel'), googleAccountTitle: $('#googleAccountTitle'), googleAccountDetail: $('#googleAccountDetail'),
  googleSignInButton: $('#googleSignInButton'), googleDisconnectButton: $('#googleDisconnectButton'), providerDescription: $('#providerDescription'),
  eraseDataButton: $('#eraseDataButton'), googleSetupHelp: $('#googleSetupHelp')
};

const state = {
  mode: 'email',
  queue: [],
  config: {},
  device: { state: 'none', targets: [], calibre: { available: false } },
  history: [],
  busy: false,
  noticeSource: null
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`;
}

function addDetail(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${message}`;
  els.detailList.prepend(item);
}

function showNotice(message, type = 'warning', source = 'external') {
  state.noticeSource = message ? source : null;
  els.notice.hidden = !message;
  els.notice.classList.toggle('error', type === 'error');
  els.notice.textContent = message || '';
}

function wirelessReady() {
  const baseReady = /^\S+@(?:kindle\.com|free\.kindle\.com)$/i.test(state.config.kindleEmail || '') &&
    /^\S+@\S+\.\S+$/.test(state.config.senderEmail || '') && state.config.approvedSenderConfirmed;
  if (state.config.smtpProvider === 'gmail') {
    return baseReady && state.config.hasGoogleAccount && state.config.senderEmail === state.config.googleEmail;
  }
  return baseReady && state.config.smtpHost && state.config.smtpUser && state.config.hasSmtpPassword;
}

function emailPolicy() {
  const cap = Math.min(50, Math.max(1, Number(state.config.smtpMaxMb) || 24)) * MB;
  const pending = state.queue.filter(file => !isTerminal(file));
  const issues = pending.filter(file => !EMAIL_FORMATS.has(file.ext) || file.size > cap);
  let batchCount = 0;
  let count = 0;
  let bytes = 0;
  for (const file of pending.filter(item => !issues.includes(item))) {
    if (count === 25 || bytes + file.size > cap) { batchCount += 1; count = 0; bytes = 0; }
    count += 1; bytes += file.size;
  }
  if (count) batchCount += 1;
  return { cap, issues, batchCount };
}

function usbIssues() {
  return state.queue.filter(file => !isTerminal(file) && (!USB_FORMATS.has(file.ext) || (file.ext === '.epub' && !state.device.calibre?.available)));
}

function isTerminal(file) {
  return file.status === 'Submitted' || file.status === 'Copied & verified';
}

function statusFor(file) {
  if (file.status && file.status !== 'ready') return file.status;
  if (state.mode === 'email') {
    const policy = emailPolicy();
    if (!EMAIL_FORMATS.has(file.ext)) return 'Unsupported for email';
    if (file.size > policy.cap) return `Over ${formatBytes(policy.cap)} provider limit`;
  } else {
    if (!USB_FORMATS.has(file.ext)) return 'Unsupported for USB';
    if (file.ext === '.epub' && !state.device.calibre?.available) return 'Needs Calibre or Wireless';
  }
  return 'Ready';
}

function renderQueue() {
  els.fileList.replaceChildren();
  for (const file of state.queue) {
    const row = document.createElement('li');
    row.className = 'file-row';
    const badge = document.createElement('span');
    badge.className = 'file-badge';
    badge.textContent = file.ext.replace('.', '').slice(0, 4) || 'FILE';
    const copy = document.createElement('div');
    copy.className = 'file-copy';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    name.title = file.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = `${file.ext.replace('.', '').toUpperCase() || 'File'} · ${formatBytes(file.size)}`;
    copy.append(name, meta);
    const status = document.createElement('span');
    status.className = 'file-state';
    const statusText = statusFor(file);
    status.textContent = statusText;
    if (['Submitted', 'Copied & verified'].includes(statusText)) status.classList.add('success');
    if (statusText.includes('Unsupported') || statusText.includes('Over ') || statusText.includes('Needs ') || statusText === 'Failed') status.classList.add('error');
    const remove = document.createElement('button');
    remove.className = 'remove-button';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.disabled = state.busy;
    remove.addEventListener('click', async () => {
      await window.kindleSync.removeFile(file.id);
      state.queue = state.queue.filter(item => item.id !== file.id);
      render();
    });
    row.append(badge, copy, status, remove);
    els.fileList.append(row);
  }
  const hasFiles = state.queue.length > 0;
  els.queueSection.hidden = !hasFiles;
  els.dropZone.classList.toggle('compact', hasFiles);
  els.dropTitle.textContent = hasFiles ? 'Add more books' : 'Drop books to send';
  els.dropSubtitle.textContent = hasFiles ? 'Drop files here or choose more' : 'EPUB, PDF, Word, text, HTML, and images';
  els.chooseButton.textContent = hasFiles ? 'Choose…' : 'Choose Books…';
}

function setRouteStatus(text, ready = false) {
  els.routeStatus.lastElementChild.textContent = text;
  els.routeStatus.classList.toggle('ready', ready);
}

function renderUsbGuide() {
  els.usbGuide.hidden = state.mode !== 'usb' || state.device.state === 'legacy_ready';
  els.amazonUsbButton.hidden = state.device.state !== 'mtp_detected_unsupported';
  els.chooseUsbTargetButton.hidden = state.device.state !== 'multiple';
  const messages = {
    detecting: ['Looking for Kindle…', 'Checking mounted volumes and connected USB devices.'],
    none: ['Connect your Kindle', 'Use a data cable, unlock the Kindle, then wait a moment.'],
    legacy_readonly: ['Kindle is not writable', 'Unlock it, close other transfer apps, and reconnect the cable.'],
    multiple: ['More than one Kindle found', 'Choose the Kindle you want to use, or disconnect the extra device.'],
    mtp_detected_unsupported: ['Modern Kindle detected', 'This Kindle uses MTP. Native direct transfer is not available in this version; use Wireless or Amazon’s USB File Manager.']
  };
  const [title, text] = messages[state.device.state] || messages.none;
  els.usbGuideTitle.textContent = title;
  els.usbGuideText.textContent = text;
}

function renderAction() {
  const total = state.queue.reduce((sum, file) => sum + file.size, 0);
  let disabled = state.busy || state.queue.length === 0;
  let label = state.busy ? (state.mode === 'email' ? 'Submitting…' : 'Copying…') : `Send ${state.queue.length || ''} Book${state.queue.length === 1 ? '' : 's'}`;
  let summary = state.queue.length ? `${state.queue.length} book${state.queue.length === 1 ? '' : 's'} · ${formatBytes(total)}` : 'No books queued';
  const pendingCount = state.queue.filter(file => !isTerminal(file)).length;
  if (state.queue.length && pendingCount === 0 && !state.busy) {
    label = 'Clear Completed';
    disabled = false;
  } else if (pendingCount && pendingCount !== state.queue.length && !state.busy) {
    label = `Retry ${pendingCount} Book${pendingCount === 1 ? '' : 's'}`;
  }
  let validationMessage = '';

  if (state.mode === 'email') {
    const policy = emailPolicy();
    disabled ||= policy.issues.length > 0;
    if (!wirelessReady() && state.queue.length) label = 'Finish Wireless Setup';
    if (policy.batchCount > 1) summary += ` · ${policy.batchCount} email batches`;
    els.privacySummary.textContent = 'Wireless sends files through your mail provider to Amazon.';
    setRouteStatus(wirelessReady() ? 'Wireless ready' : 'Setup required', wirelessReady());
    els.webFallbackButton.hidden = policy.issues.length === 0;
    if (policy.issues.length) validationMessage = 'One or more books are unsupported or exceed your mail provider’s batch limit. Amazon’s official web uploader accepts supported documents up to 200 MB.';
  } else {
    els.webFallbackButton.hidden = true;
    const issues = usbIssues();
    disabled ||= issues.length > 0 || state.device.state !== 'legacy_ready';
    els.privacySummary.textContent = 'USB keeps files local and copies only to a validated legacy Kindle volume.';
    const labels = { legacy_ready: 'Kindle connected', legacy_readonly: 'Kindle read-only', mtp_detected_unsupported: 'MTP handoff needed', multiple: 'Choose Kindle', detecting: 'Detecting…', none: 'No Kindle' };
    setRouteStatus(labels[state.device.state] || 'No Kindle', state.device.state === 'legacy_ready');
    if (issues.length) validationMessage = state.device.calibre?.available ? 'One or more files are not compatible with direct USB copy.' : 'EPUB needs Calibre for USB conversion. Install Calibre or use Wireless.';
  }
  if (validationMessage) showNotice(validationMessage, 'warning', 'validation');
  else if (state.noticeSource === 'validation') showNotice('');
  els.batchSummary.textContent = summary;
  els.sendButton.textContent = label;
  els.sendButton.disabled = disabled && !(state.mode === 'email' && state.queue.length && !wirelessReady() && !state.busy);
}

function renderHistory() {
  els.historyList.replaceChildren();
  els.emptyHistory.hidden = state.history.length > 0;
  for (const receipt of state.history) {
    const item = document.createElement('li');
    item.className = 'history-item';
    const title = document.createElement('strong');
    const count = receipt.files?.length || 0;
    title.textContent = receipt.method === 'email' ? `${count} book${count === 1 ? '' : 's'} submitted` : `${count} book${count === 1 ? '' : 's'} copied`;
    const meta = document.createElement('span');
    const date = new Date(receipt.createdAt).toLocaleString();
    meta.textContent = `${date} · ${receipt.destination || receipt.status}`;
    const statement = document.createElement('span');
    statement.textContent = receipt.statement || '';
    item.append(title, meta, statement);
    els.historyList.append(item);
  }
}

function render() {
  renderQueue();
  renderUsbGuide();
  renderAction();
  renderHistory();
  $$('.mode-button').forEach(button => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function ingest(result) {
  if (!result) return;
  const existing = new Set(state.queue.map(file => file.id));
  for (const file of result.added || []) {
    if (!existing.has(file.id)) { state.queue.push({ ...file, status: 'ready' }); existing.add(file.id); }
  }
  for (const rejected of result.rejected || []) addDetail(`${rejected.name}: ${rejected.error}`);
  if (result.rejected?.length) showNotice(`${result.rejected.length} item${result.rejected.length === 1 ? '' : 's'} could not be queued. See Transfer details.`, 'error');
  if (result.added?.length) addDetail(`Queued ${result.added.length} book${result.added.length === 1 ? '' : 's'}.`);
  render();
}

async function probeDevice() {
  state.device = { ...state.device, state: 'detecting' };
  render();
  try {
    state.device = await window.kindleSync.probeDevice();
    addDetail(state.device.state === 'legacy_ready' ? 'A writable legacy Kindle volume is ready.' : state.device.state === 'mtp_detected_unsupported' ? 'A modern MTP Kindle was detected; direct transfer requires a future native helper.' : 'Kindle detection completed.');
  } catch {
    state.device = { state: 'none', targets: [], calibre: { available: false } };
    showNotice('Kindle detection failed. Try again.', 'error');
  }
  render();
}

function applyProviderPreset() {
  const preset = PROVIDERS[els.smtpProvider.value];
  if (preset && els.smtpProvider.value !== 'custom') {
    els.smtpHost.value = preset.host;
    els.smtpPort.value = preset.port;
    els.smtpSecure.checked = preset.secure;
    els.smtpMaxMb.value = preset.maxMb;
  }
  updateProviderVisibility();
}

function updateProviderVisibility() {
  const isGoogle = els.smtpProvider.value === 'gmail';
  els.googleAccountPanel.hidden = !isGoogle;
  els.smtpFields.hidden = isGoogle;
  els.testButton.hidden = isGoogle;
  els.forgetPasswordButton.hidden = isGoogle;
  els.senderEmail.readOnly = isGoogle;
  if (isGoogle) els.senderEmail.value = state.config.googleEmail || '';
  els.providerDescription.textContent = isGoogle
    ? 'Connect Google once. KindleSync requests permission to send email—not to read your inbox.'
    : 'Use an app-specific password. It is encrypted with macOS Keychain.';
  const connected = Boolean(state.config.hasGoogleAccount && state.config.googleEmail);
  els.googleAccountTitle.textContent = connected ? state.config.googleEmail : 'Google account not connected';
  els.googleAccountDetail.textContent = connected
    ? 'Connected with send-only Gmail access. Token stored in macOS Keychain.'
    : state.config.googleOAuthAvailable
      ? 'A secure browser window will ask for Gmail send-only access.'
      : 'This build has no Google OAuth client ID. Put one in .env as KINDLESYNC_GOOGLE_CLIENT_ID and restart, or pick another provider below and use an app password.';
  els.googleSignInButton.hidden = connected;
  els.googleSignInButton.disabled = !state.config.googleOAuthAvailable;
  els.googleDisconnectButton.hidden = !connected;
  els.appPasswordHelp.hidden = true;
  els.googleSetupHelp.hidden = !isGoogle || connected || Boolean(state.config.googleOAuthAvailable);
}

function fillSettings() {
  els.kindleEmail.value = state.config.kindleEmail || '';
  els.senderEmail.value = state.config.senderEmail || '';
  els.approvedSender.checked = Boolean(state.config.approvedSenderConfirmed);
  els.smtpProvider.value = state.config.smtpProvider || 'gmail';
  els.smtpHost.value = state.config.smtpHost || PROVIDERS.gmail.host;
  els.smtpPort.value = state.config.smtpPort || 587;
  els.smtpSecure.checked = Boolean(state.config.smtpSecure);
  els.smtpUser.value = state.config.smtpUser || '';
  els.smtpPass.value = '';
  els.smtpPass.placeholder = state.config.hasSmtpPassword ? 'Saved securely — leave blank to keep' : 'App-specific password';
  els.smtpMaxMb.value = state.config.smtpMaxMb || PROVIDERS[els.smtpProvider.value].maxMb;
  updateProviderVisibility();
  els.settingsMessage.hidden = true;
}

function openSettings() {
  fillSettings();
  if (!els.settingsDialog.open) els.settingsDialog.showModal();
}

async function saveSettings({ close = true, silent = false } = {}) {
  els.settingsMessage.hidden = true;
  try {
    state.config = await window.kindleSync.saveConfig({
      deliveryMode: state.mode,
      kindleEmail: els.kindleEmail.value,
      senderEmail: els.senderEmail.value,
      approvedSenderConfirmed: els.approvedSender.checked,
      smtpProvider: els.smtpProvider.value,
      smtpHost: els.smtpHost.value,
      smtpPort: Number(els.smtpPort.value),
      smtpSecure: els.smtpSecure.checked,
      smtpUser: els.smtpUser.value,
      smtpPass: els.smtpPass.value,
      smtpMaxMb: Number(els.smtpMaxMb.value)
    });
    if (!silent) {
      els.settingsMessage.textContent = els.smtpProvider.value === 'gmail'
        ? 'Settings saved. Your Google token is protected by macOS Keychain.'
        : 'Settings saved. The app password is protected by macOS Keychain.';
      els.settingsMessage.className = 'form-message success';
      els.settingsMessage.hidden = false;
    }
    addDetail('Wireless settings saved.');
    render();
    if (close) els.settingsDialog.close();
    return true;
  } catch (error) {
    els.settingsMessage.textContent = `Could not save settings: ${error.message}`;
    els.settingsMessage.className = 'form-message';
    els.settingsMessage.hidden = false;
    return false;
  }
}

function showReceipt(receipt) {
  if (!receipt) return;
  els.receipt.hidden = false;
  const count = receipt.files?.length || 0;
  els.receiptTitle.textContent = receipt.method === 'email' ? `${count} book${count === 1 ? '' : 's'} submitted by email` : `${count} book${count === 1 ? '' : 's'} copied and verified`;
  els.receiptStatement.textContent = receipt.statement;
  els.receiptMeta.textContent = `${new Date(receipt.createdAt).toLocaleString()}${receipt.destination ? ` · ${receipt.destination}` : ''}${receipt.messageIds?.[0] ? ` · Message ID ${receipt.messageIds[0]}` : ''}`;
}

async function send() {
  if (!state.queue.length || state.busy) return;
  const pendingFiles = state.queue.filter(file => !isTerminal(file));
  if (!pendingFiles.length) {
    await Promise.all(state.queue.map(file => window.kindleSync.removeFile(file.id)));
    state.queue = [];
    els.receipt.hidden = true;
    render();
    return;
  }
  if (state.mode === 'email' && !wirelessReady()) { openSettings(); return; }
  state.busy = true;
  pendingFiles.forEach(file => { file.status = state.mode === 'email' ? 'Submitting' : 'Copying'; });
  els.receipt.hidden = true;
  showNotice('');
  render();
  try {
    const ids = pendingFiles.map(file => file.id);
    const result = state.mode === 'email' ? await window.kindleSync.sendEmail(ids) : await window.kindleSync.sendUsb(ids);
    if (result.ok) {
      if (state.mode === 'email') pendingFiles.forEach(file => { file.status = 'Submitted'; });
      else for (const file of pendingFiles) file.status = result.results?.find(item => item.id === file.id)?.status === 'copied_verified' ? 'Copied & verified' : 'Failed';
      state.history.unshift(result.receipt);
      state.history = state.history.slice(0, 50);
      showReceipt(result.receipt);
      addDetail(result.receipt.statement);
    } else {
      const submittedIds = new Set((result.submitted || []).flatMap(batch => batch.ids || []));
      for (const file of pendingFiles) {
        const usbResult = result.results?.find(item => item.id === file.id);
        if (submittedIds.has(file.id)) file.status = 'Submitted';
        else if (usbResult?.status === 'copied_verified') file.status = 'Copied & verified';
        else file.status = 'ready';
      }
      const messages = {
        mtp_detected_unsupported: 'This Kindle uses MTP. Use Wireless or Amazon’s USB File Manager.',
        no_usb_target: 'No writable legacy Kindle volume is connected.',
        email_preflight_failed: 'The wireless setup or one of the queued files needs attention.',
        usb_preflight_failed: 'One or more files cannot be copied with the current USB setup.'
      };
      const partial = submittedIds.size || result.results?.some(item => item.status === 'copied_verified');
      showNotice(partial ? 'Some books completed before the failure. Retry sends only the books still marked Ready.' : (messages[result.code] || result.message || 'The transfer could not be completed.'), 'error');
      if (result.receipt) {
        state.history.unshift(result.receipt);
        state.history = state.history.slice(0, 50);
        showReceipt(result.receipt);
      }
      addDetail(`Transfer failed: ${result.code || result.message || 'unknown error'}.`);
    }
  } catch (error) {
    pendingFiles.forEach(file => { file.status = 'ready'; });
    showNotice('The transfer stopped unexpectedly. No delivery confirmation was recorded.', 'error');
    addDetail(`Transfer error: ${error.message}`);
  } finally {
    state.busy = false;
    render();
  }
}

$$('.mode-button').forEach(button => button.addEventListener('click', () => {
  state.mode = button.dataset.mode;
  state.config.deliveryMode = state.mode;
  state.queue.forEach(file => { if (!['Submitted', 'Copied & verified'].includes(file.status)) file.status = 'ready'; });
  if (state.mode === 'usb') probeDevice();
  render();
}));

async function chooseFiles() {
  ingest(await window.kindleSync.pickFiles());
}

for (const button of [els.chooseButton, els.addMoreButton]) button.addEventListener('click', chooseFiles);
els.fileInput.addEventListener('change', async event => { ingest(await window.kindleSync.registerDroppedFiles(event.target.files)); event.target.value = ''; });
['dragenter', 'dragover'].forEach(name => els.dropZone.addEventListener(name, event => { event.preventDefault(); els.dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(name => els.dropZone.addEventListener(name, async event => {
  event.preventDefault();
  els.dropZone.classList.remove('dragging');
  if (name === 'drop') ingest(await window.kindleSync.registerDroppedFiles(event.dataTransfer.files));
}));
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
els.clearButton.addEventListener('click', async () => { await Promise.all(state.queue.map(file => window.kindleSync.removeFile(file.id))); state.queue = []; render(); });
els.sendButton.addEventListener('click', send);
els.settingsButton.addEventListener('click', openSettings);
els.settingsForm.addEventListener('submit', async event => { event.preventDefault(); await saveSettings(); });
$$('.close-dialog').forEach(button => button.addEventListener('click', event => { event.preventDefault(); button.closest('dialog').close(); }));
els.smtpProvider.addEventListener('change', applyProviderPreset);
els.googleSignInButton.addEventListener('click', async () => {
  els.settingsMessage.hidden = true;
  els.googleSignInButton.disabled = true;
  els.googleSignInButton.textContent = 'Opening Google…';
  try {
    await saveSettings({ close: false, silent: true });
    state.config = await window.kindleSync.signInWithGoogle();
    fillSettings();
    els.settingsMessage.textContent = `Connected ${state.config.googleEmail}. Add this address to Amazon's approved sender list.`;
    els.settingsMessage.className = 'form-message success';
    els.settingsMessage.hidden = false;
    addDetail('Google account connected with Gmail send-only access.');
    render();
  } catch (error) {
    els.settingsMessage.textContent = error.message || 'Google sign-in could not be completed.';
    els.settingsMessage.className = 'form-message';
    els.settingsMessage.hidden = false;
  } finally {
    els.googleSignInButton.textContent = 'Sign in with Google';
    els.googleSignInButton.disabled = !state.config.googleOAuthAvailable;
  }
});
els.googleDisconnectButton.addEventListener('click', async () => {
  state.config = await window.kindleSync.disconnectGoogle();
  fillSettings();
  if (state.config.googleRevocationFailed) {
    els.settingsMessage.textContent = 'Disconnected on this Mac, but Google could not be reached to revoke access. Remove KindleSync from your Google Account connections.';
    els.settingsMessage.className = 'form-message';
    els.settingsMessage.hidden = false;
  }
  render();
});
els.eraseDataButton.addEventListener('click', async () => {
  const result = await window.kindleSync.eraseAllData();
  if (!result.ok) return;
  state.config = result.config || {};
  state.history = [];
  state.queue = [];
  state.mode = 'email';
  els.receipt.hidden = true;
  els.detailList.replaceChildren();
  els.settingsDialog.close();
  render();
  showNotice(result.googleRevocationFailed
    ? 'Local data was erased. Google could not be reached, so also remove KindleSync from your Google Account connections.'
    : 'All KindleSync data was erased from this Mac.', result.googleRevocationFailed ? 'warning' : 'success', 'privacy');
  addDetail('Local KindleSync data was erased.');
});
els.testButton.addEventListener('click', async () => {
  if (!(await saveSettings({ close: false }))) return;
  els.testButton.disabled = true;
  els.testButton.textContent = 'Testing…';
  const result = await window.kindleSync.testSmtp().catch(() => ({ ok: false }));
  els.settingsMessage.textContent = result.ok ? 'Connection succeeded. No book was sent.' : 'Connection failed. Check the username, app password, provider, port, and TLS settings.';
  els.settingsMessage.className = result.ok ? 'form-message success' : 'form-message';
  els.settingsMessage.hidden = false;
  els.testButton.disabled = false;
  els.testButton.textContent = 'Test Connection';
});
els.forgetPasswordButton.addEventListener('click', async () => { state.config = await window.kindleSync.forgetSmtpPassword(); fillSettings(); render(); });
$('#amazonSettingsButton').addEventListener('click', () => window.kindleSync.openHelp('amazonSettings'));
els.amazonUsbButton.addEventListener('click', () => window.kindleSync.openHelp('amazonUsbHelp'));
els.webFallbackButton.addEventListener('click', () => window.kindleSync.openHelp('sendToKindle'));
els.googleSetupHelp.addEventListener('click', () => window.kindleSync.openHelp('googleCloudSetup'));
els.detectButton.addEventListener('click', probeDevice);
els.chooseUsbTargetButton.addEventListener('click', async () => {
  const result = await window.kindleSync.pickUsbTarget();
  if (result.ok) await probeDevice();
  else if (!result.canceled) showNotice('Choose the documents folder on a mounted legacy Kindle.', 'error');
});
els.useWirelessButton.addEventListener('click', () => $('.mode-button[data-mode="email"]').click());
els.historyButton.addEventListener('click', () => { renderHistory(); els.historyDialog.showModal(); });
$('.close-history').addEventListener('click', () => els.historyDialog.close());
els.clearHistoryButton = $('#clearHistoryButton');
els.clearHistoryButton.addEventListener('click', async () => { await window.kindleSync.clearHistory(); state.history = []; renderHistory(); });

window.kindleSync.onFilesOpened(ingest);
window.kindleSync.onCommand(command => {
  if (command === 'settings') openSettings();
  if (command === 'add') chooseFiles();
  if (command === 'send') send();
  if (command === 'detect') probeDevice();
});

(async function init() {
  try {
    const initial = await window.kindleSync.getState();
    state.config = initial.config || {};
    state.history = initial.history || [];
    state.mode = state.config.deliveryMode === 'usb' ? 'usb' : 'email';
    render();
    if (state.mode === 'usb') await probeDevice();
    addDetail('KindleSync is ready.');
  } catch (error) {
    showNotice(`KindleSync could not load its local configuration: ${error.message}`, 'error');
  }
})();
