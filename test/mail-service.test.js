const test = require('node:test');
const assert = require('node:assert/strict');
const { MailService } = require('../src/main/mail-service');

const config = { kindleEmail: 'reader@kindle.com', senderEmail: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecure: false, smtpUser: 'me', smtpProvider: 'custom', smtpMaxMb: 50 };

test('SMTP test verifies without sending a document', async () => {
  let verified = 0;
  let sent = 0;
  const service = new MailService({ transportFactory: () => ({ verify: async () => { verified += 1; }, sendMail: async () => { sent += 1; }, close() {} }) });
  assert.deepEqual(await service.test(config, 'secret'), { ok: true });
  assert.equal(verified, 1);
  assert.equal(sent, 0);
});

test('submitted receipt is truthful and batches 26 attachments', async () => {
  const messages = [];
  const service = new MailService({ transportFactory: options => ({
    sendMail: async message => { messages.push({ options, message }); return { messageId: `message-${messages.length}`, rejected: [] }; }, close() {}
  }) });
  const records = Array.from({ length: 26 }, (_, index) => ({ id: String(index), name: `book-${index}.epub`, ext: '.epub', size: 10, path: `/tmp/book-${index}.epub` }));
  const result = await service.send(records, config, 'secret');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'submitted');
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(item => item.message.attachments.length), [25, 1]);
  assert.match(result.receipt.statement, /not independently confirmed/i);
  assert.equal(result.receipt.destination.includes('reader'), false);
  assert.equal(messages[0].options.requireTLS, true);
});

test('recipient rejection is not reported as submitted', async () => {
  const service = new MailService({ transportFactory: () => ({ sendMail: async () => ({ messageId: 'x', rejected: ['reader@kindle.com'] }), close() {} }) });
  const result = await service.send([{ id: '1', name: 'book.epub', ext: '.epub', size: 10, path: '/tmp/book.epub' }], config, 'secret');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'smtp_recipient_rejected');
});

test('an interrupted transfer records what was actually accepted', async () => {
  let attempts = 0;
  const service = new MailService({ transportFactory: () => ({
    sendMail: async () => {
      attempts += 1;
      if (attempts === 2) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      return { messageId: `message-${attempts}`, rejected: [] };
    },
    close() {}
  }) });
  const records = Array.from({ length: 26 }, (_, index) => ({ id: String(index), name: `book-${index}.epub`, ext: '.epub', size: 10, path: `/tmp/book-${index}.epub` }));

  const result = await service.send(records, config, 'secret');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'smtp_submit_failed');

  // The first batch of 25 really did reach the mail server; history must say so.
  assert.ok(result.receipt, 'a partially completed transfer must still produce a receipt');
  assert.equal(result.receipt.status, 'partial');
  assert.equal(result.receipt.files.length, 25);
  assert.equal(result.receipt.files[0].name, 'book-0.epub');
  assert.match(result.receipt.statement, /the rest were not submitted/i);
  assert.equal(result.receipt.destination.includes('reader'), false);
  assert.equal(result.receipt.smtpHost, 'smtp.example.com');
});

test('a transfer that never reached the server produces no receipt', async () => {
  const service = new MailService({ transportFactory: () => ({
    sendMail: async () => { throw new Error('unreachable'); }, close() {}
  }) });
  const result = await service.send([{ id: '1', name: 'book.epub', ext: '.epub', size: 10, path: '/tmp/book.epub' }], config, 'secret');
  assert.equal(result.ok, false);
  assert.equal(result.receipt ?? null, null, 'nothing was accepted, so nothing may be claimed');
});
