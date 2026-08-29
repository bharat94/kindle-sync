const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CURRENT_SCHEMA_VERSION = 3;
const DEFAULTS = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  deliveryMode: 'email',
  kindleEmail: '',
  senderEmail: '',
  approvedSenderConfirmed: false,
  smtpProvider: 'gmail',
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpMaxMb: 24,
  smtpCredentialBinding: '',
  smtpPass: '',
  googleEmail: '',
  googleRefreshToken: '',
  googleClientId: '',
  googleClientSecret: '',
  usbDocumentsPath: '',
  history: []
});

function smtpBinding(config = {}) {
  const identity = [
    config.smtpProvider || '',
    String(config.smtpHost || '').trim().toLowerCase(),
    String(Number(config.smtpPort) || ''),
    config.smtpSecure ? 'tls' : 'starttls',
    String(config.smtpUser || '').trim().toLowerCase()
  ].join('\0');
  return crypto.createHash('sha256').update(identity).digest('base64url');
}

class ConfigStore {
  constructor({ filePath, cryptoProvider }) {
    this.filePath = filePath;
    this.crypto = cryptoProvider;
    this.data = { ...DEFAULTS };
  }

  async init() {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }

    if (parsed?.schemaVersion === CURRENT_SCHEMA_VERSION && typeof parsed.protectedDataCiphertext === 'string') {
      const decrypted = await this.decrypt(parsed.protectedDataCiphertext);
      const protectedData = JSON.parse(decrypted.result);
      this.data = { ...DEFAULTS, ...protectedData, schemaVersion: CURRENT_SCHEMA_VERSION };
      if (decrypted.shouldReEncrypt) await this.write();
      return;
    }

    // Migrate v1/v2 files that stored personal metadata in plaintext and only
    // encrypted credentials. The next atomic write contains ciphertext only.
    this.data = { ...DEFAULTS, ...(parsed || {}), schemaVersion: CURRENT_SCHEMA_VERSION };
    if (parsed?.smtpPassCiphertext) this.data.smtpPass = (await this.decrypt(parsed.smtpPassCiphertext)).result;
    if (parsed?.googleRefreshTokenCiphertext) this.data.googleRefreshToken = (await this.decrypt(parsed.googleRefreshTokenCiphertext)).result;
    if (this.data.smtpPass) this.data.smtpCredentialBinding = smtpBinding(this.data);
    delete this.data.smtpPassCiphertext;
    delete this.data.googleRefreshTokenCiphertext;
    await this.write();
  }

  publicConfig() {
    const { smtpPass, googleRefreshToken, smtpCredentialBinding, usbDocumentsPath, googleClientSecret, ...safe } = this.data;
    return {
      ...safe,
      hasSmtpPassword: Boolean(smtpPass && smtpCredentialBinding === smtpBinding(this.data)),
      hasGoogleAccount: Boolean(googleRefreshToken && this.data.googleEmail),
      hasGoogleClientSecret: Boolean(googleClientSecret)
    };
  }

  internalConfig() {
    const { smtpPass, googleRefreshToken, smtpCredentialBinding, googleClientSecret, ...safe } = this.data;
    return {
      ...safe,
      hasSmtpPassword: Boolean(smtpPass && smtpCredentialBinding === smtpBinding(this.data)),
      hasGoogleAccount: Boolean(googleRefreshToken && this.data.googleEmail),
      hasGoogleClientSecret: Boolean(googleClientSecret)
    };
  }

  // Synchronous because GoogleAuthService.available is a getter consulted during
  // render. The values live in the already-decrypted in-memory config.
  googleClient() {
    return { clientId: this.data.googleClientId || '', clientSecret: this.data.googleClientSecret || '' };
  }

  async save(patch = {}) {
    const allowed = [
      'deliveryMode', 'kindleEmail', 'senderEmail', 'approvedSenderConfirmed',
      'smtpProvider', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser',
      'smtpMaxMb', 'usbDocumentsPath', 'googleEmail', 'googleClientId'
    ];
    for (const key of allowed) {
      if (Object.hasOwn(patch, key)) this.data[key] = patch[key];
    }
    if (typeof patch.googleClientSecret === 'string' && patch.googleClientSecret) {
      this.data.googleClientSecret = patch.googleClientSecret;
    }
    if (typeof patch.smtpPass === 'string' && patch.smtpPass) {
      this.setSecret(patch.smtpPass);
    } else if (this.data.smtpPass && this.data.smtpCredentialBinding !== smtpBinding(this.data)) {
      this.data.smtpPass = '';
      this.data.smtpCredentialBinding = '';
    }
    await this.write();
    return this.publicConfig();
  }

  setSecret(secret) {
    this.data.smtpPass = secret;
    this.data.smtpCredentialBinding = smtpBinding(this.data);
  }

  setGoogleRefreshToken(secret) {
    this.data.googleRefreshToken = secret;
  }

  async getSecret() {
    return this.data.smtpCredentialBinding === smtpBinding(this.data) ? this.data.smtpPass : '';
  }

  async getGoogleRefreshToken() {
    return this.data.googleRefreshToken || '';
  }

  async decrypt(ciphertext) {
    if (!ciphertext) return { result: '', shouldReEncrypt: false };
    const encrypted = Buffer.from(ciphertext, 'base64');
    let decrypted = await this.crypto.decryptStringAsync(encrypted);
    const shouldReEncrypt = Boolean(decrypted.shouldReEncrypt);
    if (shouldReEncrypt) decrypted = await this.crypto.decryptStringAsync(encrypted);
    return { result: decrypted.result, shouldReEncrypt };
  }

  async clearSecret() {
    this.data.smtpPass = '';
    this.data.smtpCredentialBinding = '';
    await this.write();
  }

  // Clearing the app registration is separate from disconnecting the account:
  // signing out must not discard a client the user pasted in.
  async clearGoogleClient() {
    this.data.googleClientId = '';
    this.data.googleClientSecret = '';
    await this.write();
  }

  async clearGoogleAccount() {
    this.data.googleRefreshToken = '';
    this.data.googleEmail = '';
    if (this.data.smtpProvider === 'gmail') this.data.senderEmail = '';
    await this.write();
  }

  async addHistory(receipt) {
    this.data.history = [receipt, ...(this.data.history || [])].slice(0, 50);
    await this.write();
  }

  async clearHistory() {
    this.data.history = [];
    await this.write();
  }

  async reset() {
    this.data = { ...DEFAULTS };
    await fs.rm(this.filePath, { force: true });
  }

  async write() {
    const available = await this.crypto.isAsyncEncryptionAvailable();
    if (!available) throw Object.assign(new Error('Secure storage is unavailable; KindleSync will not persist private data.'), { code: 'secure_storage_unavailable' });
    const encrypted = await this.crypto.encryptStringAsync(JSON.stringify(this.data));
    const envelope = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      protectedDataCiphertext: Buffer.from(encrypted).toString('base64')
    };
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temp = `${this.filePath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = { ConfigStore, DEFAULTS, CURRENT_SCHEMA_VERSION, smtpBinding };
