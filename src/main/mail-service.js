const nodemailer = require('nodemailer');
const { createEmailBatches, maskEmail, submittedRecords } = require('./delivery-policy');

class MailService {
  constructor({ transportFactory = nodemailer.createTransport } = {}) {
    this.transportFactory = transportFactory;
  }

  createTransport(config, password) {
    return this.transportFactory({
      host: config.smtpHost,
      port: Number(config.smtpPort),
      secure: Boolean(config.smtpSecure) || Number(config.smtpPort) === 465,
      requireTLS: Number(config.smtpPort) !== 465,
      auth: { user: config.smtpUser, pass: password },
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 120_000,
      disableFileAccess: false,
      disableUrlAccess: true
    });
  }

  async test(config, password) {
    const transport = this.createTransport(config, password);
    try {
      await transport.verify();
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'smtp_connection_failed', message: this.safeError(error) };
    } finally {
      transport.close?.();
    }
  }

  async send(records, config, password) {
    const policy = createEmailBatches(records, config);
    if (!policy.ok) return { ok: false, code: 'email_preflight_failed', issues: policy.issues };

    const submitted = [];
    for (let index = 0; index < policy.batches.length; index += 1) {
      const batch = policy.batches[index];
      const transport = this.createTransport(config, password);
      try {
        const info = await transport.sendMail({
          from: config.senderEmail,
          to: config.kindleEmail,
          subject: policy.batches.length > 1 ? `KindleSync ${index + 1}/${policy.batches.length}` : 'KindleSync',
          text: 'Personal documents submitted by KindleSync.',
          attachments: batch.map(record => ({ filename: record.name, path: record.path }))
        });
        if (Array.isArray(info.rejected) && info.rejected.length) {
          return { ok: false, code: 'smtp_recipient_rejected', submitted, message: 'The mail server rejected the Kindle recipient.', receipt: this.partialReceipt(records, config, submitted) };
        }
        submitted.push({ messageId: info.messageId || '', count: batch.length, ids: batch.map(record => record.id) });
      } catch (error) {
        return { ok: false, code: 'smtp_submit_failed', submitted, message: this.safeError(error), receipt: this.partialReceipt(records, config, submitted) };
      } finally {
        transport.close?.();
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
        smtpHost: config.smtpHost,
        messageIds: submitted.map(item => item.messageId),
        statement: 'Accepted by your mail server; Kindle delivery not independently confirmed.'
      }
    };
  }

  // USB already records a partial receipt; email silently recorded nothing, so
  // books that really were accepted left no trace in history.
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
      smtpHost: config.smtpHost,
      messageIds: submitted.map(item => item.messageId),
      statement: 'Some books were accepted by your mail server before the transfer stopped; the rest were not submitted.'
    };
  }

  safeError(error) {
    const code = error?.code ? ` (${error.code})` : '';
    return `Mail provider connection failed${code}. Check the provider, app password, port, and TLS settings.`;
  }
}

module.exports = { MailService };
