# Jev Inbox

A web mail app that sorts Gmail, Outlook, iCloud and IMAP mail into categories using jev.ai, groups every email by sender, and never files authenticator or account-security mail as junk.

## Status
- Specs: `01`–`06` markdown files (taxonomy, never-junk rules, jev.ai contract, sender view, screens, mail sources).
- Code:
  - Never-junk gate in `app/src/gate/`, tested against a fake jev.ai client.
  - IMAP adapter in `app/src/providers/imap/` (imapflow): UIDVALIDITY and UID cursors, IDLE with polling fallback, MOVE or COPY plus flag, own Jev Auth / Jev Junk / Jev Needs review folders. It never writes to the server's Junk or Trash, never deletes, never expunges. iCloud preset and a generic preset (host, port, TLS, XOAUTH2 when available). Credentials come only from an injected provider.
  - Pipeline in `app/src/pipeline/run.ts`: fetch, redact, never-junk gate, move.
  - Tests use an in-memory IMAP server and a mocked imapflow client, never a live account (100 tests).
- Not built yet: Gmail and Outlook adapters, the web UI, the real jev.ai client, keychain credential storage.

## Run the tests
```bash
cd app
npm install
npx vitest run
npx tsc --noEmit
```

## Secrets
Copy `app/.env.example` to `app/.env.local` and fill in your own keys. `.env*` files are git-ignored and must never be committed.
