const path = require('node:path');

const MB = 1024 * 1024;
const AMAZON_EMAIL_MAX_FILES = 25;
const AMAZON_EMAIL_MAX_BYTES = 50 * MB;

const EMAIL_EXTENSIONS = new Set([
  '.pdf', '.epub', '.doc', '.docx', '.txt', '.rtf', '.htm', '.html',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.zip'
]);
const USB_DIRECT_EXTENSIONS = new Set(['.pdf', '.txt', '.azw', '.azw3', '.mobi', '.kfx']);

const PROVIDERS = Object.freeze({
  gmail: { label: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false, maxBytes: 24 * MB },
  icloud: { label: 'iCloud Mail', host: 'smtp.mail.me.com', port: 587, secure: false, maxBytes: 19 * MB },
  outlook: { label: 'Outlook', host: 'smtp-mail.outlook.com', port: 587, secure: false, maxBytes: 24 * MB },
  custom: { label: 'Custom SMTP', host: '', port: 587, secure: false, maxBytes: AMAZON_EMAIL_MAX_BYTES }
});

function getProvider(config = {}) {
  const base = PROVIDERS[config.smtpProvider] || PROVIDERS.custom;
  const requestedMb = Number(config.smtpMaxMb);
  const requestedBytes = Number.isFinite(requestedMb) ? requestedMb * MB : base.maxBytes;
  return { ...base, maxBytes: Math.min(AMAZON_EMAIL_MAX_BYTES, Math.max(MB, requestedBytes)) };
}

function validateEmailConfig(config = {}, { requireSecret = true } = {}) {
  const issues = [];
  if (!/^\S+@(?:kindle\.com|free\.kindle\.com)$/i.test(config.kindleEmail || '')) issues.push('kindle_email');
  if (!/^\S+@\S+\.\S+$/.test(config.senderEmail || '')) issues.push('sender_email');
  if (!config.approvedSenderConfirmed) issues.push('approved_sender');
  if (config.smtpProvider === 'gmail') {
    if (!config.hasGoogleAccount || !/^\S+@\S+\.\S+$/.test(config.googleEmail || '')) issues.push('google_account');
    if (config.senderEmail !== config.googleEmail) issues.push('google_sender_mismatch');
  } else {
    if (!config.smtpHost || !Number(config.smtpPort) || !config.smtpUser) issues.push('smtp_config');
    if (requireSecret && !config.hasSmtpPassword) issues.push('smtp_password');
  }
  return issues;
}

function createEmailBatches(records, config = {}) {
  const provider = getProvider(config);
  const issues = [];
  const valid = [];

  for (const record of records) {
    if (!EMAIL_EXTENSIONS.has(record.ext)) {
      issues.push({ code: 'unsupported_email_format', id: record.id, name: record.name });
    } else if (record.size > Math.min(provider.maxBytes, AMAZON_EMAIL_MAX_BYTES)) {
      issues.push({ code: 'email_file_too_large', id: record.id, name: record.name, maxBytes: provider.maxBytes });
    } else {
      valid.push(record);
    }
  }

  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const record of valid) {
    if (batch.length === AMAZON_EMAIL_MAX_FILES || bytes + record.size > provider.maxBytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(record);
    bytes += record.size;
  }
  if (batch.length) batches.push(batch);

  return { ok: issues.length === 0, issues, batches, provider, totalBytes: valid.reduce((sum, r) => sum + r.size, 0) };
}

function validateUsbRecords(records, { hasCalibre = false } = {}) {
  const issues = [];
  for (const record of records) {
    if (record.ext === '.epub' && !hasCalibre) {
      issues.push({ code: 'epub_requires_calibre', id: record.id, name: record.name });
    } else if (record.ext !== '.epub' && !USB_DIRECT_EXTENSIONS.has(record.ext)) {
      issues.push({ code: 'unsupported_usb_format', id: record.id, name: record.name });
    }
  }
  return { ok: issues.length === 0, issues };
}

function maskEmail(value = '') {
  const [local, domain] = value.split('@');
  if (!domain) return '';
  return `${local.slice(0, 1) || '*'}${'*'.repeat(Math.max(3, local.length - 1))}@${domain}`;
}

function extensionOf(filePath) {
  return path.extname(filePath).toLowerCase();
}

module.exports = {
  MB,
  AMAZON_EMAIL_MAX_FILES,
  AMAZON_EMAIL_MAX_BYTES,
  EMAIL_EXTENSIONS,
  USB_DIRECT_EXTENSIONS,
  PROVIDERS,
  getProvider,
  validateEmailConfig,
  createEmailBatches,
  validateUsbRecords,
  maskEmail,
  extensionOf
};
