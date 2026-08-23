const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { validateUsbRecords } = require('./delivery-policy');

async function chooseDestination(documentsPath, name) {
  const parsed = path.parse(name);
  for (let counter = 0; counter < 10_000; counter += 1) {
    const candidateName = counter === 0 ? name : `${parsed.name} (${counter})${parsed.ext}`;
    const candidate = path.join(documentsPath, candidateName);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('Could not choose an unused destination name');
}

class UsbService {
  constructor({ deviceService, calibreServiceFactory }) {
    this.deviceService = deviceService;
    this.calibreServiceFactory = calibreServiceFactory;
  }

  async send(records, documentsPath, calibreInfo) {
    const validatedTarget = await this.deviceService.validateDocumentsPath(documentsPath);
    if (!validatedTarget) return { ok: false, code: 'invalid_usb_target', message: 'The selected folder is not a writable Kindle documents folder.' };

    const policy = validateUsbRecords(records, { hasCalibre: Boolean(calibreInfo?.available) });
    if (!policy.ok) return { ok: false, code: 'usb_preflight_failed', issues: policy.issues };

    const calibre = this.calibreServiceFactory(calibreInfo?.path || '');
    const results = [];
    for (const record of records) {
      let source = record;
      let converted = null;
      try {
        if (record.ext === '.epub') {
          converted = await calibre.convertEpub(record);
          source = { ...record, ...converted, ext: '.azw3' };
        }
        const destination = await chooseDestination(validatedTarget, source.name);
        const partial = `${destination}.kindlesync-part-${process.pid}`;
        try {
          await fs.copyFile(source.path, partial, constants.COPYFILE_EXCL);
          const [sourceStat, partialStat] = await Promise.all([fs.stat(source.path), fs.stat(partial)]);
          if (sourceStat.size !== partialStat.size) throw new Error('Copied byte count did not match the source');
          await fs.rename(partial, destination);
          const finalStat = await fs.stat(destination);
          if (finalStat.size !== sourceStat.size) throw new Error('Destination verification failed');
          results.push({ id: record.id, name: record.name, status: 'copied_verified', outputName: path.basename(destination), converted: Boolean(converted), size: finalStat.size });
        } finally {
          await fs.rm(partial, { force: true }).catch(() => {});
        }
      } catch (error) {
        results.push({ id: record.id, name: record.name, status: 'failed', code: error.code || 'usb_copy_failed', message: error.message });
      } finally {
        await calibre.cleanup(converted).catch(() => {});
      }
    }
    const successful = results.filter(result => result.status === 'copied_verified');
    const receipt = {
      id: `usb-${Date.now()}`,
      method: 'usb',
      status: successful.length === records.length ? 'copied_verified' : 'partial',
      createdAt: new Date().toISOString(),
      files: successful.map(({ name, size, outputName }) => ({ name, size, outputName })),
      statement: 'Copied bytes were verified on the Kindle volume; library indexing is not independently confirmed.'
    };
    return { ok: successful.length === records.length, status: receipt.status, results, receipt };
  }
}

module.exports = { UsbService, chooseDestination };
