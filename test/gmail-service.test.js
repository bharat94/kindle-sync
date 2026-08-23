const test = require('node:test');
const assert = require('node:assert/strict');
const { GmailService } = require('../src/main/gmail-service');

test('Gmail API sends serial MIME batches with a send-only bearer token', async () => {
  const calls = [];
  const service = new GmailService({
    transportFactory: () => ({ sendMail: async message => ({ message: Buffer.from(`mime:${message.attachments.length}:${message.from}:${message.to}`) }), close() {} }),
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ id: `gmail-${calls.length}` }) };
    }
  });
  const records = Array.from({ length: 26 }, (_, index) => ({ id: String(index), name: `book-${index}.epub`, ext: '.epub', size: 10, path: `/tmp/book-${index}.epub` }));
  const config = { smtpProvider: 'gmail', smtpMaxMb: 24, googleEmail: 'me@gmail.com', senderEmail: 'me@gmail.com', kindleEmail: 'reader@kindle.com' };
  const result = await service.send(records, config, 'access-token');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer access-token');
  assert.equal(Buffer.from(JSON.parse(calls[0].options.body).raw, 'base64url').toString(), 'mime:25:me@gmail.com:reader@kindle.com');
  assert.match(result.receipt.statement, /not independently confirmed/i);
});
