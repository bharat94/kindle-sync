const http = require('node:http');
const crypto = require('node:crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function createPkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function resolveGoogleClientId(packageConfig = {}, { allowEnvironment = true } = {}) {
  const environmentId = allowEnvironment ? process.env.KINDLESYNC_GOOGLE_CLIENT_ID : '';
  return (environmentId || packageConfig?.kindleSync?.googleOAuthClientId || '').trim();
}

// Google's installed-app flow requires client_secret at the token endpoint even
// with PKCE. RFC 8252 section 8.5 and Google's own desktop documentation treat
// this value as a non-confidential app identifier, not a real secret: it cannot
// be kept private in a distributed binary, and PKCE is what actually binds the
// authorization code to this client. It is still resolved like the client ID so
// it never has to be committed.
function resolveGoogleClientSecret(packageConfig = {}, { allowEnvironment = true } = {}) {
  const environmentSecret = allowEnvironment ? process.env.KINDLESYNC_GOOGLE_CLIENT_SECRET : '';
  return (environmentSecret || packageConfig?.kindleSync?.googleOAuthClientSecret || '').trim();
}

class GoogleAuthService {
  constructor({ clientId, clientSecret, credentialsProvider, openExternal, fetchFn = global.fetch, timeoutMs = 180_000, networkTimeoutMs = 20_000 } = {}) {
    // A provider rather than fixed fields, so a client the user pastes into
    // Settings takes effect immediately instead of at the next launch.
    this.credentialsProvider = credentialsProvider || (() => ({ clientId, clientSecret }));
    this.openExternal = openExternal;
    this.fetch = fetchFn;
    this.timeoutMs = timeoutMs;
    this.networkTimeoutMs = networkTimeoutMs;
  }

  get credentials() {
    let resolved = {};
    try { resolved = this.credentialsProvider() || {}; } catch { resolved = {}; }
    const text = value => typeof value === 'string' ? value.trim() : '';
    return { clientId: text(resolved.clientId), clientSecret: text(resolved.clientSecret) };
  }

  get available() {
    return Boolean(this.credentials.clientId);
  }

  async signIn() {
    const { clientId } = this.credentials;
    if (!clientId) throw Object.assign(new Error('Google sign-in has not been configured. Add a Google client in Settings.'), { code: 'google_oauth_not_configured' });
    const { verifier, challenge } = createPkce();
    const state = base64url(crypto.randomBytes(32));
    const callback = await this.createCallbackServer(state);
    this.pendingSignIn = callback;
    const redirectUri = `http://127.0.0.1:${callback.port}/oauth/callback`;
    const authUrl = new URL(AUTH_URL);
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: `openid email ${GMAIL_SEND_SCOPE}`,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state
    }).toString();

    try {
      await this.openExternal(authUrl.toString());
      const code = await callback.result;
      const tokens = await this.tokenRequest({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      });
      if (!tokens.refresh_token) throw Object.assign(new Error('Google did not return an offline refresh token. Remove KindleSync from your Google account and try again.'), { code: 'google_refresh_token_missing' });
      const granted = new Set(String(tokens.scope || '').split(/\s+/));
      if (tokens.scope && !granted.has(GMAIL_SEND_SCOPE)) throw Object.assign(new Error('The Gmail send permission was not granted. Sign in again and tick “Send email on your behalf” on the Google consent screen.'), { code: 'google_scope_missing' });
      const userResponse = await this.fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(this.networkTimeoutMs) });
      if (!userResponse.ok) throw Object.assign(new Error('Google account details could not be read.'), { code: 'google_userinfo_failed' });
      const user = await userResponse.json();
      if (!/^\S+@\S+\.\S+$/.test(user.email || '')) throw Object.assign(new Error('Google did not return an email address.'), { code: 'google_email_missing' });
      return {
        email: user.email.toLowerCase(),
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        scope: tokens.scope || GMAIL_SEND_SCOPE
      };
    } finally {
      this.pendingSignIn = null;
      callback.close();
    }
  }

  // Google can refuse before ever redirecting to the loopback callback, which
  // otherwise leaves sign-in pending for the full timeout with nothing to click.
  cancelSignIn() {
    if (!this.pendingSignIn) return false;
    this.pendingSignIn.cancel();
    return true;
  }

  async refresh(refreshToken) {
    if (!this.available || !refreshToken) throw Object.assign(new Error('Google account connection is incomplete.'), { code: 'google_account_missing' });
    const tokens = await this.tokenRequest({ client_id: this.credentials.clientId, refresh_token: refreshToken, grant_type: 'refresh_token' });
    return { accessToken: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 };
  }

  async revoke(token) {
    if (!token) return true;
    try {
      const response = await this.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(this.networkTimeoutMs) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async tokenRequest(fields) {
    const payload = { ...fields };
    const { clientSecret } = this.credentials;
    if (clientSecret) payload.client_secret = clientSecret;
    const response = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload).toString(),
      signal: AbortSignal.timeout(this.networkTimeoutMs)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      const code = body.error === 'invalid_grant' ? 'google_session_expired' : 'google_token_exchange_failed';
      // Surface only Google's own error identifiers. Never echo the response
      // body, which can carry tokens on a partial success.
      const detail = [body.error, body.error_description].filter(part => typeof part === 'string' && part).join(': ').slice(0, 200);
      throw Object.assign(new Error(detail ? `Google sign-in could not be completed (${detail}).` : 'Google sign-in could not be completed.'), { code });
    }
    return body;
  }

  createCallbackServer(expectedState) {
    let server;
    let timer;
    let settle;
    const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/oauth/callback') { response.writeHead(404).end('Not found'); return; }
      const ok = url.searchParams.get('state') === expectedState;
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      response.writeHead(ok && code && !error ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(ok && code && !error
        ? '<!doctype html><meta charset="utf-8"><title>KindleSync connected</title><p>Google connected. You can close this tab and return to KindleSync.</p>'
        : '<!doctype html><meta charset="utf-8"><title>KindleSync sign-in failed</title><p>Sign-in was cancelled or could not be verified. Return to KindleSync and try again.</p>');
      if (!ok) settle.reject(Object.assign(new Error('Google sign-in response could not be verified.'), { code: 'google_state_mismatch' }));
      else if (error || !code) settle.reject(Object.assign(new Error('Google sign-in was cancelled.'), { code: 'google_sign_in_cancelled' }));
      else settle.resolve(code);
      clearTimeout(timer);
      server.close();
    });
    server.listen(0, '127.0.0.1');
    timer = setTimeout(() => {
      settle.reject(Object.assign(new Error('Google sign-in timed out.'), { code: 'google_sign_in_timeout' }));
      server.close();
    }, this.timeoutMs);
    timer.unref?.();
    return new Promise((resolve, reject) => {
      const shutdown = () => { clearTimeout(timer); if (server.listening) server.close(); };
      server.once('listening', () => resolve({
        port: server.address().port,
        result,
        close: shutdown,
        cancel: () => {
          settle.reject(Object.assign(new Error('Google sign-in was cancelled.'), { code: 'google_sign_in_cancelled' }));
          shutdown();
        }
      }));
      server.once('error', reject);
    });
  }
}

module.exports = { GoogleAuthService, GMAIL_SEND_SCOPE, createPkce, resolveGoogleClientId, resolveGoogleClientSecret };
