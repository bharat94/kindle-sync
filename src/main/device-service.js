const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');

const execFile = promisify(execFileCallback);

function containsKindleUsbNode(value) {
  if (Array.isArray(value)) return value.some(containsKindleUsbNode);
  if (!value || typeof value !== 'object') return false;
  const text = Object.entries(value)
    .filter(([, item]) => typeof item === 'string')
    .map(([key, item]) => `${key}:${item}`)
    .join(' ')
    .toLowerCase();
  if (text.includes('vendor_id:0x1949') || text.includes('manufacturer:amazon') || text.includes('_name:kindle')) return true;
  return Object.values(value).some(containsKindleUsbNode);
}

class DeviceService {
  constructor({ volumesRoot = '/Volumes', execFileFn = execFile } = {}) {
    this.volumesRoot = volumesRoot;
    this.execFile = execFileFn;
  }

  async findMountedKindles() {
    let names = [];
    try { names = await fs.readdir(this.volumesRoot); } catch { return []; }
    const targets = [];
    for (const name of names) {
      const root = path.join(this.volumesRoot, name);
      const documentsPath = path.join(root, 'documents');
      try {
        const docs = await fs.stat(documentsPath);
        if (!docs.isDirectory()) continue;
        const kindleNamed = name.toLowerCase().includes('kindle');
        const hasSystem = await fs.stat(path.join(root, 'system')).then(s => s.isDirectory()).catch(() => false);
        if (!kindleNamed && !hasSystem) continue;
        const writable = await fs.access(documentsPath, fs.constants.W_OK).then(() => true).catch(() => false);
        targets.push({ id: documentsPath, label: name, documentsPath, writable });
      } catch {}
    }
    return targets;
  }

  async hasMtpKindle() {
    if (process.platform !== 'darwin') return false;
    try {
      const { stdout } = await this.execFile('/usr/sbin/system_profiler', ['SPUSBDataType', '-json'], {
        timeout: 7000,
        maxBuffer: 4 * 1024 * 1024
      });
      return containsKindleUsbNode(JSON.parse(stdout));
    } catch {
      return false;
    }
  }

  async findCalibre() {
    const candidates = [
      '/Applications/calibre.app/Contents/MacOS/ebook-convert',
      '/opt/homebrew/bin/ebook-convert',
      '/usr/local/bin/ebook-convert'
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return { available: true, path: candidate };
      } catch {}
    }
    return { available: false, path: '' };
  }

  async probe() {
    const [targets, mtpDetected, calibre] = await Promise.all([
      this.findMountedKindles(),
      this.hasMtpKindle(),
      this.findCalibre()
    ]);
    let state = 'none';
    if (targets.length > 1) state = 'multiple';
    else if (targets.length === 1) state = targets[0].writable ? 'legacy_ready' : 'legacy_readonly';
    else if (mtpDetected) state = 'mtp_detected_unsupported';
    return { state, targets, mtpDetected, calibre };
  }

  async validateDocumentsPath(documentsPath) {
    if (typeof documentsPath !== 'string' || !documentsPath) return null;
    const real = await fs.realpath(documentsPath).catch(() => null);
    if (!real || path.basename(real).toLowerCase() !== 'documents') return null;
    const parent = path.dirname(real);
    const namedKindle = path.basename(parent).toLowerCase().includes('kindle');
    const hasSystem = await fs.stat(path.join(parent, 'system')).then(s => s.isDirectory()).catch(() => false);
    if (!namedKindle && !hasSystem) return null;
    const writable = await fs.access(real, fs.constants.W_OK).then(() => true).catch(() => false);
    return writable ? real : null;
  }
}

module.exports = { DeviceService, containsKindleUsbNode };
