# Jev Inbox Mail Source Integrations

## Overview

This document specifies the mail source integrations for Jev Inbox: how to connect to Gmail, Outlook/Microsoft 365, iCloud, and generic IMAP providers; sync strategies per provider; credential and token storage; and how the never-junk gate (02-never-junk.md) applies across all providers.

**Core principles:**
- One adapter interface per provider implementation.
- Sync is always provider-specific (history IDs + push for Gmail, delta + webhooks for Outlook, IDLE/polling for IMAP).
- Moves are reversible: record original location, never delete, no expunge.
- If Junk bucket creation fails, fall back to Needs review.
- Never apply provider's own spam/junk label automatically; never remove or trash it.
- Credential and token storage is encrypted locally (OS keychain or encrypted file).
- Redaction of codes and reset/verify links (from 03-jev-contract.md) is applied before jev.ai on device for every provider.
- The never-junk gate runs locally after fetch, before jev.ai, and applies the same rules across all providers.

---

## Common: Adapter Interface

All mail source adapters expose a common interface in TypeScript-style pseudo-code. The app uses this abstraction to treat Gmail, Outlook, iCloud, and IMAP as interchangeable.

```typescript
interface MailAdapter {
  // Initialize and authenticate; returns a handle or connection object.
  // May prompt user for OAuth, app password, or IMAP credentials.
  authenticate(config: ProviderConfig): Promise<AuthResult>;
  
  // Retrieve messages in a folder/label.
  // Returns minimal message metadata (ID, From, Subject, Snippet, Date, Headers).
  // Snippet is truncated and redacted (codes and links replaced) before returning to caller.
  listMessages(
    folder: string,  // Provider-specific: Gmail label ID, Outlook folder ID, IMAP folder name
    options?: { limit?: number; cursor?: string; since?: Date; unread?: boolean }
  ): Promise<MessageListResult>;
  
  // Fetch full headers and visible body snippet for a single message.
  // Returns: { headers, snippet, authentication_results (SPF/DKIM/DMARC if available) }
  // Headers include From, To, Subject, Date, Reply-To, List-Unsubscribe, etc.
  fetchHeadersAndSnippet(
    folder: string,
    messageId: string
  ): Promise<MessageDetail>;
  
  // Move a message to a bucket (our Junk, Needs review, or a category folder/label).
  // Implementation: For Gmail, add label and remove INBOX. For Outlook, use move endpoint.
  // For IMAP, use the MOVE extension when advertised; otherwise COPY and flag the original with the harmless keyword $JevMoved. Never mark \\Deleted, never EXPUNGE.
  // Returns the operation result (message ID in new location, original location recorded).
  moveToBucket(
    folder: string,
    messageId: string,
    targetBucket: string  // 'junk', 'needs_review', 'category_X', or 'auth'
  ): Promise<MoveResult>;
  
  // Ensure a bucket (folder/label) exists for this provider.
  // If creation fails (permissions, name clash, folder limits), return fallback info.
  ensureBucket(bucketName: string): Promise<BucketInfo>;
  
  // Watch for new messages (real-time push) or start polling.
  // push(): Set up push notifications (Gmail Pub/Sub, Outlook webhooks).
  // poll(): Fallback to periodic polling (IMAP UID polling, Graph delta queries).
  watch(
    callback: (event: MailEvent) => void  // event.type: 'message_added', 'message_modified'
  ): Promise<Watcher>;
  
  // Report capabilities: what features this adapter supports.
  capabilities(): AdapterCapabilities;
  
  // Disconnect, revoke token, clear stored credentials.
  disconnect(): Promise<void>;
}

interface ProviderConfig {
  provider: 'gmail' | 'outlook' | 'icloud' | 'imap';
  // Provider-specific config fields (see per-provider section below)
}

interface AuthResult {
  success: boolean;
  userId: string;  // Unique ID for this user's account at this provider
  displayName?: string;
  email?: string;
  error?: string;
}

interface MessageListResult {
  messages: Array<{
    id: string;  // Provider-specific ID
    from: string;  // Email address
    fromDisplayName?: string;
    subject: string;
    snippet: string;  // Max 500 chars, redacted
    date: Date;
    unread: boolean;
  }>;
  cursor?: string;  // For pagination or sync cursor (history ID, delta token)
}

interface MessageDetail {
  headers: {
    from: string;
    to: string;
    subject: string;
    date: Date;
    replyTo?: string;
    listUnsubscribe?: string;
    [key: string]: any;
  };
  snippet: string;  // First ~500 chars of visible body, redacted
  authentication_results?: string;  // "spf=pass dkim=pass dmarc=pass" etc.
  inlineImages?: Array<{ contentId: string; mimeType: string }>;  // For rendering
}

interface MoveResult {
  success: boolean;
  messageId: string;  // ID in target bucket
  originalLocation: string;  // Where the message came from (for reversibility)
  error?: string;
}

interface BucketInfo {
  name: string;
  id: string;  // Provider-specific (label ID, folder ID, etc.)
  created: boolean;  // Was bucket created, or did it pre-exist?
  fallback?: string;  // If creation failed, which bucket to use instead (e.g., 'needs_review')
}

interface AdapterCapabilities {
  pushNotifications: boolean;  // Pub/Sub, webhooks, or polling only
  labelSupport: boolean;  // Gmail labels vs. Outlook folders
  idleSupport: boolean;  // IMAP IDLE (real-time notifications)
  customFolders: boolean;  // Can create arbitrary folders/labels
  readReceipts: boolean;  // Supports read status
  stars: boolean;  // Supports flagging/starring messages
  authMethods: string[];  // ['oauth', 'app_password', 'imap', ...]
}

interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  isActive(): boolean;
}

interface MailEvent {
  type: 'message_added' | 'message_modified' | 'message_deleted' | 'message_moved';
  provider: string;
  folder: string;
  messageId: string;
  timestamp: Date;
}
```

---

## GMAIL

### Authentication

**Protocol:** OAuth 2.0 via Google OAuth 2.0 Playground or web flow.

**Scopes:**
- `gmail.modify` — Read/modify mail, apply labels, manage drafts.
- `gmail.readonly` — Read-only alternative (not sufficient for moving mail; not recommended).

**Public App (Unverified):**
- A public app needs `gmail.modify` and must complete **Google OAuth verification** and a **CASA (Coordinated Auxiliary Set of APIs) security assessment**.
- Until verification, the app is restricted to **personal or testing users only**.
- Test users list: configured in Google Cloud Console under OAuth consent screen.
- Refresh tokens for testing-status apps expire after **7 days** of inactivity; note this as a caveat in the UI.
- Display a warning in the setup flow: "This app is in testing mode. Refresh tokens expire after 7 days of no use. Please sign in at least weekly to maintain access."

**Credentials Storage:**
- Access token (short-lived, ~1 hour).
- Refresh token (long-lived, ~6 months under normal use; 7 days if testing-status app).
- User ID (stable identifier).
- Stored encrypted in OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) or encrypted file with a key from the keychain.
- Never log tokens or user email in plaintext.

### Label Mapping

Gmail does not have folders; it uses labels and threads. Jev Inbox maps system buckets and user categories to Gmail labels:

**Mapping:**
- Auth bucket → Label `Jev/Auth` (create if missing).
- Junk bucket → Label `Jev/Junk` (create if missing).
- Needs review bucket → Label `Jev/Needs review` (create if missing).
- User categories → Labels `Jev/cat_001`, `Jev/cat_002`, ..., `Jev/cat_036`, `Jev/custom_001`, etc. (create on demand).

**Moving (Implementation):**
- To move a message to Junk: `POST /gmail/v1/users/me/messages/{id}/modify` with `addLabelIds: ['Jev/Junk']` and `removeLabelIds: ['INBOX']` (remove from INBOX to move out).
- Do NOT remove Gmail's own `SPAM` label if it already has it; just add our label and remove INBOX.
- Reverse move: add `INBOX` and remove our label.
- No expunge; all messages remain in the account.

**Safety Rule (Never-Junk Gate):**
- If a message has Gmail's `SPAM` label: do NOT automatically fetch it for classification by default. Offer an option: "Include Gmail spam folder (read-only)" in settings.
- If the deterministic Auth pass (02-never-junk.md) matches a message Gmail flagged as SPAM: surface a read-only notice in the UI "Possible security mail in provider spam; Gmail flagged this as spam, but it looks like a security alert." Offer user-approved rescue (reversible move to Auth or Needs review). Never auto-move it.
- Redaction rule (03-jev-contract.md): codes and reset/verify links are redacted on device before the jev.ai request; Google never sees them.

### Sync Strategy

**Primary: Push via Pub/Sub (Real-Time)**

1. **Setup:**
   - Create a Cloud Pub/Sub topic (e.g., `projects/{project}/topics/jev-inbox-{user-id}`).
   - Set up a Cloud Pub/Sub subscription and endpoint (must be reachable from Google Cloud).
   - Call `POST /gmail/v1/users/me/watch` with the topic name.
   - Google sends notifications via Pub/Sub when the user's mailbox changes (new messages, label changes, etc.).
   - **Renewal:** The watch expires after **7 days**; renew every 6 days to avoid gaps.

2. **Event handling:**
   - On Pub/Sub message: call `GET /gmail/v1/users/me/history` with the `historyId` from the previous sync.
   - Retrieve new/modified messages since the last sync.
   - Process each message: extract headers, redact, classify, file.

3. **Fallback: Polling (If Push Unavailable):**
   - For a local/desktop app (no reachable endpoint), fall back to polling.
   - Every 30–60 seconds, call `GET /gmail/v1/users/me/history` with the stored `historyId`.
   - Process deltas since last sync.

**History API Details:**
- `historyId` is a monotonically increasing integer per user account.
- Store the latest `historyId` after each sync.
- On next sync, query history since that `historyId` to get only new/changed messages.
- Supports `labelId` parameter to filter by label (e.g., only INBOX changes).

### Caveat: Public App Without Verification

- Testing-status apps have **7-day refresh token expiry**.
- Display in the setup screen: "This app is in testing mode. Refresh tokens expire after 7 days of inactivity. Keep the app running or sign in periodically to maintain access."
- Plan a transition: once CASA verification is completed, production app can be published.
- For testing, recommend users re-authenticate every 5–6 days if the app is not running continuously.

---

## OUTLOOK / MICROSOFT 365

### Authentication

**Protocol:** OAuth 2.0 via Microsoft Account (personal) or Azure AD (enterprise).

**Library:** MSAL (Microsoft Authentication Library) for web/desktop.

**Scopes:**
- `Mail.ReadWrite` — Read and modify mail, create folders, move messages.
- `offline_access` — Obtain a refresh token (without this, tokens do not refresh).

**Credentials Storage:**
- Access token (short-lived, ~1 hour).
- Refresh token (long-lived, ~90 days or until revoked).
- User ID (mail address).
- Encrypted in OS keychain or encrypted file with keychain-derived key.
- Never log tokens in plaintext.

**IMAP NOT Recommended:**
- Microsoft 365 and Outlook.com have **disabled basic-auth IMAP** (username/password authentication).
- Do not offer IMAP for Outlook.com or M365; redirect users to OAuth only.
- If legacy accounts exist with IMAP enabled, document the limitation and warn user of security risks.

### Folder Mapping

Outlook uses a folder hierarchy (traditional IMAP-style folders, not labels).

**Mapping:**
- System buckets: Create child folders under Inbox or root.
  - `Inbox\Jev Auth` (or `Jev Auth` at root).
  - `Inbox\Jev Junk` (or `Jev Junk` at root).
  - `Inbox\Jev Needs review` (or `Jev Needs review` at root).
- User categories: Create folders `Jev\cat_001`, `Jev\cat_002`, etc. (or use flat structure at root).

**Moving (Implementation):**
- To move a message: `POST /me/mailFolders/{folder-id}/messages/{id}/move` with target folder ID.
- Move is atomic; no remove step needed (unlike Gmail labels).
- Reverse move: call move endpoint again with original folder ID.
- No delete; messages remain in the target folder.

**Safety Rule (Never-Junk Gate):**
- If a message is in Outlook's own "Junk Email" folder: do NOT automatically fetch it by default.
- Offer a setting: "Include Outlook Junk folder (read-only)".
- If deterministic Auth pass matches a message in Junk Email: surface notice "Possible security mail in provider junk" and offer reversible rescue.
- Redaction rule (03-jev-contract.md): codes and reset/verify links redacted on device before jev.ai.

### Sync Strategy

**Primary: Delta Queries (Incremental Sync) + Webhooks (Real-Time)**

1. **Folder Setup:**
   - Query `GET /me/mailFolders` to list folders.
   - Create Jev folders if missing.

2. **Initial Sync (First Run):**
   - For each folder, call `GET /me/mailFolders/{folder-id}/messages/delta?$select=id,from,subject,receivedDateTime,isRead,bodyPreview`.
   - Store the `deltaLink` returned (e.g., `https://graph.microsoft.com/v1.0/me/mailFolders/AAM...?$deltatoken=...`).

3. **Incremental Sync (Polling Fallback):**
   - Call the stored `deltaLink` to fetch only changes since last sync.
   - Microsoft returns: new messages, changed properties, deleted messages.
   - Update local store; extract headers, redact, classify.

4. **Real-Time: Change Notifications (Webhooks):**
   - Create a subscription: `POST /subscriptions` with resource `me/mailFolders/inbox/messages`, notificationUrl (must be HTTPS), and expirationDateTime (max 4230 minutes / 70 hours).
   - On notification: call delta query to fetch the changed messages.
   - Renew subscription every 60 hours (before expiration).

5. **Polling Fallback (If Webhook Unavailable):**
   - Every 30–60 seconds, call the stored `deltaLink` to fetch changes.
   - No webhook setup needed; slower than push but works for any environment.

### Caveat: Folder Move Behavior

- Move via Graph endpoint is reversible: store original folder ID before move.
- No "trash" bucket; deleted folders are removed from the folder hierarchy, but messages can be moved to a Deleted Items folder if desired.
- Outlook does not have auto-expunge; messages in Deleted Items stay indefinitely unless user manually empties.

---

## ICLOUD

### Authentication

**Protocol:** IMAP over TLS (imap.mail.me.com:993), with app-specific password (no OAuth available).

**Setup (User-Facing Instructions):**

UI setup screen must show exact, copyable steps:

```
iCloud Mail Setup

1. Sign in to account.apple.com on your device (on the iCloud Mail device or in a browser).
2. Go to Account Settings → Sign-In and Security.
3. Scroll to "App-Specific Passwords" section.
4. Click "Generate app-specific password" or "Create password".
5. Select "Mail" and "Jev Inbox".
6. Apple will generate a 16-character password (e.g., abcd-efgh-ijkl-mnop).
7. Copy the password (do not share it).
8. Return to Jev Inbox and paste the password in the setup form.
9. Verify connection.

IMPORTANT: You must have two-factor authentication enabled on your Apple Account 
for app-specific passwords to work. This is for your security.

Your iCloud Mail address: [user's primary iCloud email]
Do not use your Apple ID password. Use only the app-specific password generated above.
```

**Security Caveat:**
- App-specific passwords require two-factor authentication on the Apple Account.
- Never store or transmit the main Apple ID password.
- Credentials stored encrypted in OS keychain or encrypted file.

### IMAP Configuration

**Server:** `imap.mail.me.com`
**Port:** 993 (implicit TLS, not STARTTLS)
**Username:** Full iCloud email address (e.g., user@icloud.com)
**Password:** App-specific password (generated above)
**TLS Mode:** Implicit TLS (connection starts encrypted; no STARTTLS)

**Limitations (Document in UI):**
- iCloud IMAP has folder limitations (no nested subfolders beyond 2 levels in some cases; verify via XLIST).
- iCloud IMAP may have stricter rate limits than Gmail or Outlook; monitor for throttling.
- IDLE support varies by iCloud region; test IDLE capability before relying on it.
- Drafts and sent items sync may be limited; note in UI if sync is incomplete.

### Folder Mapping

IMAP folders are flat or hierarchical (via IMAP folder naming with `/` or `.` separators).

**Mapping:**
- Use IMAP folder commands to create folders for Jev buckets.
- Folder names: `[Gmail]/Jev Auth`, `[Gmail]/Jev Junk`, `[Gmail]/Jev Needs review`, or at root: `Jev Auth`, `Jev Junk`, etc.
- iCloud may have a `[Gmail]` pseudo-folder or use flat namespace; test on first connect.

**Moving (Implementation):**
- IMAP COPY command: `COPY message-id destination-folder`.
- No MOVE extension: after COPY, flag the original with the keyword `$JevMoved` (never `\Deleted`). The original stays in place; nothing is deleted or expunged.
- With the MOVE extension (RFC 6851) use `UID MOVE`; the server relocates the message itself.
- Reverse move: `UID MOVE` back using the destination UID (needs UIDPLUS), or clear `$JevMoved` if COPY was used.

**Safety Rule (Never-Junk Gate):**
- iCloud's `[Gmail]` folder (if present) may have a Junk subfolder. Do NOT automatically move mail to it.
- If deterministic Auth pass matches mail in iCloud Junk: surface notice and offer reversible rescue.
- Redaction rule: codes and reset/verify links redacted on device before jev.ai.

### Sync Strategy

**IDLE (If Advertised in IMAP CAPABILITY)**

1. After LOGIN, issue `IDLE` command.
2. Server sends `+ idling` response; client waits for server-initiated notifications.
3. On new message, server sends `* N EXISTS` (message count increased).
4. Client issues `DONE` to exit IDLE, then issues `SELECT folder` and `FETCH` to retrieve new messages.
5. Resume IDLE.

**Fallback: UID Polling (If IDLE Unavailable or Unreliable)**

1. Issue `SELECT folder` to select a folder.
2. Store the UIDVALIDITY value (mailbox UID version; if it changes, resync).
3. Every 30–60 seconds, issue `UID SEARCH UID (UIDNEXT:*)` to get new message UIDs since last sync.
4. Fetch headers for new UIDs.
5. If UIDVALIDITY changes, re-fetch all UIDs from scratch.

**UIDVALIDITY Handling:**
- If UIDVALIDITY changes, the folder's UID sequence has been reset (mailbox was deleted and recreated).
- Clear stored UIDs for this folder; perform full re-sync from scratch.
- Update local UIDVALIDITY value.

---

## GENERIC IMAP

### Authentication

**User-Provided Configuration:**

```
IMAP Server Setup

Server (host): [e.g., imap.mail.com]
Port: [default 993]
TLS Mode: 
  - Implicit TLS (connection starts encrypted; port 993)
  - STARTTLS (connect plaintext, then upgrade; port 143 or 587)
  - Plain (no encryption; not recommended)
Username: [user's email or IMAP username]
Password: [IMAP password or app-specific password]

[ ] Use OAuth (if advertised by server)
```

**OAuth Support (XOAUTH2):**
- If the server advertises `AUTH=XOAUTH2` in IMAP CAPABILITY, the adapter may use OAuth instead of password.
- Requires server-specific OAuth configuration (many IMAP servers do not support XOAUTH2).
- Fallback to password authentication if XOAUTH2 is not available or fails.

**Credentials Storage:**
- Username and password (or access token for XOAUTH2) stored encrypted in OS keychain or encrypted file.
- Never log credentials in plaintext.
- Support secure credential input: password fields with masking, option to paste app-specific passwords.

### Autodiscover and Folder Discovery

**Autodiscover Hints (Optional, for Common Providers):**
- Offer a dropdown or autocomplete for known IMAP providers (Gmail, Outlook, Yahoo, etc.).
- Pre-fill host, port, and TLS mode based on provider selection.
- Allow manual override.

**Certificate Validation:**
- Always validate TLS certificate chain (do not skip TOFU).
- Warn user if certificate is self-signed or invalid.
- Option to accept self-signed certs (for testing/enterprise); requires user acknowledgment.

**Folder Discovery (Special-Use Attributes):**
- After LOGIN, issue `LIST "" "*"` to enumerate all folders.
- Parse IMAP special-use attributes (`\Junk`, `\Trash`, `\Drafts`, `\Sent`, `\Archive`).
- Use special-use attributes to identify default folders (e.g., Junk folder = `\Junk` folder).
- Display folder hierarchy in UI; let user select folders to sync.

### IDLE vs. UID Polling

**IDLE (If Supported):**
- Issue `IDLE` command after LOGIN; server sends notifications on new messages.
- Exit IDLE with `DONE` command to fetch headers.
- Resume IDLE.

**UID Polling (Fallback):**
- Store UIDNEXT (next expected UID).
- Every 30–60 seconds, issue `UID SEARCH UID (UIDNEXT:*)` to fetch UIDs since last sync.
- Fetch headers for new UIDs.
- Update UIDNEXT.

**UIDVALIDITY:**
- On folder selection, check UIDVALIDITY.
- If it changes, resync that folder (UIDs have been reset).

### Folder Mapping

**Create Jev Folders:**
- Issue `CREATE` command to create `Jev Auth`, `Jev Junk`, `Jev Needs review`, `Jev/cat_001`, etc.
- If folder creation fails (permissions, quota), fall back to Needs review bucket.

**Moving (Implementation):**
- `COPY message-ids destination-folder`.
- No MOVE extension: COPY, then flag the original with `$JevMoved` (never `\Deleted`, never `EXPUNGE`).
- With MOVE: `UID MOVE`.
- Reverse move: `UID MOVE` back using the destination UID, or clear `$JevMoved`.

**Safety Rule (Never-Junk Gate):**
- Do not automatically move mail to the provider's `\Junk` folder.
- If deterministic Auth pass matches mail in `\Junk`: surface notice and offer reversible rescue.
- Redaction rule: codes and reset/verify links redacted on device before jev.ai.

### Sync Strategy

**IDLE (Preferred):**
1. LOGIN.
2. SELECT folder (e.g., INBOX).
3. Issue `IDLE`.
4. On notification (`* N EXISTS` or flag changes), issue `DONE`.
5. `FETCH (1:N) (BODY.PEEK[HEADER])` to get new messages.
6. Process messages: extract headers, redact, classify.
7. Resume IDLE.

**Polling (Fallback):**
1. SELECT folder.
2. Store UIDVALIDITY and UIDNEXT.
3. Every 30–60 seconds, `UID SEARCH UID (UIDNEXT:*)`.
4. FETCH headers for new UIDs.
5. If UIDVALIDITY changes, resync folder (clear stored UIDs).
6. Update UIDNEXT.

---

## COMMON: Credential and Token Storage

### Local Encryption

**Encrypted Storage Options:**

1. **OS Keychain (Preferred):**
   - macOS: Keychain Services API.
   - Windows: Credential Manager (via DPAPI).
   - Linux: Secret Service (via D-Bus) or pass (local encrypted file).
   - Advantage: OS-level encryption, secure deletion, no local file needed.
   - Disadvantage: Requires OS support; not available on all platforms.

2. **Encrypted File (Fallback):**
   - Store credentials in a local SQLite database or JSON file.
   - Encrypt with AES-256-GCM; key derivation from a master key stored in the OS keychain.
   - If OS keychain is unavailable, ask user for a master password on app startup.
   - Never store the master password; use it only to derive the encryption key.

### Refresh Token Handling

- **Gmail:** Refresh token stored encrypted. On expiry (7 days for testing-status apps, 6 months for production), use refresh token to get new access token. If refresh token expires, prompt user to re-authenticate.
- **Outlook:** Refresh token stored encrypted. Similar to Gmail; handle expiry gracefully.
- **iCloud:** No refresh token (app-specific password does not expire); re-use stored password for future auth.
- **IMAP:** No refresh token; password-based auth; re-use stored password.

### Token Revocation and Disconnect

**On Disconnect / App Uninstall:**
- Gmail: Revoke refresh token via `POST /o/oauth2/revoke`.
- Outlook: Revoke token via Graph endpoint.
- iCloud: Delete the app-specific password via account.apple.com (requires user intervention; app can guide user to do this).
- IMAP: No revocation needed; password remains valid. Advise user to change password or delete app-specific password manually.
- Clear all stored credentials from keychain or encrypted file.

### Multi-Account Support

- Store credentials per user email address (or unique user ID per provider).
- Keychain entry names: `jev-inbox-{provider}-{user-id}` (e.g., `jev-inbox-gmail-user@gmail.com`).
- Support multiple accounts per provider (e.g., two Gmail accounts, one personal and one work).
- UI: Let user select which account to sync from, or sync all connected accounts to a unified inbox.

---

## COMMON: Sync and Cursor Storage

### Cursor / Sync State

**Local Storage:**
- Per provider, per user account, store the last sync cursor:
  - **Gmail:** Last historyId.
  - **Outlook:** Last deltaLink (or delta token).
  - **iCloud/IMAP:** Last UIDNEXT and UIDVALIDITY per folder.
- Store in local database (SQLite) or JSON file, encrypted per above.

**Schema Example (SQLite):**
```sql
CREATE TABLE sync_state (
  provider TEXT,  -- 'gmail', 'outlook', 'icloud', 'imap_example.com'
  user_id TEXT,   -- Provider-specific user ID or email
  account_id TEXT,  -- For multi-account: email address or unique account ID
  last_cursor TEXT,  -- historyId, deltaLink, UIDNEXT, etc. (JSON-encoded)
  last_sync_time TIMESTAMP,
  PRIMARY KEY (provider, user_id, account_id)
);
```

**Incremental Sync:**
- On app startup or every N minutes (default 30–60), load the last cursor.
- Call the provider's delta/history API with that cursor.
- Process new/changed messages.
- Store new cursor.

---

## COMMON: Message Redaction Before Jev.ai

### Redaction Rules (from 03-jev-contract.md)

Before constructing the jev.ai request, redact sensitive data on device (codes and reset/verify links are never sent to jev.ai):

**Standalone 4–8 Digit Codes:**
- Replace `[0-9]{4,8}` (with optional spaces or hyphens, e.g., `123456`, `123 456`, `12-34-56`) with `[CODE]`.
- Apply to: Subject line, Body snippet (first 500 chars).
- Redaction fails gracefully: if regex engine fails, route message to Needs review (do not send to jev.ai).

**Reset/Verify Link Tokens:**
- Replace URLs with `/reset`, `/verify`, `/confirm`, `/signin`, `/magic-link` in the path with `[LINK]`.
- Replace long opaque tokens (≥16 URL-safe characters) and query parameters `token`, `code`, `key`, `sig` with `[LINK]`.
- Apply to: Subject line, Body snippet.

**Never Redact:**
- Deterministic Auth detection runs on the ORIGINAL, unredacted text (on device, before redaction).
- All local regex checks (never-junk gate, receipt/bill patterns, reply history) use unredacted text.

### Implementation

```python
def redact_for_jev(subject: str, snippet: str) -> tuple[str, str]:
    """
    Redact codes and reset/verify links from subject and snippet.
    Returns (redacted_subject, redacted_snippet).
    If redaction fails, returns (None, None) to signal route-to-Needs-review.
    """
    try:
        # Redact standalone 4-8 digit codes (with optional spaces/hyphens)
        redacted_subject = re.sub(r'\b\d[\d\s\-]{2,6}\d\b', '[CODE]', subject)
        redacted_snippet = re.sub(r'\b\d[\d\s\-]{2,6}\d\b', '[CODE]', snippet)
        
        # Redact reset/verify/confirm/signin URLs and long tokens
        redacted_subject = re.sub(
            r'https?://[^\s]+/(reset|verify|confirm|signin|magic-link)[^\s]*|(?<=[?&])(?:token|code|key|sig)=[^\s&]+',
            '[LINK]',
            redacted_subject,
            flags=re.IGNORECASE
        )
        redacted_snippet = re.sub(
            r'https?://[^\s]+/(reset|verify|confirm|signin|magic-link)[^\s]*|(?<=[?&])(?:token|code|key|sig)=[^\s&]+',
            '[LINK]',
            redacted_snippet,
            flags=re.IGNORECASE
        )
        
        return redacted_subject, redacted_snippet
    except Exception as e:
        log_error(f"Redaction failed: {e}")
        return None, None  # Signal caller to route to Needs review
```

---

## COMMON: Never-Junk Gate Application (Across All Providers)

The never-junk gate (02-never-junk.md) runs locally on device, the same way for every provider:

### Order of Operations

1. **Fetch message** from provider (Gmail, Outlook, iCloud, IMAP).
2. **Extract headers** and body snippet (provider-specific adapter).
3. **Truncate snippet** to 500 chars.
4. **Deterministic Auth detection** (unredacted text): regex + keywords on headers, subject, body. If match → Auth bucket (skip jev.ai).
5. **Allowlist check** (unredacted From address): if in allowlist → normal classification (skip Junk gate).
6. **Redact codes and links** (on Subject and Snippet only).
7. **Call jev.ai** with redacted fields (if Auth not yet detected).
8. **Apply Junk gate** (with all backstops: Auth no >=90, security-shape hit, sender-history guard, receipt/bill exception, reply-history exception).
9. **File to Auth / Junk / category / Needs review**.
10. **Move to provider's bucket** (via adapter: add Gmail label, use Outlook move endpoint, IMAP COPY, etc.).

### Junk Bucket Fallback

If the Jev Junk bucket cannot be created (permissions, name clash, folder limits):

1. Try to create Needs review bucket instead.
2. If that also fails, leave mail in place (do not move) but apply an in-app label/tag "Junk" (visual indicator only).
3. Log the failure and notify user in Settings: "Could not create Junk folder; mail is marked in-app but not moved."

### Provider-Specific Handling

**Gmail:**
- If `moveToBucket('junk', messageId)` fails: try `moveToBucket('needs_review', messageId)`.
- If that also fails: add label `Jev/pending-junk` (local tag; user can manually move later).

**Outlook:**
- If folder creation fails: use a special "Jev Junk (fallback)" folder or fall back to Needs review folder.

**iCloud/IMAP:**
- If IMAP folder creation fails: use "Needs review" folder instead.
- Log the error and notify user.

---

## COMMON: Provider Capability Table

| Feature | Gmail | Outlook | iCloud | Generic IMAP |
|---------|-------|---------|--------|--------------|
| **Authentication** | OAuth 2.0 | OAuth 2.0 | App password (no OAuth) | Password or XOAUTH2 |
| **Scope/Permission** | gmail.modify | Mail.ReadWrite, offline_access | Requires 2FA on Apple Account | User-provided |
| **Labels/Folders** | Labels (no folders) | Folders (hierarchy) | IMAP folders | IMAP folders |
| **Move Mechanism** | Add label, remove INBOX | Folder move endpoint | IMAP MOVE, else COPY + `$JevMoved` flag (no expunge) | IMAP MOVE, else COPY + `$JevMoved` flag (no expunge) |
| **Push Notifications** | Pub/Sub watch (7-day renew) | Webhooks (70-hour renew) | Not supported | Not supported |
| **Sync Method (Primary)** | History IDs + Pub/Sub | Delta queries + webhooks | IDLE or UID polling | IDLE or UID polling |
| **Sync Method (Fallback)** | Polling history IDs | Polling delta queries | UID polling | UID polling |
| **IDLE Support** | No | No | Yes (if available) | Yes (if advertised) |
| **Rate Limits** | 25 queries/sec (quota tokens) | Dynamic; watch quota | Varies by region | Varies by provider |
| **Credential Renewal** | Refresh token (7 days testing, 6 months prod) | Refresh token (~90 days) | None (password valid indefinitely) | None (password valid) |
| **Redaction (Before Jev.ai)** | Codes and links on device | Codes and links on device | Codes and links on device | Codes and links on device |
| **Never-Junk Gate** | Apply locally; never auto-move to SPAM | Apply locally; never auto-move to Junk Email | Apply locally; never auto-move to Junk | Apply locally; never auto-move to \Junk |
| **Can Create Custom Buckets** | Yes (labels) | Yes (folders) | Yes (folders) | Yes (folders) if permissions allow |
| **Multi-Account Support** | Yes | Yes | Yes (via multiple iCloud emails) | Yes (multiple servers/accounts) |
| **Auth Mail Safety** | Deterministic + jev.ai; never move to SPAM | Deterministic + jev.ai; never move to Junk Email | Deterministic + jev.ai; never move to Junk | Deterministic + jev.ai; never move to \Junk |

---

## COMMON: Implementation Checklist

- [ ] Implement MailAdapter interface for each provider (Gmail, Outlook, iCloud, generic IMAP).
- [ ] Gmail:
  - [ ] OAuth 2.0 flow (authorization code, token refresh).
  - [ ] Implement `authenticate()` with testing-status warning (7-day refresh token caveat).
  - [ ] Label creation and mapping (Auth, Junk, Needs review, categories).
  - [ ] `moveToBucket()` via label operations (add label, remove INBOX).
  - [ ] History API sync with `historyId`.
  - [ ] Pub/Sub watch setup (7-day renewal); polling fallback.
  - [ ] Never move to Gmail SPAM label automatically.
- [ ] Outlook:
  - [ ] OAuth 2.0 via MSAL.
  - [ ] Implement `authenticate()` with Mail.ReadWrite and offline_access scopes.
  - [ ] Folder creation and hierarchy mapping.
  - [ ] `moveToBucket()` via folder move endpoint.
  - [ ] Delta queries with `deltaLink`.
  - [ ] Webhook change notifications (70-hour renewal); polling fallback.
  - [ ] Never move to Outlook Junk Email folder automatically.
  - [ ] Document: no IMAP for Outlook.com / M365.
- [ ] iCloud:
  - [ ] IMAP authentication with app-specific password.
  - [ ] User-facing setup instructions (exact copy for account.apple.com flow).
  - [ ] Require 2FA; document in UI.
  - [ ] IMAP folder creation and mapping.
  - [ ] IDLE support (if available); UID polling fallback.
  - [ ] UIDVALIDITY handling (resync on change).
  - [ ] Document iCloud IMAP limitations.
  - [ ] Never move to iCloud Junk folder automatically.
- [ ] Generic IMAP:
  - [ ] User-provided server config (host, port, TLS mode, credentials).
  - [ ] Autodiscover hints for common providers (optional).
  - [ ] Certificate validation; self-signed cert warning.
  - [ ] XOAUTH2 detection and fallback to password.
  - [ ] Folder discovery via LIST and special-use attributes.
  - [ ] IDLE support; UID polling fallback.
  - [ ] UIDVALIDITY handling.
  - [ ] Folder creation with fallback to Needs review.
  - [ ] Never move to provider's \Junk folder automatically.
- [ ] Credentials:
  - [ ] Store encrypted in OS keychain (macOS, Windows, Linux) or encrypted file.
  - [ ] Implement token refresh for Gmail and Outlook.
  - [ ] Implement token revocation on disconnect.
  - [ ] Support multi-account per provider.
  - [ ] Never log credentials or tokens in plaintext.
- [ ] Sync and Cursors:
  - [ ] Implement sync_state table (or JSON store) to persist historyId, deltaLink, UIDNEXT per provider/account.
  - [ ] Incremental sync on startup and every 30–60 minutes.
  - [ ] Handle cursor expiry (if applicable).
- [ ] Message Redaction:
  - [ ] Implement redaction of 4–8 digit codes and reset/verify links on device.
  - [ ] Apply to Subject and Snippet before jev.ai request.
  - [ ] Route to Needs review if redaction fails.
  - [ ] Deterministic Auth detection on ORIGINAL (unredacted) text.
- [ ] Never-Junk Gate:
  - [ ] Run deterministic Auth detection (regex, keywords, allowlist) locally before jev.ai.
  - [ ] Apply Auth, Junk, and category confidence thresholds.
  - [ ] Implement Junk bucket fallback to Needs review.
  - [ ] Never auto-move to provider's spam folder.
  - [ ] For mail in provider's spam: offer read-only notice and reversible user-approved rescue.
  - [ ] Apply security-shape backstop and sender-history guard (per 02-never-junk.md).
- [ ] Testing:
  - [ ] Test OAuth flow (Gmail, Outlook) and IMAP auth (iCloud, generic).
  - [ ] Test label/folder creation and message move.
  - [ ] Test sync (history IDs, delta queries, IDLE, polling).
  - [ ] Test redaction (codes and links replaced with [CODE] and [LINK]).
  - [ ] Test never-junk gate: Auth mail never goes to Junk, even with high jev.ai junk confidence.
  - [ ] Test Junk bucket fallback: if creation fails, fall back to Needs review.
  - [ ] Test multi-account (two Gmail accounts, two Outlook accounts, etc.).
  - [ ] Test token refresh (for Gmail and Outlook) and expiry handling.

---

## Open Questions / Verify

The following facts may have changed since design; confirm before implementation:

1. **Gmail Pub/Sub watch renewal:** Spec says 7-day renewal required. Verify current Google Cloud Pub/Sub documentation for exact TTL and renewal window.
2. **Outlook webhook expiration:** Spec says max 70 hours (4230 minutes). Verify current Microsoft Graph documentation.
3. **iCloud IMAP rate limits:** Document any throttling policies (requests/minute, connections/hour) from Apple.
4. **iCloud IDLE reliability:** Test IDLE on iCloud IMAP in different regions; note if IDLE is unreliable and polling is recommended.
5. **Gmail testing-status refresh token TTL:** Spec says 7 days of inactivity. Verify if this applies to all test users or only specific test scopes.
6. **Gmail history API max lookback:** No documented limit; verify if historyId expires or if year-old history is still queryable.
7. **Outlook delta queries:** Spec says "max 4230 minutes"; verify if delta tokens themselves expire or only subscriptions.
8. **UIDVALIDITY change frequency:** How often do IMAP providers reset UID sequences? Test with Gmail IMAP, iCloud IMAP, and other providers.
9. **OAuth verification for Gmail public app:** Timeline and requirements for CASA security assessment; current bottlenecks.
10. **XOAUTH2 IMAP support:** Which providers advertise AUTH=XOAUTH2? (Gmail does via Gmail IMAP bridge; others?)
11. **Credential storage on web:** For a web-based app, keychain-based storage is not available. Plan encrypted local storage (IndexedDB, localStorage) or server-side token vault.
12. **Refresh token security:** Best practices for storing refresh tokens locally (hashed? salted? encrypted?). Consider secrets manager libraries (e.g., @aws-sdk/credential-providers).
13. **Multi-account Inbox UI:** Design decision: unified inbox (messages from all accounts) or per-account views?
14. **Provider-specific spam folder:** How to detect the provider's spam/junk folder reliably (special-use attributes, folder names, folder IDs)? Test with Gmail labels, Outlook folders, iCloud folders.

---

## Summary

Mail source integration is provider-specific at the transport layer (OAuth, IMAP, label APIs) but unified at the app layer via the MailAdapter interface. All providers apply the same never-junk gate and redaction rules on device. Credentials are encrypted locally and tokens are refreshed or revoked per provider. Sync uses push where available (Gmail Pub/Sub, Outlook webhooks) and falls back to polling (history IDs, delta queries, IDLE/UID polling). Junk bucket creation is attempted per provider; if it fails, the app falls back to Needs review. The never-junk gate ensures Auth mail is never auto-moved to the provider's spam folder, and codes and reset/verify links are redacted on device before jev.ai classification.
