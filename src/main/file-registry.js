const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class FileRegistry {
  constructor() {
    this.records = new Map();
    this.byRealPath = new Map();
  }

  async addPaths(filePaths) {
    const added = [];
    const rejected = [];
    for (const input of Array.isArray(filePaths) ? filePaths : []) {
      try {
        if (typeof input !== 'string' || !input) throw new Error('Invalid file');
        const inputStat = await fs.lstat(input);
        if (inputStat.isSymbolicLink()) throw new Error('Symbolic links are not accepted');
        if (!inputStat.isFile()) throw new Error('Only regular files can be queued');
        const realPath = await fs.realpath(input);
        const lstat = await fs.lstat(realPath);
        if (lstat.isSymbolicLink() || !lstat.isFile()) throw new Error('Only regular files can be queued');
        if (lstat.size === 0) throw new Error('Empty files cannot be sent');
        const existingId = this.byRealPath.get(realPath);
        if (existingId) {
          added.push(this.publicRecord(this.records.get(existingId)));
          continue;
        }
        const record = {
          id: randomUUID(),
          path: realPath,
          name: path.basename(realPath),
          size: lstat.size,
          device: lstat.dev,
          inode: lstat.ino,
          modifiedMs: lstat.mtimeMs,
          ext: path.extname(realPath).toLowerCase()
        };
        this.records.set(record.id, record);
        this.byRealPath.set(realPath, record.id);
        added.push(this.publicRecord(record));
      } catch (error) {
        rejected.push({ name: typeof input === 'string' ? path.basename(input) : 'Unknown item', error: error.message });
      }
    }
    return { added, rejected };
  }

  publicRecord(record) {
    return { id: record.id, name: record.name, size: record.size, ext: record.ext };
  }

  async resolve(ids) {
    const resolved = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const record = this.records.get(id);
      if (!record) throw Object.assign(new Error('A queued file is no longer available'), { code: 'unknown_file' });
      const stat = await fs.lstat(record.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size || stat.dev !== record.device || stat.ino !== record.inode || stat.mtimeMs !== record.modifiedMs) {
        throw Object.assign(new Error(`${record.name} changed after it was queued`), { code: 'file_changed' });
      }
      resolved.push(record);
    }
    return resolved;
  }

  remove(id) {
    const record = this.records.get(id);
    if (!record) return false;
    this.records.delete(id);
    this.byRealPath.delete(record.path);
    return true;
  }

  clear() {
    this.records.clear();
    this.byRealPath.clear();
  }
}

module.exports = { FileRegistry };
