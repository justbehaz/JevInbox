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
  - Tests use an in-memory IMAP server and a mocked imapflow client, never a live account (219 tests).
- Web UI in `app/app/` and `app/components/` (Next.js, Tailwind, light and dark themes), backed by the pipeline, the sender store and a fake jev.ai client through the action layer in `app/src/ui/`.
- Accounts: iCloud and generic IMAP can be added from Settings (read-only connection test, then confirm), with passwords in the Keychain (or an encrypted file), a persistent SQLite store outside the repo, Sync now, and 5-minute background polling.
- Not built yet: Gmail and Outlook adapters (they need your own OAuth app registrations) and the real jev.ai client (waiting for its API docs).

## Run the app
```bash
cd app
npm install
npm run dev        # http://localhost:3000
```
The demo mailbox loads by default when no account is saved: a seeded in-memory mailbox of fictional senders, run through the real fetch, redact, never-junk gate and move pipeline with a scripted stand-in for jev.ai. No credentials are needed and the demo is not saved. Restarting the server resets it.

Screens: Inbox (nav, list, preview), Auth, Needs review (file with one click), Junk (Not junk, Keep in Junk, Archive), Archive, Senders and "All from this sender" (allow, mark junk, mute), Categories (36 defaults, custom adds up to 48; disabled categories still count), and Settings (add-account preview: iCloud and IMAP forms, Gmail and Outlook coming soon; nothing is saved). The app never deletes mail, and Auth mail cannot be moved to Junk from any screen.

Production build: `npm run build` then `npm start`.

### Add your iCloud account
1. In your Apple Account (account.apple.com), open Sign-In and Security, then App-Specific Passwords, and generate one named "Jev Inbox". Two-factor authentication must be on. Never use your Apple Account password.
2. Run `npm run dev`, open Settings, and use the iCloud form: your iCloud email address and the app-specific password. Press Test connection.
3. Review the result: it connected read-only, the folders and capabilities found. Nothing has changed on your mailbox.
4. Press Confirm and save account. This stores the password in the macOS Keychain and saves the account details locally, in **Preview mode**. Nothing is created or moved on your mailbox.
5. Press Sync now (header). The first sync looks at the newest 200 messages; later syncs run every 5 minutes while the app is running. In Preview mode a sync only classifies and records in the app: each message shows where it would go, and the server gets no moves, no flags and no folder creation (the connection itself is read-only).
6. When you are happy, open Settings and use "Apply filing to my mailbox". It first shows the counts, for example "12 Auth messages will move to Jev Auth. Nothing will be junked or deleted." Applying creates the Jev Auth, Jev Needs review and Jev Junk folders, turns Preview off, and moves the Auth mail already recorded. After that, each sync moves new Auth mail into Jev Auth. "Turn preview back on" stops future moves; it does not undo past ones.

jev.ai is not connected yet, so only the deterministic rules run: Auth mail is recognised (and moved to Jev Auth once you apply filing); everything else stays where it is (shown under Needs review in the app); nothing is junked. Remove account (Settings) deletes the stored password and the local data for it; it never touches mail on the server, and the Jev folders stay on your mailbox.

### Where data lives
- Database: `~/Library/Application Support/JevInbox/jev.sqlite` on macOS (set `JEV_DATA_DIR` to change it). It must be outside the project folder. It holds message metadata, senders and categories, never passwords.
- Passwords: macOS Keychain, entry names `jev-inbox-{provider}-{email}`. On other systems an AES-256-GCM encrypted file in the data directory, with the key from `TOKEN_ENCRYPTION_KEY` in `app/.env.local`; the app refuses to start without it.

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
