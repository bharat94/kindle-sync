# Contributing to KindleSync

Thanks for helping make personal-document delivery simpler and more trustworthy. Bug reports, focused feature proposals, documentation improvements, and tested pull requests are welcome.

## Before you start

- Use macOS 12 or newer and Node.js 24.
- Search existing issues before opening a new one.
- Report vulnerabilities privately using [SECURITY.md](SECURITY.md); do not open a public security issue.
- Never commit real Kindle addresses, OAuth tokens, app passwords, private keys, certificates, ebooks, or local config files.

## Development setup

```bash
git clone https://github.com/bharat94/kindle-sync.git
cd kindle-sync
npm ci
npm start
```

Google sign-in needs the contributor's own Desktop OAuth client ID:

```bash
KINDLESYNC_GOOGLE_CLIENT_ID="your-id.apps.googleusercontent.com" npm start
```

Do not add a client secret. Installed-app OAuth clients use PKCE and the public client ID only.

## Before opening a pull request

Run the same source gates as CI:

```bash
npm run check
npm run test:all
npm audit --audit-level=low
```

If the change affects packaging, security boundaries, application startup, or bundled files, also run:

```bash
npm run build
npm run verify:package
```

A first encrypted-settings write may cause macOS to ask whether KindleSync may access Keychain-protected information. The local package verifier avoids that write; CI tests it on a disposable runner.

## Pull request guidance

- Keep changes narrow and explain the user-visible outcome.
- Add or update tests for behavior changes.
- Preserve the renderer sandbox, context isolation, IPC validation, ASAR allowlist, and production test-hook rejection.
- Do not call provider acceptance “delivered.” Wireless delivery can prove submission only.
- Do not report raw EPUB copied over USB as success; convert it or offer Wireless.
- Include screenshots for visible UI changes, using invented data only.
- Call out any test that requires external credentials or physical Kindle hardware instead of implying automation covered it.

CI runs Electron on a macOS runner and then builds, inspects, launches, and attests the universal macOS artifacts. A pull request is ready for review when those checks pass and the limitations above remain honest.
