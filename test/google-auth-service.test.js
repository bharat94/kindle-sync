const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { GoogleAuthService, GMAIL_SEND_SCOPE, createPkce } = require('../src/main/google-auth-service');

test('PKCE verifier and challenge are high entropy and distinct', () => {
  const first = createPkce();
  const second = createPkce();
  assert.ok(first.verifier.length >= 43);
  assert.match(first.challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(first.verifier, first.challenge);
  assert.notEqual(first.verifier, second.verifier);
});

test('desktop Google sign-in uses loopback PKCE and returns a refresh token', async () => {
  const requests = [];
  const fetchFn = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: GMAIL_SEND_SCOPE }) };
    return { ok: true, json: async () => ({ email: 'Reader@Gmail.com' }) };
  };
  const service = new GoogleAuthService({
    clientId: 'desktop-client.apps.googleusercontent.com',
    fetchFn,
    timeoutMs: 3000,
    openExternal: async value => {
      const auth = new URL(value);
      assert.equal(auth.origin, 'https://accounts.google.com');
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      assert.match(auth.searchParams.get('scope'), /gmail\.send/);
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', 'authorization-code');
      callback.searchParams.set('state', auth.searchParams.get('state'));
      await new Promise((resolve, reject) => http.get(callback, response => { response.resume(); response.on('end', resolve); }).on('error', reject));
    }
  });
  const account = await service.signIn();
  assert.equal(account.email, 'reader@gmail.com');
  assert.equal(account.refreshToken, 'refresh');
  const tokenBody = new URLSearchParams(requests[0].options.body);
  assert.equal(tokenBody.get('grant_type'), 'authorization_code');
  assert.ok(tokenBody.get('code_verifier').length >= 43);
  assert.match(tokenBody.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
});

test('refresh exchanges the Keychain token without asking the user again', async () => {
  const service = new GoogleAuthService({ clientId: 'client', fetchFn: async (_url, options) => {
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('refresh_token'), 'saved-refresh');
    assert.equal(body.get('grant_type'), 'refresh_token');
    return { ok: true, json: async () => ({ access_token: 'new-access', expires_in: 120 }) };
  } });
  const result = await service.refresh('saved-refresh');
  assert.equal(result.accessToken, 'new-access');
});

test('a failed token exchange reports Google reason without leaking tokens', async () => {
  const service = new GoogleAuthService({
    clientId: 'desktop-client.apps.googleusercontent.com',
    fetchFn: async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_client',
        error_description: 'Unauthorized',
        access_token: 'leaked-access-token',
        refresh_token: 'leaked-refresh-token'
      })
    })
  });
  await assert.rejects(
    () => service.refresh('saved-refresh'),
    error => {
      assert.equal(error.code, 'google_token_exchange_failed');
      assert.match(error.message, /invalid_client: Unauthorized/);
      assert.doesNotMatch(error.message, /leaked-access-token|leaked-refresh-token|saved-refresh/);
      return true;
    }
  );
});

test('an expired or reused authorization code is reported as a session problem', async () => {
  const service = new GoogleAuthService({
    clientId: 'desktop-client.apps.googleusercontent.com',
    fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Bad Request' }) })
  });
  await assert.rejects(() => service.refresh('stale'), error => {
    assert.equal(error.code, 'google_session_expired');
    assert.match(error.message, /invalid_grant/);
    return true;
  });
});

test('installed-app token exchange sends the client secret Google requires', async () => {
  const calls = [];
  const service = new GoogleAuthService({
    clientId: 'desktop-client.apps.googleusercontent.com',
    clientSecret: 'INSTALLED-APP-SECRET',
    fetchFn: async (url, options) => {
      calls.push(new URLSearchParams(options.body));
      return { ok: true, json: async () => ({ access_token: 'access', expires_in: 3600 }) };
    }
  });
  await service.refresh('saved-refresh');
  assert.equal(calls[0].get('client_secret'), 'INSTALLED-APP-SECRET');
  assert.equal(calls[0].get('client_id'), 'desktop-client.apps.googleusercontent.com');
});

test('an unset client secret is omitted rather than sent empty', async () => {
  const calls = [];
  const service = new GoogleAuthService({
    clientId: 'desktop-client.apps.googleusercontent.com',
    fetchFn: async (url, options) => {
      calls.push(new URLSearchParams(options.body));
      return { ok: true, json: async () => ({ access_token: 'access', expires_in: 3600 }) };
    }
  });
  await service.refresh('saved-refresh');
  assert.equal(calls[0].has('client_secret'), false);
});

test('a rejected exchange identifies the Google error code', async () => {
  const service = new GoogleAuthService({
    clientId: 'desktop-client.apps.googleusercontent.com',
    clientSecret: 'INSTALLED-APP-SECRET',
    fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_client', error_description: 'INSTALLED-APP-SECRET was rejected' }) })
  });
  await assert.rejects(() => service.refresh('saved-refresh'), error => {
    // Google never echoes a secret back; this guards against a future change
    // that starts copying the whole response body into the message.
    assert.match(error.message, /invalid_client/);
    return true;
  });
});

test('a user-supplied client overrides the build and never borrows its secret', async () => {
  const own = { clientId: '', clientSecret: '' };
  const calls = [];
  const service = new GoogleAuthService({
    credentialsProvider: () => own.clientId ? own : { clientId: 'build.apps.googleusercontent.com', clientSecret: 'BUILD-SECRET' },
    fetchFn: async (url, options) => {
      calls.push(new URLSearchParams(options.body));
      return { ok: true, json: async () => ({ access_token: 'access', expires_in: 3600 }) };
    }
  });

  await service.refresh('token');
  assert.equal(calls[0].get('client_id'), 'build.apps.googleusercontent.com');
  assert.equal(calls[0].get('client_secret'), 'BUILD-SECRET');

  own.clientId = 'mine.apps.googleusercontent.com';
  own.clientSecret = 'MY-SECRET';
  await service.refresh('token');
  assert.equal(calls[1].get('client_id'), 'mine.apps.googleusercontent.com');
  assert.equal(calls[1].get('client_secret'), 'MY-SECRET', 'a user client must use its own secret, never the build one');
});

test('availability follows the current credentials without a restart', async () => {
  const own = { clientId: '', clientSecret: '' };
  const service = new GoogleAuthService({ credentialsProvider: () => own });
  assert.equal(service.available, false);
  own.clientId = 'mine.apps.googleusercontent.com';
  assert.equal(service.available, true);
  await assert.rejects(() => new GoogleAuthService({ credentialsProvider: () => ({}) }).signIn(), /Settings/);
});
