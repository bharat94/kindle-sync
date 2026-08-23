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

class GoogleAuthService {
  constructor({ clientId, openExternal, fetchFn = global.fetch, timeoutMs = 180_000, networkTimeoutMs = 20_000 } = {}) {
    this.clientId = clientId || '';
    this.openExternal = openExternal;
    this.fetch = fetchFn;
    this.timeoutMs = timeoutMs;
    this.networkTimeoutMs = networkTimeoutMs;
  }

  get available() {
    return Boolean(this.clientId);
  }

  async signIn() {
    if (!this.available) throw Object.assign(new Error('Google sign-in has not been configured for this build.'), { code: 'google_oauth_not_configured' });
    const { verifier, challenge } = createPkce();
    const state = base64url(crypto.randomBytes(32));
    const callback = await this.createCallbackServer(state);
    const redirectUri = `http://127.0.0.1:${callback.port}/oauth/callback`;
    const authUrl = new URL(AUTH_URL);
    authUrl.search = new URLSearchParams({
      client_id: this.clientId,
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
        client_id: this.clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      });
      if (!tokens.refresh_token) throw Object.assign(new Error('Google did not return an offline refresh token. Remove KindleSync from your Google account and try again.'), { code: 'google_refresh_token_missing' });
      const granted = new Set(String(tokens.scope || '').split(/\s+/));
      if (tokens.scope && !granted.has(GMAIL_SEND_SCOPE)) throw Object.assign(new Error('The Gmail send permission was not granted.'), { code: 'google_scope_missing' });
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
      callback.close();
    }
  }

  async refresh(refreshToken) {
    if (!this.available || !refreshToken) throw Object.assign(new Error('Google account connection is incomplete.'), { code: 'google_account_missing' });
    const tokens = await this.tokenRequest({ client_id: this.clientId, refresh_token: refreshToken, grant_type: 'refresh_token' });
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
    const response = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(this.networkTimeoutMs)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      const code = body.error === 'invalid_grant' ? 'google_session_expired' : 'google_token_exchange_failed';
      throw Object.assign(new Error('Google sign-in could not be completed.'), { code });
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
      server.once('listening', () => resolve({ port: server.address().port, result, close: () => { clearTimeout(timer); if (server.listening) server.close(); } }));
      server.once('error', reject);
    });
  }
}

module.exports = { GoogleAuthService, GMAIL_SEND_SCOPE, createPkce, resolveGoogleClientId };
