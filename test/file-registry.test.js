const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileRegistry } = require('../src/main/file-registry');

test('registers opaque metadata, deduplicates, and rejects directories/symlinks', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-registry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hostile = path.join(dir, '<img onerror=alert(1)>.epub');
  const link = path.join(dir, 'link.epub');
  await fs.writeFile(hostile, 'ebook');
  await fs.symlink(hostile, link);
  const registry = new FileRegistry();
  const result = await registry.addPaths([hostile, hostile, dir, link]);
  assert.equal(result.added.length, 2);
  assert.equal(result.added[0].id, result.added[1].id);
  assert.equal(result.added[0].path, undefined);
  assert.equal(result.added[0].name, '<img onerror=alert(1)>.epub');
  assert.equal(result.rejected.length, 2);
  const resolved = await registry.resolve([result.added[0].id]);
  assert.equal(resolved[0].path, await fs.realpath(hostile));
});

test('detects files changed after queueing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindlesync-registry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'book.epub');
  await fs.writeFile(file, 'one');
  const registry = new FileRegistry();
  const result = await registry.addPaths([file]);
  await fs.writeFile(file, 'changed');
  await assert.rejects(() => registry.resolve([result.added[0].id]), { code: 'file_changed' });
});
