const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');

const execFile = promisify(execFileCallback);
const TEMP_PREFIX = 'kindlesync-convert-';

class CalibreService {
  constructor({ executable = '', execFileFn = execFile } = {}) {
    this.executable = executable;
    this.execFile = execFileFn;
  }

  async convertEpub(record) {
    if (!this.executable) throw Object.assign(new Error('Calibre is required to convert EPUB for USB'), { code: 'calibre_required' });
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
    await fs.chmod(tempDir, 0o700);
    const output = path.join(tempDir, `${path.parse(record.name).name}.azw3`);
    try {
      await this.execFile(this.executable, [record.path, output, '--output-profile', 'kindle_pw'], {
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true
      });
      const stat = await fs.stat(output);
      if (!stat.isFile() || stat.size === 0) throw new Error('Calibre did not produce a readable AZW3 file');
      return { path: output, name: `${path.parse(record.name).name}.azw3`, tempDir, size: stat.size };
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw Object.assign(new Error(`Could not convert ${record.name}: ${error.message}`), { code: 'conversion_failed' });
    }
  }

  async cleanup(converted) {
    if (converted?.tempDir) await fs.rm(converted.tempDir, { recursive: true, force: true });
  }

  static async cleanupStaleTempDirs(tempRoot = os.tmpdir()) {
    let entries = [];
    try { entries = await fs.readdir(tempRoot, { withFileTypes: true }); } catch { return 0; }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
      const target = path.join(tempRoot, entry.name);
      await fs.rm(target, { recursive: true, force: true }).then(() => { removed += 1; }).catch(() => {});
    }
    return removed;
  }
}

module.exports = { CalibreService, TEMP_PREFIX };
