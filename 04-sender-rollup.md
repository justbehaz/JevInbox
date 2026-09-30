# Jev Inbox Sender Rollup

## Overview

The sender rollup is a **local, read-only index** that groups messages by the From header address. It is **not a jev.ai category** and does **not count** toward the 48-category cap. Every message exists in both its assigned category/bucket AND the sender view simultaneously without being moved or duplicated.

Messages from the same address are grouped under a single sender profile. The UI displays a summary card per sender and an "All from this sender" detail view that lists every message from that sender across all buckets (Auth, Junk, Needs review, user categories, Other), each message labelled with its bucket or category assignment.

---

## Sender Key Normalisation

### Base Rule: Lowercased Email Address

The sender key is the **lowercased From address** (left of the `@` domain). Display name is secondary and used only for UI rendering.

```
From: John Smith <john@example.com>   →  Key: john@example.com   →  Display: "John Smith"
From: john@example.com                →  Key: john@example.com   →  Display: "" (empty)
From: JOHN@EXAMPLE.COM                →  Key: john@example.com   →  Display: "" (empty)
```

### Display Name Variants

The sender key groups all display-name variants of the same address under one sender. The UI shows the most recent non-empty display name (or "Unknown Sender" if all are empty).

```
From: John Smith <john@example.com>     (first message)
From: john@example.com                   (second message, no display name)
From: John Q Smith <john@example.com>    (third message)

Grouped under: john@example.com
Display: "John Q Smith" (most recent non-empty display name)
```

### Plus-Addressing Handling (Optional)

Plus-addressing (e.g., `user+tag@example.com`) can be handled in two ways per user preference, configurable in settings:

**Option A (Default): Normalise plus-addressing**
- Strip the `+` suffix and everything after it from the local part.
- `john+promo@example.com` → `john@example.com`
- Group all variants (`john@example.com`, `john+work@example.com`, `john+personal@example.com`) under one sender.

**Option B: Treat as distinct senders**
- Keep the full address including `+` suffix.
- `john@example.com`, `john+promo@example.com`, `john+work@example.com` are three separate senders.

**Implementation:** Add a toggle in User Settings: "Group plus-addressed variants". Default: enabled (Option A).

### Subdomain Handling (Optional)

Subdomains can be handled in one of three ways per user preference:

**Option 1 (Default): Full domain as-is**
- `noreply@mail.example.com` and `noreply@support.example.com` are distinct senders.

**Option 2: Normalise to root domain**
- `noreply@mail.example.com` → `noreply@example.com` (strip subdomains).
- `noreply@support.example.com` → `noreply@example.com` (same group).

**Option 3: Group by domain only (optional toggle)**
- Sender view includes a "Group by domain" toggle.
- When enabled, all addresses at `example.com` (any subdomain or local part) roll up under a single domain entry.
- Detail view still shows each distinct address under that domain.

**Implementation:** Add a checkbox in User Settings: "Normalise subdomains to root". Default: disabled (Option 1).

### Spoofing Caveat

**Display name is not secure.** The sender key is **always** the From address. The UI must **always display the full From address** prominently in the sender detail view and on sender action confirmations, because an attacker can set any display name:

```
From: "Apple Support" <attacker@malicious.com>
```

**UI Rule:** In the sender summary card, show:
- Display name (if present) in larger text.
- Full From address in smaller, distinct styling (not in parentheses; clearly separated).

Example:
```
┌────────────────────────────┐
│  Apple Support             │
│  attacker@malicious.com    │  ← Must always be visible
│  5 messages, 2 unread      │
└────────────────────────────┘
```

In the sender detail view (where actions like "Mark junk" are available):
```
Sender: Apple Support
Address: attacker@malicious.com
[Allow] [Mark junk] [Mute] [...]
```

---

## Data Model

### Sender Record (In-Memory Index)

Each sender is represented by a record in a local index:

```sql
CREATE TABLE sender_index (
  sender_key TEXT PRIMARY KEY,  -- lowercased from address
  display_name TEXT,             -- most recent non-empty From display name
  message_count INT,             -- total messages from this sender
  unread_count INT,              -- unread messages from this sender
  latest_date TIMESTAMP,         -- most recent message date (ISO 8601)
  first_date TIMESTAMP,          -- oldest message date (ISO 8601)
  
  -- Per-bucket and per-category counts
  auth_count INT,                -- messages in Auth bucket
  junk_count INT,                -- messages in Junk bucket
  needs_review_count INT,        -- messages in Needs review bucket
  
  -- Per-category counts (user categories only; up to 48 columns or JSON)
  cat_001_count INT, cat_002_count INT, ..., cat_036_count INT,
  -- Alternative: categories JSON: {"cat_001": 5, "cat_002": 2, ...}
  
  -- User actions on this sender
  allowlisted BOOLEAN,           -- user allowlisted this sender
  marked_junk BOOLEAN,           -- user marked this sender as junk (denylist)
  muted BOOLEAN,                 -- user muted this sender (hide from new-mail alert)
  
  -- Index metadata
  created_at TIMESTAMP,          -- when this sender first appeared
  updated_at TIMESTAMP           -- last time any count was updated
);
```

### Alternative: Category Counts as JSON

To avoid schema changes when user categories change, store per-category counts as JSON:

```sql
CREATE TABLE sender_index (
  sender_key TEXT PRIMARY KEY,
  display_name TEXT,
  message_count INT,
  unread_count INT,
  latest_date TIMESTAMP,
  first_date TIMESTAMP,
  
  auth_count INT,
  junk_count INT,
  needs_review_count INT,
  
  categories_json TEXT,          -- JSON: {"cat_001": 5, "cat_002": 2, "cat_003": 0, ...}
  
  allowlisted BOOLEAN,
  marked_junk BOOLEAN,
  muted BOOLEAN,
  
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

### Group-By Queries

**Summary (inbox view):**

```sql
SELECT
  sender_key,
  display_name,
  message_count,
  unread_count,
  latest_date,
  (auth_count + junk_count + needs_review_count + 
   SUM(categories_json['cat_001']::INT, ..., categories_json['cat_036']::INT)) AS total,
  allowlisted,
  marked_junk,
  muted
FROM sender_index
ORDER BY latest_date DESC;
```

**Detail view (all messages from one sender):**

```sql
SELECT
  m.message_id,
  m.date,
  m.subject,
  m.snippet,
  CASE
    WHEN m.bucket = 'auth' THEN 'Auth'
    WHEN m.bucket = 'junk' THEN 'Junk'
    WHEN m.bucket = 'needs_review' THEN 'Needs review'
    ELSE m.category
  END AS bucket_or_category,
  m.unread,
  m.starred
FROM messages m
WHERE m.from_address_normalized = ?  -- sender_key
ORDER BY m.date DESC;
```

**Per-sender category breakdown (stats):**

```sql
SELECT
  CASE
    WHEN m.bucket = 'auth' THEN 'Auth'
    WHEN m.bucket = 'junk' THEN 'Junk'
    WHEN m.bucket = 'needs_review' THEN 'Needs review'
    ELSE m.category
  END AS bucket_or_category,
  COUNT(*) AS count,
  COUNT(CASE WHEN m.unread THEN 1 END) AS unread_count
FROM messages m
WHERE m.from_address_normalized = ?  -- sender_key
GROUP BY bucket_or_category
ORDER BY count DESC;
```

---

## "All From This Sender" View

### Purpose

The sender detail view displays **every message from that sender** across **all buckets and categories** in a single, unified list. This is the user's single source of truth for that sender.

### Message List

Each row displays:

- **Date** (ISO 8601, right-aligned or compact).
- **Subject** (or preview if subject is empty).
- **Snippet** (first 100 characters of visible body, or snippet field if available).
- **Bucket/category badge** (small, color-coded label):
  - Auth → blue badge, "Auth"
  - Junk → red badge, "Junk"
  - Needs review → orange badge, "Needs review"
  - User categories → category color, category name (e.g., "Promotions").
- **Unread indicator** (dot, underline, or fill).
- **Star/flag indicator** (if starred by user).

Example:

```
┌─────────────────────────────────────────────────────────────┐
│ From: Apple Support (apple-support@apple.com)               │
│ 27 messages total, 3 unread                                 │
│                                                             │
│ Date        Subject                      Badge    Unread   │
│ ────────────────────────────────────────────────────────── │
│ Sep 28      Apple ID verification        Auth     ●        │
│ Sep 26      iCloud Storage Upgrade        Promo            │
│ Sep 20      Order Confirmation #123      Receipts          │
│ Sep 15      Your Receipt                  Receipts          │
│ Sep 10      Unusual Activity Alert        Auth     ●        │
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘
```

### Filters and Search

The detail view includes optional filters:

- **Filter by bucket/category:** "All", "Auth", "Junk", "Needs review", "Promotions", etc.
- **Unread only** checkbox.
- **Search within sender:** Quick search on subject/snippet.

Example filter control:

```
[All ▼] [Unread ☐] [Search...]
```

### Key Behavior: Dual Presence

A message **always appears in both its assigned category AND the sender view**, without being moved or duplicated. The message has one logical location (its bucket or category), but the sender view is a **read-only projection** of that address.

Example:
- Message from `promo@retailer.com` is classified into "Promotions" category.
- It appears in the "Promotions" view.
- It also appears in the "All from promo@retailer.com" sender view, labelled "Promotions".
- User can interact with it from either view (read, star, delete, move).
- Changing its category from "Promotions" to "Junk" updates both views immediately.

---

## Sender Actions

### Action: Allow Sender (Allowlist)

**Purpose:** Exempt this sender from Junk routing in the future. Forces mail into normal classification (by category or Auth).

**Behavior:**

1. **Future mail:** Sender is added to the user's allowlist (address or domain, per user choice).
   - `sys_junk` answer is ignored for this sender (no auto-junk).
   - Mail from this sender follows normal classification (Auth if Auth signal, else user category or Needs review).
   - User-defined denylist (mark junk) is removed if it was set (reset to neutral).

2. **Existing mail:** No retroactive move. Mail already in Junk, Needs review, or a category stays put.

3. **Auth rule:** Allowlisted mail that carries an Auth signal (deterministic or jev.ai ≥80%) still goes to Auth. Allowlist does not force mail out of Auth; it only blocks Junk.

**UI:**

```
[Allow] button in sender detail.

On click:
  Dialog: "Allow sender?"
  "This sender's messages will no longer be marked as junk. 
   They will be filed by category (e.g., Promotions, Receipts) 
   or to Needs review if we can't classify them."
  [Cancel] [Allow]

On success:
  Confirmation: "apple-support@apple.com is now allowlisted."
  [Undo] link (reverts allowlist in this session only).
```

**Database:**

```sql
UPDATE sender_index
SET allowlisted = true, marked_junk = false, updated_at = NOW()
WHERE sender_key = ?;

INSERT INTO allowlist (address, domain, added_at)
VALUES (?, NULL, NOW());  -- address='apple-support@apple.com'
```

### Action: Mark Sender Junk (Denylist)

**Purpose:** Opt out of mail from this sender. Future mail routes to Junk (review queue) unless it carries an Auth signal.

**Critical Rule: Mark sender junk NEVER overrides Auth.**

- **Auth mail from this sender always stays in Auth.** Even if the user marks the sender junk, security mail (OTP, password reset, login alert) routes to Auth and never goes to Junk.
- **Future mail:** No Auth signal → Junk. Auth signal detected → Auth.
- **Existing mail:** Non-Auth mail from this sender is optionally moved to Junk review queue (not silent delete). Existing Auth mail stays in Auth.
- **User communication:** The confirmation and the sender detail view must clearly explain this rule.

**Behavior:**

1. **User marks sender junk.** Sender is added to the user's denylist (address or domain).

2. **Future mail:**
   - Auth signal detected (deterministic, allowlist, or jev.ai ≥80%) → Auth (ignore denylist).
   - No Auth signal → Junk (review queue).

3. **Existing mail:**
   - Non-Auth mail from this sender: Optionally move to Junk review queue (batch operation, user confirms).
   - Auth mail from this sender: Stays in Auth. Not moved.

4. **Reversal:** User can "Unmark sender junk" to remove the denylist and restore normal classification.

**UI:**

```
[Mark junk] button in sender detail.

On click:
  Dialog: "Mark sender as junk?"
  
  "Sender: Apple Support (apple-support@apple.com)"
  
  "Messages from this sender will be moved to Junk. 
   IMPORTANT: Security alerts and password resets from this 
   sender will ALWAYS go to your Auth folder, not Junk. 
   You cannot silence security mail by marking a sender junk."
  
  "Existing messages:"
  [ ] Move 24 existing messages from this sender to Junk
      (15 Promotions, 9 Receipts)
      [Note: 3 Auth messages will stay in Auth]
  
  [Cancel] [Mark junk]

On success:
  Confirmation: "apple-support@apple.com is now marked junk.
                  Auth mail from this sender will still come through.
                  Future mail will go to Junk. [Undo]"
```

**Database:**

```sql
UPDATE sender_index
SET marked_junk = true, allowlisted = false, updated_at = NOW()
WHERE sender_key = ?;

INSERT INTO denylist (address, domain, added_at)
VALUES (?, NULL, NOW());  -- address='apple-support@apple.com'

-- Optionally update existing messages (not Auth):
UPDATE messages
SET bucket = 'junk'
WHERE from_address_normalized = ? 
  AND bucket != 'auth'  -- Auth mail stays in Auth
  AND deleted_at IS NULL;
```

### Action: Unmark Sender Junk (Reverse Denylist)

**Purpose:** Remove the junk mark and restore normal classification for this sender.

**Behavior:**

1. Sender is removed from denylist.
2. Future mail follows normal classification (Auth if Auth signal, else category or Needs review).
3. Existing mail in Junk stays in Junk (not retroactively moved back).

**UI:**

```
[Marked junk] (status indicator in sender view when marked_junk = true)

[Unmark junk] button appears when sender is marked junk.

On click:
  Dialog: "Remove junk mark?"
  "apple-support@apple.com will no longer be marked as junk. 
   Future messages will be filed normally."
  [Cancel] [Unmark]

On success:
  "Junk mark removed. Future mail will be classified normally."
```

**Database:**

```sql
UPDATE sender_index
SET marked_junk = false, updated_at = NOW()
WHERE sender_key = ?;

DELETE FROM denylist
WHERE address = ?;
```

### Action: Mute Sender

**Purpose:** Hide new-mail alerts from this sender (but keep mail in inbox/categories).

**Behavior:**

1. When mail from this sender arrives, no desktop notification, banner, or badge count increment is shown.
2. Mail is still classified and delivered to its category/bucket.
3. The sender view still shows new messages (but without triggering alerts).

**UI:**

```
[Mute] or [Muted] (toggle) button in sender detail.

On click:
  [Mute this sender] or [Unmute this sender] (dialog or inline toggle).

Status indicator:
  ≈ "Muted" (bell icon with slash) next to sender name if muted = true.
```

**Database:**

```sql
UPDATE sender_index
SET muted = true, updated_at = NOW()
WHERE sender_key = ?;

-- Or toggle:
UPDATE sender_index
SET muted = NOT muted, updated_at = NOW()
WHERE sender_key = ?;
```

---

## Search

### Sender Discovery

The sender view is discoverable via:

1. **Inbox summary:** Click on a sender card to open the detail view.
2. **Global search:** Search by sender name or address.
   - Query: "apple" → Returns "Apple Support <apple-support@apple.com>".
   - Query: "apple-support@apple.com" → Returns exact sender.
3. **Category detail view:** Each message shows the sender name/address with a clickable link to the sender detail view.

### No Second Classifier

**Sender view is NOT a classifier.** It is a **local index** on the From header. There is no jev.ai call, no confidence scoring, and no category assignment for the sender rollup itself. Sender grouping is deterministic.

---

## Index and Performance

### Build and Maintenance

**Index Construction:**

1. **Build on first load:** When the app starts, scan all messages and build the `sender_index` table from the messages.
2. **Incremental update:** On new message arrival:
   - Normalise the From address (apply normalisation rules above).
   - Upsert sender record: increment counts, update `display_name` (if non-empty and more recent), update `latest_date`.
   - Update per-category counts based on the message's assigned bucket/category.
   - Update `updated_at` timestamp.

**Example:**

```python
def upsert_sender(message):
    sender_key = normalise_email(message.from_address)
    display_name = message.from_display_name
    bucket_or_category = message.bucket or message.category
    is_unread = message.unread
    
    # Fetch current record
    row = db.query_one(
        "SELECT * FROM sender_index WHERE sender_key = ?",
        sender_key
    )
    
    if row:
        # Increment counts
        db.execute("""
            UPDATE sender_index
            SET message_count = message_count + 1,
                unread_count = unread_count + ?,
                latest_date = ?,
                {bucket_or_category}_count = {bucket_or_category}_count + 1,
                display_name = ?,
                updated_at = NOW()
            WHERE sender_key = ?
        """, (
            1 if is_unread else 0,
            message.date,
            display_name or row['display_name'],
            sender_key
        ))
    else:
        # Insert new sender
        db.execute("""
            INSERT INTO sender_index
            (sender_key, display_name, message_count, unread_count, latest_date, first_date,
             auth_count, junk_count, needs_review_count, ..., created_at, updated_at)
            VALUES (?, ?, 1, ?, ?, ?, ...)
        """, (
            sender_key,
            display_name,
            1 if is_unread else 0,
            message.date,
            message.date,
            ...
        ))
```

### Index Queries

**Indexes to create:**

```sql
CREATE INDEX idx_sender_latest_date ON sender_index(latest_date DESC);
CREATE INDEX idx_sender_marked_junk ON sender_index(marked_junk);
CREATE INDEX idx_sender_allowlisted ON sender_index(allowlisted);
CREATE INDEX idx_sender_muted ON sender_index(muted);

-- For message lookup by sender:
CREATE INDEX idx_messages_sender_normalized ON messages(from_address_normalized);
CREATE INDEX idx_messages_sender_date ON messages(from_address_normalized, date DESC);
CREATE INDEX idx_messages_sender_unread ON messages(from_address_normalized, unread);
```

### Performance Characteristics

**Sender summary (inbox view):**
- Query: ~O(n) where n = number of senders.
- Expected: <50 ms for 10,000 senders (typical user).
- Pagination: Load 50 senders per page, lazy-load on scroll.

**Sender detail (all messages from one sender):**
- Query: ~O(m) where m = messages from that sender.
- Expected: <10 ms for 100 messages from one sender.
- Pagination: Load 50 messages per page.

**Sender update (new message arrival):**
- Upsert: ~O(1) indexed lookup + single UPDATE.
- Expected: <5 ms per message.

**Search (by sender name or address):**
- Full-text search on display_name and sender_key.
- Expected: <100 ms for 10,000 senders (depends on search library).

### Caching

- **Sender summary:** Cache in memory, invalidate on:
  - New message arrival from any sender.
  - User marks/unmarks sender as junk or allows sender.
  - User mutes/unmutes sender.
  - User marks message read/unread.

- **Sender detail (all messages from one sender):** Paginated query, no caching (or cache with short TTL, <5 min).

---

## Spoofing and Display Safety

### Display-Name Spoofing Risk

**The From display name can be spoofed by attackers:**

```
From: "PayPal Support" <attacker@malicious.com>
From: "Amazon Order Confirmation" <attacker@malicious.com>
```

**Mitigation:**

1. **Always display the From address prominently.** The address is the primary identifier.
2. **Never use display name alone** to determine sender identity or trust.
3. **In the sender detail view**, show the full From address in a distinct, non-editable field.
4. **In the sender summary card**, show display name (if present) and full address as separate fields.
5. **In action confirmations** (mark junk, allow, mute), repeat the full address so the user can verify they are acting on the correct sender.

### Example UI (Safe Rendering)

```
Sender Summary Card:
┌────────────────────────────────┐
│  PayPal Support                │  ← Display name (can be spoofed)
│  attacker@malicious.com        │  ← Address (canonical key)
│  5 messages, 2 unread          │
└────────────────────────────────┘

Sender Detail View:
┌────────────────────────────────────────────┐
│ All messages from this sender              │
│                                            │
│ Name:     PayPal Support                   │
│ Address:  attacker@malicious.com           │
│           (This is the sender key)         │
│                                            │
│ [Allow] [Mark junk] [Mute] [...]           │
└────────────────────────────────────────────┘

Confirmation Dialog (Mark Junk):
┌────────────────────────────────────────────┐
│ Mark sender as junk?                       │
│                                            │
│ Sender:  attacker@malicious.com            │
│ (Claimed: PayPal Support)                  │
│                                            │
│ [...confirmation text...]                  │
│                                            │
│ [Cancel] [Mark junk]                       │
└────────────────────────────────────────────┘
```

---

## Never-Junk Rule: Mark Sender Junk Does Not Override Auth

### Core Guarantee

**If a message carries an Auth signal (deterministic, allowlist, or jev.ai ≥80%), it is routed to Auth regardless of whether the user has marked the sender junk.**

### Examples

| Scenario | Sender Mark | Auth Signal | Result | Reasoning |
|----------|-------------|-------------|--------|-----------|
| OTP from Google, user marked Google junk | Junk | Deterministic | Auth | Auth always wins. |
| Magic link from GitHub, user marked GitHub junk | Junk | Deterministic | Auth | Auth always wins. |
| Login alert from bank, user marked bank junk | Junk | Jev.ai ≥80% | Auth | Auth always wins. |
| Promo from retailer, user marked retailer junk | Junk | No | Junk | No Auth signal. Denylist applies. |
| Receipt from Uber, user marked Uber junk | Junk | No | Junk | No Auth signal. Denylist applies. |

### User Communication

In the "Mark sender junk" dialog:

```
"IMPORTANT: Security alerts and password resets from this 
 sender will ALWAYS go to your Auth folder, not Junk. 
 You cannot silence security mail by marking a sender junk."
```

In the sender detail view (if sender is marked junk):

```
Status: [Marked junk]
Note: Auth mail from this sender still comes through.
```

In the FAQ or help article:

**Q: Can I silence security mail by marking a sender as junk?**

A: No. Security mail (authentication codes, password resets, login alerts) is always routed to your Auth folder, even if you mark that sender as junk. This protects your account from being locked out. If you believe the security mail is fraudulent, report it to the provider or mark the original domain as untrusted in your security settings. Do not rely on the "mark junk" feature to block legitimate security mail.

---

## Implementation Checklist

- [ ] Design and implement sender key normalisation (lowercased address, display name merging).
- [ ] Implement plus-addressing and subdomain normalisation options (toggles in User Settings).
- [ ] Design sender_index table schema (or JSON alternative for categories).
- [ ] Implement incremental sender index updates on new message arrival.
- [ ] Build sender summary view (list of senders, sorted by latest date, with counts and badges).
- [ ] Build sender detail view (all messages from one sender, paginated, with filters).
- [ ] Implement bucket/category badge rendering in sender detail view.
- [ ] Implement sender actions: Allow, Mark junk, Unmark, Mute.
- [ ] Implement "Mark junk" retroactive logic: move non-Auth mail to Junk, keep Auth mail in Auth.
- [ ] Add confirmation dialogs with full sender address prominently displayed.
- [ ] Implement search by sender name and address.
- [ ] Add indexes for sender summary and detail queries.
- [ ] Test Auth override: verify Auth mail from a marked-junk sender stays in Auth.
- [ ] Test dual presence: verify message appears in both category and sender view.
- [ ] Add spoofing caveat to UI: always display full address.
- [ ] Monitor sender index performance: query latency, memory usage for large sender lists.
- [ ] Document never-junk rule in user FAQ.

---

## Summary

The sender rollup is a deterministic, local index on the From header. It groups all messages from the same address under one sender profile, without counting toward the 48-category cap. The "All from this sender" view displays every message from that sender across all buckets and categories, each labelled with its current bucket or category. User actions (allow, mark junk, mute) are applied per sender with clear confirmation dialogs that display the full From address to prevent spoofing confusion. The critical rule: marking a sender as junk never overrides Auth mail from that sender. Auth always routes to the Auth bucket, keeping security mail accessible to the user.
