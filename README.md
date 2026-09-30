# Jev Inbox

A web mail app that sorts Gmail, Outlook, iCloud and IMAP mail into categories using jev.ai, groups every email by sender, and never files authenticator or account-security mail as junk.

## Status
- Specs: `01`–`06` markdown files (taxonomy, never-junk rules, jev.ai contract, sender view, screens, mail sources).
- Code: the never-junk gate in `app/src/gate/`, tested against a fake jev.ai client (53 tests).

## Run the tests
```bash
cd app
npm install
npx vitest run
```

## Secrets
Copy `.env.example` to `app/.env.local` and fill in your own keys. `.env*` files are git-ignored and must never be committed.
