const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DeviceService } = require('../src/main/device-service');
const { CalibreService } = require('../src/main/calibre-service');
const { UsbService } = require('../src/main/usb-service');

test('Calibre receives hostile filename as one argv value and cleans temp output', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-calibre-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'bad"; touch PWNED; $.epub');
  await fs.writeFile(source, 'epub');
  let captured;
  const calibre = new CalibreService({ executable: '/fake/ebook-convert', execFileFn: async (executable, args) => { captured = { executable, args }; await fs.writeFile(args[1], 'azw3'); } });
  const converted = await calibre.convertEpub({ path: source, name: path.basename(source) });
  assert.equal(captured.executable, '/fake/ebook-convert');
  assert.equal(captured.args[0], source);
  assert.deepEqual(captured.args.slice(2), ['--output-profile', 'kindle_pw']);
  assert.equal(captured.args.includes('--mobi-file-type'), false);
  await calibre.cleanup(converted);
  await assert.rejects(fs.access(converted.tempDir));
});

test('USB copy validates Kindle target, avoids collisions, and verifies bytes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-usb-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const docs = path.join(root, 'Kindle', 'documents');
  await fs.mkdir(docs, { recursive: true });
  const source = path.join(root, 'book.pdf');
  await fs.writeFile(source, 'pdf-data');
  await fs.writeFile(path.join(docs, 'book.pdf'), 'old');
  const deviceService = new DeviceService({ volumesRoot: root, execFileFn: async () => ({ stdout: '{}' }) });
  const service = new UsbService({ deviceService, calibreServiceFactory: () => ({ cleanup: async () => {} }) });
  const result = await service.send([{ id: 'book', path: source, name: 'book.pdf', ext: '.pdf', size: 8 }], docs, { available: false });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'copied_verified');
  assert.equal(await fs.readFile(path.join(docs, 'book (1).pdf'), 'utf8'), 'pdf-data');
  assert.match(result.receipt.statement, /indexing is not independently confirmed/i);
});

test('USB blocks EPUB when Calibre is unavailable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-usb-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const docs = path.join(root, 'Kindle', 'documents');
  await fs.mkdir(docs, { recursive: true });
  const source = path.join(root, 'book.epub');
  await fs.writeFile(source, 'epub');
  const deviceService = new DeviceService({ volumesRoot: root, execFileFn: async () => ({ stdout: '{}' }) });
  const service = new UsbService({ deviceService, calibreServiceFactory: () => ({ cleanup: async () => {} }) });
  const result = await service.send([{ id: 'book', path: source, name: 'book.epub', ext: '.epub', size: 4 }], docs, { available: false });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'epub_requires_calibre');
  await assert.rejects(fs.access(path.join(docs, 'book.epub')));
});

test('startup cleanup removes only KindleSync conversion temp directories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-cleanup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stale = path.join(root, 'kindlesync-convert-stale');
  const unrelated = path.join(root, 'unrelated-private-dir');
  await fs.mkdir(stale);
  await fs.mkdir(unrelated);
  await fs.writeFile(path.join(stale, 'book.azw3'), 'private conversion');
  assert.equal(await CalibreService.cleanupStaleTempDirs(root), 1);
  await assert.rejects(fs.access(stale), { code: 'ENOENT' });
  await fs.access(unrelated);
});
