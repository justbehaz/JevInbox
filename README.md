# Jev Inbox

A web mail app that sorts Gmail, Outlook, iCloud and IMAP mail into categories using jev.ai, groups every email by sender, and never files authenticator or account-security mail as junk.

## Status
- Specs: `01`–`06` markdown files (taxonomy, never-junk rules, jev.ai contract, sender view, screens, mail sources).
- Code:
  - Never-junk gate in `app/src/gate/`, tested against a fake jev.ai client.
  - IMAP adapter in `app/src/providers/imap/` (imapflow): UIDVALIDITY and UID cursors, IDLE with polling fallback, MOVE or COPY plus flag, own Jev Auth / Jev Junk / Jev Needs review folders. It never writes to the server's Junk or Trash, never deletes, never expunges. iCloud preset and a generic preset (host, port, TLS, XOAUTH2 when available). Credentials come only from an injected provider.
  - Pipeline in `app/src/pipeline/run.ts`: fetch, redact, never-junk gate, move.
  - Sender view in `app/src/senders/`: local SQLite (better-sqlite3), grouped on the normalised From address with a domain rollup. Allow, mark-junk and mute are wired to the gate rules: mark-junk never moves Auth or security-shaped mail, mute only hides and never moves anything.
  - Read-only IMAP smoke script (see below).
  - Tests use an in-memory IMAP server and a mocked imapflow client, never a live account (166 tests).
- Web UI in `app/app/` and `app/components/` (Next.js, Tailwind, light and dark themes), backed by the pipeline, the sender store and a fake jev.ai client through the action layer in `app/src/ui/`.
- Not built yet: Gmail and Outlook adapters, saving accounts, the real jev.ai client, keychain credential storage.

## Run the app
```bash
cd app
npm install
npm run dev        # http://localhost:3000
```
The demo mailbox loads by default: a seeded in-memory mailbox of fictional senders, run through the real fetch, redact, never-junk gate and move pipeline with a scripted stand-in for jev.ai. No account is connected, nothing is saved to disk, and no credentials are needed. Restarting the server resets the demo.

Screens: Inbox (nav, list, preview), Auth, Needs review (file with one click), Junk (Not junk, Keep in Junk, Archive), Archive, Senders and "All from this sender" (allow, mark junk, mute), Categories (36 defaults, custom adds up to 48; disabled categories still count), and Settings (add-account preview: iCloud and IMAP forms, Gmail and Outlook coming soon; nothing is saved). The app never deletes mail, and Auth mail cannot be moved to Junk from any screen.

Production build: `npm run build` then `npm start`.

## Run the tests
```bash
cd app
npm install
npx vitest run
npx tsc --noEmit
```

## Smoke test against a real mailbox (read-only)
```bash
cd app
cp .env.example .env.local   # fill IMAP_PRESET, IMAP_USER, IMAP_PASSWORD (iCloud: an app-specific password)
npm run smoke:imap
```
It connects, prints the folder list and capabilities, fetches the 20 newest INBOX messages, and prints the bucket the gate would give each one. jev.ai is a fake client in this run, so only the deterministic rules (Auth detection, security-shape backstop) are real. Output is limited to the From domain and the subject cut to 60 characters; no addresses, bodies or snippets are printed. The transport is wrapped so that creating folders, moving, copying, flagging and IDLE all throw. Nothing on the account changes.

## Secrets
Copy `app/.env.example` to `app/.env.local` and fill in your own keys. `.env*` files are git-ignored and must never be committed.
