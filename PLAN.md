# KindleSync — Product, Architecture, and Delivery Plan

> Last updated: 2026-08-23.
>
> Product truth: KindleSync is a local macOS **one-way book delivery** app. Amazon exposes no documented public personal-document upload/status API, so wireless delivery can confirm Gmail API or SMTP submission but not conversion or arrival on a Kindle. Legacy USB mass-storage copies can be verified on disk. Modern MTP transfer is detected and handed off until a signed native MTP helper exists.

## 1. Objective and success criteria

Build a polished Electron app that opens like a normal Mac application, accepts ebooks by drag-and-drop, and gives the user the most reliable available route to a Kindle without a hosted web app, persistent localhost server, or background daemon. Google sign-in uses a temporary loopback callback only while the browser authorization is in progress.

The app succeeds when it:

- opens to a useful drop target within two seconds;
- preserves Finder/Dock-opened files until the renderer is ready;
- validates every file against the selected transport before enabling Send;
- submits supported personal documents through Gmail sign-in or an approved sender's SMTP account;
- copies compatible files to a real, writable legacy Kindle mass-storage volume;
- distinguishes no Kindle, a mounted legacy Kindle, and a connected MTP Kindle;
- never calls SMTP acceptance “delivered” or a filesystem copy “indexed”;
- stores every app-managed private field in a macOS Keychain-backed encrypted envelope, never plaintext at rest;
- has unit, integration, Electron E2E, packaging, and manual hardware test gates.

Non-goals for v1: purchased-book download, bidirectional library/highlight sync, Amazon private-API scraping, unverifiable delivery polling, replacing Calibre, or claiming native MTP before real-device testing.

## 2. Inherited prototype audit

The initial prototype is a useful spike, not a releasable base. It has an Electron window, queue, Nodemailer SMTP, `/Volumes` scanning, Calibre conversion, and electron-builder. Release blockers:

| Area | Existing behavior | Required correction |
|---|---|---|
| Calibre | Filename interpolated into `execSync` shell text | `execFile`/`spawn` argv, `shell:false`, timeout, unique temp dir, cleanup |
| Renderer | Filename/path inserted into `innerHTML`; no CSP | `textContent` DOM creation; strict CSP; sandbox |
| Secrets | Password plaintext and returned to renderer | `safeStorage`; main owns secret; migrate/delete plaintext |
| IPC | Renderer supplies paths, credentials, targets, URLs | Trusted-sender checks, schemas, allowlists, opaque file IDs |
| Dependencies | Electron 30 and Nodemailer 6 | Supported Electron and patched Nodemailer |
| Drag/drop | Removed `File.path` API | Preload `webUtils.getPathForFile` |
| Receipt | SMTP acceptance labeled delivered | State is `submitted`; Amazon status unobservable |
| Verification | Links to Kindle for Web | Remove; it does not support personal documents |
| Limits | 200 MB treated as email limit | Email 25 docs/50 MB plus provider cap; web 200 MB/document |
| ZIP | Claimed 50–200 MB loophole | Compression only; count/per-document rules remain |
| Detection | Every `/Volumes` entry can become a target | Only validated Kindle-like volumes; enumerate USB separately |
| Modern USB | OpenMTP assumed to mount `/Volumes` | OpenMTP has its own browser; MTP is a separate transport |
| Raw EPUB | Warns then copies invisibly | Convert to AZW3 or block and offer Wireless |
| UX | Permanent settings sidebar and developer log | Task-first UI, contextual setup, row states, receipts |
| Packaging | Separate arch flags described as universal | Universal target or clearly named arch artifacts; sign/notarize |

## 3. Research baseline

### 3.1 Official Send to Kindle surface

Amazon documents web upload, authorized email, mobile sharing, desktop apps, and a Chrome extension. No documented public personal-document upload/status API was found. Private endpoints and DOM automation are not core architecture.

Primary sources:

- Methods, encryption, formats: https://digprjsurvey.amazon.com/csad/help/node/G5WYD9SAF7PGXRNA
- Email rules: https://digprjsurvey.amazon.com/csad/help/node/G7NECT4B4ZWHQ8WV
- Error codes E001–E015/E999: https://digprjsurvey.amazon.com/csad/help/node/T48rsVm3gY7KeGkKUk
- Approved sender: https://digprjsurvey.amazon.com/csad/help/node/GX9XLEVV8G4DB28H
- App/device matrix: https://digprjsurvey.amazon.com/csad/help/node/TNtSm13k3txFI4EvDV
- macOS USB/MTP: https://digprjsurvey.amazon.com/csad/help/node/TCUBEdEkbIhK07ysFu

Current supported input union: PDF, DOC, DOCX, TXT, RTF, HTM/HTML, PNG, GIF, JPG/JPEG, BMP, EPUB. ZIP is a documented email compression container, not a book format. Amazon says it converts to a Kindle format; the app does not promise KFX or cover preservation.

### 3.2 Limits and batching

| Route | Product limit | Notes |
|---|---:|---|
| Amazon web | 200 MB/document | Browser fallback; no official API |
| Amazon email | 25 docs, 50 MB source total | Each attachment also no more than 50 MB before compression |
| Gmail preset | conservative 24 MB batch | Provider's 25 MB attachment limit is below Amazon's |
| iCloud preset | conservative 19 MB batch | Avoid Mail Drop links |
| Outlook preset | conservative 24 MB batch | Provider can reject before Amazon |
| Custom SMTP | selectable, max 50 MB | Provider may be lower |
| USB mass storage | free space/compatible format | Network limits do not apply |

Provider-aware preflight accounts for count and source bytes. Batches send serially. The app does not auto-retry uncertain post-DATA timeouts because that can duplicate books.

### 3.3 Receipt semantics

Wireless: `queued -> validating -> connecting -> submitting -> submitted | failed`.

`submitted` means the outgoing SMTP server accepted the message. It does not prove Amazon accepted, converted, archived, synchronized, downloaded, or displayed it. Receipt: timestamp, safe filenames/sizes, masked destination, SMTP host/message ID, and “Accepted by your mail server; Kindle delivery not independently confirmed.” Check the Kindle device/app and sender inbox. Amazon may send errors or a verification request; E014 unapproved-sender notification may only arrive once.

USB: `queued -> validating -> converting? -> copying -> verifying -> copied_verified | failed`.

`copied_verified` means destination name and size match after the write closes. It does not prove Kindle indexing.

### 3.4 macOS USB reality

- Older USB Mass Storage Kindles appear as mounted filesystems and can use validated `documents/` paths.
- Every Kindle Scribe and models released in 2024 or later use the modern MTP workflow described by Amazon on macOS.
- MTP devices are not POSIX volumes. OpenMTP is a two-pane transfer client, not FUSE.
- v1 separately probes `system_profiler SPUSBDataType -json`, so connected MTP is not mislabeled “no Kindle.”
- Until a native helper ships, offer Wireless or Amazon's official Send to Kindle USB File Manager.
- Native MTP v2 needs object-store traversal, upload/stat readback, exclusive-access handling, universal native binaries, nested signing, and real hardware tests.

### 3.5 Google authentication and Gmail delivery

Gmail is the default easy path. Users click **Sign in with Google** in their browser; they do not enter an SMTP host, username, normal password, or app password. The implementation follows Google's installed desktop application flow:

- system browser authentication, not an embedded login page;
- a random `127.0.0.1` loopback callback port used only during sign-in—this is not a hosted/local app web server;
- OAuth 2.0 authorization-code flow with a high-entropy PKCE verifier, S256 challenge, and state validation;
- `openid email` plus only `https://www.googleapis.com/auth/gmail.send`, never read/modify/full-mail access;
- short-lived access tokens kept in memory and refreshed from a Keychain-encrypted offline token;
- MIME built locally and submitted with Gmail API `users.messages.send`; no Google password enters KindleSync.

Primary sources:

- Desktop OAuth/loopback/PKCE: https://developers.google.com/identity/protocols/oauth2/native-app
- Gmail send scope: https://developers.google.com/identity/protocols/oauth2/scopes#gmail
- Gmail API send: https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send
- OAuth verification: https://support.google.com/cloud/answer/13461325

Developer activation is one-time, not per user: create a Google Cloud project, enable Gmail API, configure the OAuth consent screen, create a **Desktop app** client ID, and place that non-secret ID in `package.json` at `kindleSync.googleOAuthClientId` for a distributable build. Local development may instead set `KINDLESYNC_GOOGLE_CLIENT_ID`. Public distribution using the sensitive `gmail.send` scope requires Google OAuth verification, including a verified domain, homepage/privacy policy, scope justification, and demonstration video. Until an ID is configured, the UI explains that Google sign-in is unavailable; advanced iCloud/Outlook/custom SMTP remains present.

## 4. Product experience

### 4.1 Main window

- Single-column macOS task window; no permanent admin sidebar.
- Toolbar: name, Wireless/USB control, route status, Settings, History.
- Empty: “Drop books to send,” format summary, Choose Books.
- Populated: compact add-more area plus rows with name, type, size, semantic status.
- Sticky action bar: batch/limit summary, route privacy, one primary action.
- Transfer details collapsed by default; system light/dark, focus, reduced motion, increased contrast.

### 4.2 Just-in-time wireless setup

The queue works before setup. First Send or Settings opens:

1. Kindle address and Amazon Personal Document Settings link.
2. Sender address (read-only from Google on Gmail) and explicit approved-sender confirmation.
3. Gmail defaults to one-button Google OAuth; iCloud/Outlook/Custom reveal advanced app-password/TLS fields.
4. Google shows connected account/disconnect; advanced SMTP shows Test Connection; both disclose Keychain storage.

Renderer sees only `hasGoogleAccount` / `hasSmtpPassword`, never either secret. Google gets send-only access. Test Connection sends no book.

The default window is 880px wide and display-adaptive up to 940px high. On a normal Mac work area the complete Gmail setup dialog, including its footer actions, is visible immediately. On physically shorter displays the dialog body remains scrollable and the header/footer stay reachable.

### 4.3 USB states

| State | Meaning | Action |
|---|---|---|
| `detecting` | Probe active | Wait |
| `none` | Nothing mounted/enumerated | Retry; cable/unlock help |
| `legacy_ready` | Writable Kindle `documents/` | Send |
| `legacy_readonly` | Kindle-like volume not writable | Troubleshoot |
| `multiple` | Multiple valid volumes | Choose |
| `mtp_detected_unsupported` | Modern Kindle present, no native adapter | Wireless / Amazon manager |
| `transferring` | Conversion/copy underway | Per-file state |
| `ready_to_disconnect` | Copies verified, handles closed | Disconnect guidance |
| `disconnected` | Device vanished | Preserve/retry failures |

Manual target selection is Advanced and main validates a Kindle-like directory; arbitrary renderer destinations are rejected.

### 4.4 History, notifications, accessibility

- Persist the last 50 receipts inside the encrypted config envelope; no credentials/full source paths; individually clearable or removable with all local data.
- At most one batch notification with honest “submitted” or “copied and verified” wording.
- Command-O add, Command-Return send, Command-Comma settings, Command-Shift-K detect, Escape dismiss.
- Semantic landmarks/labels, `aria-live`, alert failures, named remove buttons, status text plus icon, 12 px minimum ordinary text.

## 5. Architecture

```text
Finder / Dock / file input
          |
          v
main-owned file registry -> renderer gets opaque IDs + safe metadata
          |
          v
delivery coordinator -> transport preflight + job state
       /          \
Gmail/SMTP adapter USBMS adapter
 | OAuth/Keychain   | Calibre argv/no shell
 | Gmail API/mail   | copy + verify
 v                  v
Google/mail relay Kindle documents/

USB probe -> legacy ready | MTP unsupported | none
                              |
                              v
                    official Amazon fallback
```

Target layout:

```text
src/main/
  app.js              lifecycle, menus, open-file buffering
  window.js           secure BrowserWindow policies
  ipc.js              trusted handlers and structured errors
  config-store.js     atomic versioned config + safeStorage
  file-registry.js    canonical files -> opaque IDs
  delivery-policy.js  formats, provider limits, batching
  google-auth-service.js loopback OAuth + PKCE + refresh/revoke
  gmail-service.js   send-only Gmail API MIME submission
  mail-service.js     Nodemailer adapter/receipts
  device-service.js   volumes + USB enumeration
  calibre-service.js  safe discovery/conversion
  usb-service.js      target validation/copy/verify
src/renderer/         semantic HTML, reducer-like JS, adaptive CSS
preload.js            narrow bridge + `webUtils.getPathForFile`
test/                 unit, integration, Playwright Electron
```

Adapter contract: `probe()`, `preflight(records, config)`, `send(job, progress)`, `verify(receipt)`. Verification reports only observable guarantees.

## 6. Security model

- Supported Electron; `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`.
- Packaged local renderer with strict CSP; no remote code, webviews, navigation, new windows, or permissions.
- Validate every IPC sender/payload; structured codes, not raw secret/path exceptions.
- Main canonicalizes regular files, rejects directories/symlinks, owns paths/targets.
- Explicit HTTPS allowlist for Amazon/provider/Calibre/project help.
- Entire schema-v3 config payload encrypted asynchronously with `safeStorage`; atomically migrate v1/v2 plaintext metadata and credentials.
- SMTP secrets cryptographically bound to provider/host/port/TLS/user and invalidated on identity changes.
- In-memory Chromium session; packaged builds reject all E2E environment hooks and OAuth client substitution.
- Hardened Electron fuses: no Run-as-Node/`NODE_OPTIONS`/inspection/file privileges; encrypted cookies and validated ASAR-only loading.
- Google login uses the system browser, loopback-only redirect, PKCE S256, state validation, and send-only scope; no client secret is shipped.
- TLS required for presets, certificate validation, bounded SMTP timeouts.
- Calibre executable + argv, `shell:false`, bounded output/time, unique temp cleanup.
- Revalidate writable Kindle target at send time and contain destination under `documents/`.
- Atomic owner-readable config/history; no analytics/telemetry.

## 7. Implementation and handoff tracker

Legend: `[x]` complete, `[~]` in progress, `[ ]` not started, `[!]` externally blocked.

### A — Research and plan

- [x] Audit repository and prototype.
- [x] Validate Amazon formats, limits, errors, approved sender, MTP guidance.
- [x] Independent UX, transport, and Electron security/testing reviews.
- [x] Correct OpenMTP, web verification, ZIP, KFX, receipt, and unrelated purchased-book claims.
- [x] Define v1 boundary and native-MTP track.

### B — Hardening and modularization

- [x] Upgrade dependencies and reach zero high/critical audit findings.
- [x] Pure delivery policy and structured result codes.
- [x] Main-owned opaque file registry.
- [x] Atomic config plus safeStorage migration.
- [x] Secure protocol/window/IPC/link policy.
- [x] Early open-file and second-instance buffering.

### C — Delivery adapters

- [x] Google desktop OAuth with loopback callback, PKCE, state, offline refresh, and disconnect.
- [x] Gmail API send-only adapter with local MIME composition and serial provider-aware batches.
- [x] Provider-specific readiness: Google account for Gmail; SMTP credential for advanced providers.
- [x] Provider presets and provider-aware batches.
- [x] SMTP test and `submitted` receipt.
- [x] Mounted Kindle discovery plus MTP USB enumeration.
- [x] Safe Calibre discovery/conversion.
- [x] Verified USBMS copy; raw EPUB blocked.
- [x] Official web/USB Manager fallbacks.
- [x] Safe receipt history and clear action.

### D — Renderer

- [x] Display-adaptive 880×up-to-940 initial window and tighter dialog viewport inset.
- [x] Gmail-first Sign in with Google account card; SMTP fields hidden unless an advanced provider is selected.
- [x] Google-derived read-only sender identity and approved-sender reminder.
- [x] Task-first main screen and contextual settings/history dialogs.
- [x] Adaptive drop target, rows, states, action bar, receipt/details.
- [x] Safe DOM and `webUtils` path recovery.
- [x] Light/dark, focus, reduced motion, contrast, minimum layout.
- [x] Menus and keyboard actions.

### E — Verification and packaging

- [x] Unit tests: policy, masking, filenames, config migration, parsers/states.
- [x] Integration: mock SMTP, temp USB, collision/verify, Calibre argv/cleanup.
- [x] Playwright Electron E2E: launch, queue, hostile name, settings, modes, boundary.
- [x] Audit, full suite, unpacked build, packaged launch smoke.
- [x] Universal build configuration, hardened runtime, associations, icon, build allowlist, and runnable ad-hoc local-build path.
- [x] GitHub macOS CI: syntax, unit/integration, Electron E2E, independent universal packaging, DMG/ZIP/code-seal/ASAR/fuse inspection, and packaged-renderer smoke.
- [x] CI build evidence: SHA-256 manifest, short-lived DMG/ZIP artifacts, and main-branch GitHub provenance attestations.
- [x] Separate pinned-action security workflow: signature-aware npm audit, CodeQL, weekly schedule, concurrency cancellation, and least-privilege job permissions.
- [!] Signing/notarization and clean-machine Gatekeeper require user Apple credentials.
- [!] Live SMTP needs user provider credentials and approved Kindle sender.
- [!] Physical matrix needs legacy USBMS and modern MTP hardware.
- [!] Production Google sign-in requires the owner's OAuth Desktop client ID and Google verification for public use.

### F — Open-source privacy and security pass

- [x] Add repository ignore rules for dependencies, builds, test/browser state, environments, keys, certificates, and local config.
- [x] Remove developer filesystem identity from tracked documentation; add private disclosure policy.
- [x] Encrypt addresses, account identifiers, SMTP settings, USB path, and receipt history—not only credentials.
- [x] Atomically migrate legacy v1/v2 config to a ciphertext-only v3 envelope.
- [x] Make test crypto/login/device/storage hooks impossible when `app.isPackaged`.
- [x] Ignore environment OAuth-client substitution in packaged builds.
- [x] Bind SMTP secret to its exact connection identity.
- [x] Move renderer to a non-persistent session and tighten CSP/IPC main-frame validation.
- [x] Add bounded Google/Gmail network requests and visible revocation-failure state.
- [x] Use owner-only conversion temp directories and remove crash residue on next launch.
- [x] Add in-app Erase All Data confirmation and clear local config/queue/browser state.
- [x] Configure hardened Electron fuses, Dependabot, pinned security workflow, npm audit/signature checks, and CodeQL.
- [x] Publish privacy-safe queue/settings screenshots, source-first setup, delivery-support matrix, security model, CI guarantees, distribution limits, troubleshooting, and contribution guidance.
- [!] Apple signing/notarization is still required before public binary distribution.

Verification record (2026-08-23):

- `npm run test:all`: 29/29 unit/integration tests and 6/6 Playwright Electron E2E tests passed.
- `npm audit --audit-level=low` and `npm audit --omit=dev --audit-level=low`: 0 vulnerabilities; all 287 registry signatures and 43 attestations verified.
- Common private-key/provider-token scan: no credential material found outside ignored/generated trees. ASAR inventory contains only the declared application files and production dependency.
- Electronegativity review produced only known static prompts: CSP parsing, fixed/allowlisted `openExternal` calls, denied navigation/window flows, disabled `remote`, and the intentionally narrow sandboxed preload. Each was manually reviewed against the packaged source.
- Packaged fuses: Run-as-Node, `NODE_OPTIONS`, Node CLI inspection, browser-specific V8 snapshot, and extra file privileges disabled; cookie encryption, embedded ASAR integrity, ASAR-only loading, and Wasm trap handlers enabled.
- `lipo -info`: packaged executable contains both `x86_64` and `arm64`.
- Renderer E2E: settings fit the initial 940px window without body scrolling; encrypted config/erase-all, hostile filenames, ephemeral session, Gmail-first setup, and MTP state passed.
- Packaged production-policy smoke loaded `kindlesync://app/index.html` while hostile test/OAuth environment overrides were set. Test login stayed disabled, the environment OAuth ID was ignored, and the on-disk envelope contained only `schemaVersion` plus `protectedDataCiphertext` using production crypto.
- v1.3.0 artifacts rebuilt with the CI verifier: `KindleSync-1.3.0-universal.dmg` SHA-256 `3e30c5f88496512f7a0b7ca6dc3efab43694b7fff22c8a98349909eb5cf3b991`; ZIP SHA-256 `2bc4717f5c8f350151d55bc9f4864589d3fbec41221433701b02590e2d61de04`. The DMG checksum, ZIP structure, ASAR allowlist, universal slices, Electron fuses, embedded app signature, nested code seals, and packaged renderer smoke verified successfully.
- Local DMG/ZIP builds are ad-hoc signed so hardened ASAR-integrity smoke testing can launch; `build:release` fails closed without a Developer ID identity. Ad-hoc signatures are not publisher identities or accepted public distribution artifacts, and notarization remains blocked on the owner's Apple credentials.

### G — Native MTP v2

- [ ] Select/license `libmtp`/`libusb` or independent helper.
- [ ] JSON contract: probe/list/mkdir/upload/stat/cancel.
- [ ] Universal nested-signed helper and exclusive-device states.
- [ ] Verify original Scribe, Basic 2024, Paperwhite 12, Colorsoft.
- [ ] Promote MTP to ready only after the matrix passes.

## 8. Test and release gates

Automated:

- Policy: supported extensions, 25/26 files, exact provider bounds, Amazon ceiling, USB no Amazon cap.
- Registry: regular files, dedupe, missing/dir/symlink, hostile names, opaque IDs.
- Config: plaintext v1/v2 migration, ciphertext-only v3 envelope, all-PII-at-rest scan, restart, binding invalidation, reset/delete.
- Google: PKCE/state/loopback, auth-code exchange, offline refresh, encrypted token/redaction, send-only scope, MIME/API success/failure/serial batches.
- SMTP: verify-only, accepted/rejected/auth/TLS/timeout, no secret in results, serial batches.
- Device: volume fixtures, writable/read-only/multiple, USB JSON MTP fixture, unrelated disks ignored.
- Calibre: hostile argv stays one argument; success/failure/timeout/temp cleanup and next-launch crash-residue cleanup.
- USB: collisions, partial cleanup, size verification, format rejection, required EPUB conversion.
- E2E: task-first launch, queue/de-dupe, hostile filename, encrypted envelope, erase-all, ephemeral session, setup geometry, no renderer Node, narrow bridge, MTP state.

Packaging:

- `npm run build:dir` and packaged launch smoke; local artifacts must carry a valid ad-hoc signature.
- Inspect universal binary with `lipo -info`, or clearly name separate architectures.
- Production allowlist excludes plaintext secrets/test fixtures.
- GitHub macOS CI must validate the DMG and ZIP, code seals, both architecture slices, Electron fuses, exact ASAR contents, packaged sandbox/policy, and ciphertext-only persistence before uploading artifacts.
- Signed release: `npm run build:release`, `codesign --verify --deep --strict`, `spctl --assess`, notarization/stapler, clean-Mac DMG install.

Manual matrix:

| Scenario | Expected proof |
|---|---|
| Approved provider + small EPUB/PDF | App says submitted; user confirms eventual device/app appearance |
| Unapproved sender | App remains submitted; sender inbox/Amazon E014 explains failure |
| Provider cap exceeded | Preflight splits/blocks before SMTP |
| Legacy USBMS + AZW3/PDF | Destination verified; visibility manually confirmed after disconnect |
| Legacy USBMS + EPUB + Calibre | Converted AZW3 copied/verified |
| Legacy USBMS + EPUB without Calibre | Blocked; Wireless offered; no raw copy |
| Modern Scribe/2024 Kindle | MTP unsupported; official manager/Wireless offered |
| Charge-only/locked | `none` plus troubleshooting |

## 9. Packaging and launch

Electron already is the macOS wrapper; do not add Automator/shell wrapper. Developer launch is `npm start`. User launch is a notarized DMG -> Applications -> Spotlight/Finder/Dock, with window/Dock drop and alternate-rank Finder Open With.

Package requirements: stable `com.kindlesync.app`, real publisher metadata, Books category, hardened runtime, `NSRemovableVolumesUsageDescription`, EPUB/PDF/DOCX Viewer associations, deterministic artifact name, icon, ASAR, and universal or clearly separate architecture artifacts. Credentials remain outside the repo.

## 10. Decisions and handoff invariants

- Electron retained: real `.app`, Dock/open-file, filesystem/SMTP, no localhost. Tauri is premature.
- Gmail OAuth is the default: easiest user flow and narrower send-only permission. SMTP remains for iCloud/Outlook/custom and as an advanced compatibility path.
- No Amazon web automation; official web upload is a browser fallback.
- USBMS shipped and MTP not faked.
- No extra wrapper; signing/notarization make the `.app` launchable.
- Static renderer retained; modular services and tests are sufficient.

Resume at the first unchecked item above. Never regress:

1. Never say `delivered` from SMTP acceptance.
2. Never use Kindle for Web to verify personal documents.
3. Never claim OpenMTP creates a `/Volumes` mount.
4. Never copy raw EPUB as successful USB delivery.
5. Never expose SMTP secret or filesystem paths to renderer.
6. Never invoke Calibre with shell text.
7. Never accept arbitrary renderer USB destinations.
8. Never mark signing, live SMTP, or physical hardware tests complete without doing them.
9. Never ship a Google client secret, request inbox-reading scope, or call Gmail API acceptance “Kindle delivered.”
