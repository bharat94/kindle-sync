const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kindleSync', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  registerDroppedFiles: files => {
    // Recover paths item by item: a single undroppable entry (a folder, or a
    // drag source with no filesystem backing) must not discard the whole batch.
    const paths = [];
    for (const file of Array.from(files || [])) {
      try {
        const filePath = webUtils.getPathForFile(file);
        if (filePath) paths.push(filePath);
      } catch {}
    }
    return ipcRenderer.invoke('files:register-drop', paths);
  },
  removeFile: id => ipcRenderer.invoke('files:remove', id),
  saveConfig: config => ipcRenderer.invoke('config:save', config),
  forgetSmtpPassword: () => ipcRenderer.invoke('config:forget-secret'),
  testSmtp: () => ipcRenderer.invoke('smtp:test'),
  signInWithGoogle: () => ipcRenderer.invoke('google:sign-in'),
  disconnectGoogle: () => ipcRenderer.invoke('google:disconnect'),
  clearGoogleClient: () => ipcRenderer.invoke('google:clear-client'),
  cancelGoogleSignIn: () => ipcRenderer.invoke('google:cancel-sign-in'),
  sendEmail: ids => ipcRenderer.invoke('delivery:email', ids),
  probeDevice: () => ipcRenderer.invoke('device:probe'),
  pickUsbTarget: () => ipcRenderer.invoke('device:pick-target'),
  sendUsb: ids => ipcRenderer.invoke('delivery:usb', ids),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  eraseAllData: () => ipcRenderer.invoke('privacy:erase-all'),
  openHelp: key => ipcRenderer.invoke('external:open', key),
  onFilesOpened: callback => ipcRenderer.on('files:opened', (_event, payload) => callback(payload)),
  onCommand: callback => ipcRenderer.on('app:command', (_event, command) => callback(command))
});
