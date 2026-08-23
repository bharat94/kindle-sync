const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MB, createEmailBatches, validateEmailConfig, validateUsbRecords, maskEmail
} = require('../src/main/delivery-policy');

const record = (id, ext = '.epub', size = 1024) => ({ id: String(id), name: `book-${id}${ext}`, ext, size, path: `/tmp/book-${id}${ext}` });

test('email policy batches at Amazon attachment count', () => {
  const result = createEmailBatches(Array.from({ length: 26 }, (_, i) => record(i)), { smtpProvider: 'gmail', smtpMaxMb: 24 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.batches.map(batch => batch.length), [25, 1]);
});

test('email policy respects provider cap and rejects an individually oversized file', () => {
  const split = createEmailBatches([record(1, '.pdf', 13 * MB), record(2, '.pdf', 13 * MB)], { smtpProvider: 'gmail', smtpMaxMb: 24 });
  assert.deepEqual(split.batches.map(batch => batch.length), [1, 1]);
  const blocked = createEmailBatches([record(3, '.pdf', 25 * MB)], { smtpProvider: 'gmail', smtpMaxMb: 24 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.issues[0].code, 'email_file_too_large');
});

test('transport formats and setup are transport-specific', () => {
  assert.equal(createEmailBatches([record(1, '.azw3')], { smtpProvider: 'gmail' }).issues[0].code, 'unsupported_email_format');
  assert.equal(validateUsbRecords([record(1, '.epub')], { hasCalibre: false }).issues[0].code, 'epub_requires_calibre');
  assert.equal(validateUsbRecords([record(1, '.epub')], { hasCalibre: true }).ok, true);
  assert.deepEqual(validateEmailConfig({ kindleEmail: 'reader@kindle.com', senderEmail: 'me@example.com', approvedSenderConfirmed: true, smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'me', hasSmtpPassword: true }), []);
});

test('Gmail setup requires a matching connected Google account instead of SMTP credentials', () => {
  const ready = { smtpProvider: 'gmail', kindleEmail: 'reader@kindle.com', senderEmail: 'me@gmail.com', googleEmail: 'me@gmail.com', approvedSenderConfirmed: true, hasGoogleAccount: true };
  assert.deepEqual(validateEmailConfig(ready), []);
  assert.deepEqual(validateEmailConfig({ ...ready, hasGoogleAccount: false }), ['google_account']);
  assert.deepEqual(validateEmailConfig({ ...ready, senderEmail: 'other@gmail.com' }), ['google_sender_mismatch']);
});

test('maskEmail does not expose the local part', () => {
  assert.equal(maskEmail('reader_123@kindle.com'), 'r*********@kindle.com');
});
