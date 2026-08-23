# KindleSync

KindleSync is a local macOS Electron app for one job: drop books, then send them to a Kindle. It runs as a normal `.app`; there is no hosted account, persistent localhost server, analytics, or background daemon. Google sign-in briefly opens a loopback callback on `127.0.0.1`, as required for Google's desktop OAuth flow, and closes it as soon as sign-in finishes.

![Electron](https://img.shields.io/badge/Electron-43-47848f) ![macOS](https://img.shields.io/badge/macOS-12%2B-666) ![tests](https://img.shields.io/badge/tests-35%20passing-28785f)

## What works

### Wireless email

KindleSync submits supported files to your `@kindle.com` address. Gmail users click **Sign in with Google**—there are no SMTP settings or app passwords. iCloud, Outlook, and custom SMTP remain available as advanced providers. Amazon then handles conversion and library delivery.

- EPUB, PDF, DOC/DOCX, TXT, RTF, HTML, JPEG, GIF, PNG, BMP, and ZIP containers.
- Gmail OAuth requests only send-email access; it cannot read or modify your inbox.
- App-password presets for iCloud Mail, Outlook, and custom SMTP.
- Provider-aware batching: Gmail/Outlook use a conservative 24 MB source limit, iCloud 19 MB, and custom SMTP up to Amazon's 50 MB email ceiling.
- Amazon's 25-document-per-email rule is batched automatically.
- The complete app-managed configuration—including addresses, account identifiers, history, Google refresh tokens, and advanced SMTP app passwords—is stored as one encrypted envelope using Electron `safeStorage`, backed by macOS Keychain. Credentials are never returned to the renderer.

A successful result is deliberately called **Submitted**, not Delivered. It proves that Gmail or your outgoing mail server accepted the email; Amazon exposes no documented public success/status API that would let this app verify conversion or arrival. Check the Kindle device/app and your sender inbox for Amazon errors or verification requests.

### Legacy USB mass storage

Older Kindles that mount as a writable volume can receive PDF, TXT, AZW/AZW3, MOBI, and KFX files directly. EPUB is converted to AZW3 when Calibre is installed. KindleSync writes a temporary partial file, compares byte counts, renames it into place, and reports **Copied and verified**—not “indexed.”

Raw EPUB is never copied as a false success. Install [Calibre](https://calibre-ebook.com/download_osx) or use Wireless.

### Modern MTP Kindles

All Kindle Scribes and Kindle models released in 2024 or later use an MTP workflow on macOS. MTP devices do not appear as normal `/Volumes` filesystems, and OpenMTP does not create a Finder/FUSE mount.

KindleSync detects an attached MTP Kindle separately and shows an honest handoff: use Wireless or Amazon's official Send to Kindle USB File Manager. Native MTP upload needs a signed helper and real-device testing and is tracked as v2 work in [PLAN.md](PLAN.md).

Amazon's current macOS USB guidance: <https://digprjsurvey.amazon.com/csad/help/node/TCUBEdEkbIhK07ysFu>

## Run locally

Requirements: macOS 12+, Node.js, and npm.

```bash
npm install
npm start
```

For the usual path:

1. Drop an EPUB or PDF into the window.
2. Click Send. Wireless setup opens only when it is needed.
3. Enter the Kindle address from Amazon's Personal Document Settings.
4. Add the sender address to Amazon's Approved Personal Document Email List and confirm that in KindleSync.
5. Click **Sign in with Google**. The sender address is filled automatically.
6. Save, then submit the queue.

[Amazon approved-sender settings](https://www.amazon.com/hz/mycd/myx#/home/settings/payment)

### Enable Google sign-in in a development build

Google requires the app developer—not each user—to register a Desktop OAuth client. Create a Google Cloud project, enable Gmail API, configure its OAuth consent screen, and create a **Desktop app** client ID. No client secret is used or shipped.

For local development:

```bash
KINDLESYNC_GOOGLE_CLIENT_ID="your-id.apps.googleusercontent.com" npm start
```

For a distributable build, set `kindleSync.googleOAuthClientId` in `package.json` before building. Packaged builds ignore environment-based client-ID and test-hook overrides. Public distribution of the sensitive `gmail.send` scope also requires Google's OAuth verification. With no client ID, KindleSync clearly disables the Google button; iCloud, Outlook, and custom SMTP are still usable.

## Build the Mac app

```bash
npm run build:dir   # universal unpacked .app in dist/mac-universal/
npm run build       # locally ad-hoc-signed universal DMG + ZIP
npm run build:release # Developer ID build; fails closed if signing is unavailable
```

The app is the macOS wrapper—no Automator or shell wrapper is needed. The generated universal binary contains ARM64 and x86_64 slices. Local artifacts use an ad-hoc signature so hardened ASAR integrity can launch during development, but that signature is not a publisher identity and is not accepted by Gatekeeper for distribution. A public release must use `build:release` with a Developer ID certificate and must be notarized.

## Test

```bash
npm test            # 29 unit/integration tests
npm run test:e2e    # 6 Playwright Electron journeys
npm run test:all
npm audit --audit-level=low
```

Coverage includes encrypted v2→v3 migration/restart/erase, packaged test-hook rejection, SMTP credential binding, Google loopback OAuth/PKCE, Gmail API MIME batching, provider limits, opaque file IDs, changed-file identity checks, stale conversion cleanup, USB/MTP states, SMTP acceptance/rejection, hostile filenames, verified USB copies, renderer/session isolation, filename XSS, settings geometry, and modern-MTP UX.

Automated tests do not pretend to prove external systems. Live Google delivery requires an OAuth client/test user and approved sender; live SMTP requires a provider credential; real USB coverage requires physical Kindle hardware. These gates are tracked explicitly in [PLAN.md](PLAN.md).

## Security and privacy

- Current Electron with sandboxed, context-isolated renderer and no Node integration.
- Strict Content Security Policy and a local custom protocol.
- Main-process file registry; renderer receives opaque IDs and safe metadata, not paths.
- IPC sender/payload checks, denied navigation/windows/permissions, and keyed HTTPS help links.
- Keychain-backed encrypted schema-v3 envelope for every app-managed private field; atomic owner-readable file and one-click local-data erasure.
- Non-persistent Chromium session; packaged builds cannot enable test crypto, fake login/device states, the test-only user-data override, or environment-substituted OAuth clients.
- SMTP credentials are bound to provider/host/port/TLS/user and discarded if that identity changes.
- Production Electron fuses disable Run-as-Node, `NODE_OPTIONS`, inspection, and extra `file://` privileges while enabling cookie encryption and ASAR integrity/ASAR-only loading.
- Calibre launched with an argument array and no shell.
- Validated Kindle target only; no arbitrary renderer-controlled destination.
- Receipt history is inside the encrypted envelope and never stores credentials or full source paths.

The original ebooks selected by the user, temporary Calibre conversion output while conversion is active, email handled by Gmail/Amazon, and files deliberately copied to a Kindle necessarily exist in plaintext while in use. KindleSync cleans its conversion directories after use and at the next launch after a crash.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and the precise data-handling promise.

Wireless necessarily gives the document to your mail provider and Amazon. USB mass-storage stays local.

## Troubleshooting

- **Submitted but absent:** confirm the sender is approved, Kindle address is correct, and Amazon's verification/error email is not waiting in the sender inbox. KindleSync cannot observe Amazon processing.
- **Google button is unavailable:** this development build needs `KINDLESYNC_GOOGLE_CLIENT_ID`; public builds should embed the developer's verified Desktop OAuth client ID.
- **Google login fails:** confirm Gmail API is enabled, the account is an allowed test user while the consent screen is in Testing, and the exact client is a Desktop app client.
- **Large document:** provider email limits can be lower than Amazon's. Open the official [200 MB web uploader](https://www.amazon.com/sendtokindle).
- **No USB Kindle:** use a data-capable cable, unlock the Kindle, close other transfer apps, and reconnect.
- **Modern Kindle detected:** this is expected for MTP. Use Wireless or follow [Amazon's USB Manager instructions](https://digprjsurvey.amazon.com/csad/help/node/TCUBEdEkbIhK07ysFu).
- **EPUB USB warning:** install Calibre or use Wireless. KindleSync will not copy a raw EPUB that the device may ignore.

## Project map

```text
main.js                    Electron entry and custom protocol registration
preload.js                 Narrow sandbox bridge and Electron file-path recovery
src/main/app.js            Lifecycle, secure window, menus, IPC, notifications
src/main/config-store.js   Atomic config and Keychain-backed credential
src/main/google-auth-service.js  Desktop OAuth, PKCE, refresh, revoke
src/main/gmail-service.js  Gmail API MIME submission
src/main/file-registry.js  Canonical files and opaque renderer IDs
src/main/delivery-policy.js
src/main/mail-service.js
src/main/device-service.js
src/main/calibre-service.js
src/main/usb-service.js
renderer/                  Task-first HTML/CSS/JS interface
test/                      Unit, integration, fixtures, Electron E2E
build/icon.icns            Original KindleSync app icon
PLAN.md                    Research, decisions, progress, release gates, handoff
```

## Authoritative research

- [Send methods, encryption, and formats](https://digprjsurvey.amazon.com/csad/help/node/G5WYD9SAF7PGXRNA)
- [Email limits and rules](https://digprjsurvey.amazon.com/csad/help/node/G7NECT4B4ZWHQ8WV)
- [Send to Kindle error codes](https://digprjsurvey.amazon.com/csad/help/node/T48rsVm3gY7KeGkKUk)
- [Approved sender setup](https://digprjsurvey.amazon.com/csad/help/node/GX9XLEVV8G4DB28H)
- [Personal-document compatibility matrix](https://digprjsurvey.amazon.com/csad/help/node/TNtSm13k3txFI4EvDV)
- [Current macOS USB/MTP instructions](https://digprjsurvey.amazon.com/csad/help/node/TCUBEdEkbIhK07ysFu)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Playwright Electron automation](https://playwright.dev/docs/api/class-electron)
- [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Gmail OAuth scopes](https://developers.google.com/identity/protocols/oauth2/scopes#gmail)
- [Gmail API messages.send](https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send)
