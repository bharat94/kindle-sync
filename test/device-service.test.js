const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DeviceService, containsKindleUsbNode } = require('../src/main/device-service');

test('parses Kindle USB nodes without treating unrelated devices as Kindle', () => {
  assert.equal(containsKindleUsbNode({ SPUSBDataType: [{ _name: 'Kindle Paperwhite', vendor_id: '0x1949' }] }), true);
  assert.equal(containsKindleUsbNode({ SPUSBDataType: [{ _name: 'USB Keyboard', manufacturer: 'Apple' }] }), false);
});

test('finds only validated mounted Kindle volumes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-volumes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'Kindle', 'documents'), { recursive: true });
  await fs.mkdir(path.join(root, 'External', 'documents'), { recursive: true });
  const service = new DeviceService({ volumesRoot: root, execFileFn: async () => ({ stdout: '{}' }) });
  const probe = await service.probe();
  assert.equal(probe.state, 'legacy_ready');
  assert.equal(probe.targets.length, 1);
  assert.equal(path.basename(probe.targets[0].documentsPath), 'documents');
});

test('distinguishes an enumerated MTP Kindle from no device', async () => {
  const service = new DeviceService({ volumesRoot: '/definitely/missing', execFileFn: async () => ({ stdout: JSON.stringify({ SPUSBDataType: [{ _name: 'Kindle Scribe', vendor_id: '0x1949' }] }) }) });
  assert.equal((await service.probe()).state, 'mtp_detected_unsupported');
});
