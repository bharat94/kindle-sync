# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or exposed credential. Use GitHub's private vulnerability reporting feature for this repository. If that feature is unavailable, contact the repository owner privately before sharing technical details.

Include the affected version, reproduction steps, expected impact, and any suggested mitigation. Do not access other people's accounts or data while testing.

## Supported versions

Only the latest published release receives security fixes. Releases are not production-ready until they are signed and notarized by the project owner.

## Data-handling promise

KindleSync encrypts its app-managed configuration, account identifiers, delivery history, and credentials at rest using Electron `safeStorage` backed by macOS Keychain. Ebook source files remain where the user placed them. Temporary conversion output and books deliberately copied to a Kindle necessarily exist as plaintext files while in use.

Google access uses the `gmail.send` scope. KindleSync does not request permission to read, modify, or delete mailbox content.
