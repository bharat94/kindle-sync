const nodemailer = require('nodemailer');
const { createEmailBatches, maskEmail, submittedRecords } = require('./delivery-policy');

function toBase64url(value) {
  return Buffer.from(value).toString('base64url');
}

class GmailService {
  constructor({ fetchFn = global.fetch, transportFactory = nodemailer.createTransport, networkTimeoutMs = 120_000 } = {}) {
    this.fetch = fetchFn;
    this.transportFactory = transportFactory;
    this.networkTimeoutMs = networkTimeoutMs;
  }

  async compose(batch, config, index, total) {
    const transport = this.transportFactory({ streamTransport: true, buffer: true, newline: 'unix' });
    try {
      const info = await transport.sendMail({
        from: config.googleEmail || config.senderEmail,
        to: config.kindleEmail,
        subject: total > 1 ? `KindleSync ${index + 1}/${total}` : 'KindleSync',
        text: 'Personal documents submitted by KindleSync.',
        attachments: batch.map(record => ({ filename: record.name, path: record.path }))
      });
      return info.message;
    } finally {
      transport.close?.();
    }
  }

  partialReceipt(records, config, submitted) {
    const sent = submittedRecords(records, submitted);
    if (!sent.length) return null;
    return {
      id: `email-${Date.now()}`,
      method: 'email',
      status: 'partial',
      createdAt: new Date().toISOString(),
      files: sent.map(({ name, size }) => ({ name, size })),
      destination: maskEmail(config.kindleEmail),
      provider: 'Gmail',
      messageIds: submitted.map(item => item.messageId),
      statement: 'Some books were sent by Gmail before the transfer stopped; the rest were not submitted.'
    };
  }

  async send(records, config, accessToken) {
    const policy = createEmailBatches(records, config);
    if (!policy.ok) return { ok: false, code: 'email_preflight_failed', issues: policy.issues };
    const submitted = [];
    for (let index = 0; index < policy.batches.length; index += 1) {
      const batch = policy.batches[index];
      try {
        const mime = await this.compose(batch, config, index, policy.batches.length);
        const response = await this.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: toBase64url(mime) }),
          signal: AbortSignal.timeout(this.networkTimeoutMs)
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.id) {
          const code = response.status === 401 ? 'google_session_expired' : 'gmail_submit_failed';
          return { ok: false, code, submitted, message: 'Gmail could not submit this batch. Reconnect Google and try again.', receipt: this.partialReceipt(records, config, submitted) };
        }
        submitted.push({ messageId: body.id, count: batch.length, ids: batch.map(record => record.id) });
      } catch {
        return { ok: false, code: 'gmail_submit_failed', submitted, message: 'Gmail could not submit this batch. Check your connection and try again.', receipt: this.partialReceipt(records, config, submitted) };
      }
    }
    return {
      ok: true,
      status: 'submitted',
      receipt: {
        id: `email-${Date.now()}`,
        method: 'email',
        status: 'submitted',
        createdAt: new Date().toISOString(),
        files: records.map(({ name, size }) => ({ name, size })),
        destination: maskEmail(config.kindleEmail),
        provider: 'Gmail',
        messageIds: submitted.map(item => item.messageId),
        statement: 'Sent by Gmail; Kindle delivery not independently confirmed.'
      }
    };
  }
}

module.exports = { GmailService, toBase64url };
