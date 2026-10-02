# Jev Inbox Web App Screen Spec

## Overview

This document specifies the user-facing screens and interactions for Jev Inbox, a web mail app that classifies messages into user-defined categories, protects authentication mail, and provides a junk review queue. All screens must enforce the never-junk safety gate: Auth mail is never rendered in Junk, and users cannot move Auth mail to Junk.

**Core rules enforced in UI:**
- Auth mail (system bucket) is never visible in Junk view.
- Manual move of Auth mail to Junk is blocked with explanation.
- Bulk move to Junk skips Auth messages and notifies the user.
- Junk is a review queue with three actions: Keep, Mark junk (denylist), Allow sender.
- User categories cap at 48 (36 defaults + 12 custom max; disabled categories count until deleted).
- Disabled categories count toward the 48-category limit.
- Sender view is a local read-only index (not a category, not counted in cap).

---

## 1. Sidebar / Navigation

### Layout

Left sidebar on desktop (width: 260–280 px), collapsible on tablet/mobile.

```
┌─────────────────────────┐
│  ≡ Jev Inbox            │  ← Header with menu icon
├─────────────────────────┤
│  📧 INBOX               │  ← Summary view (optional)
├─────────────────────────┤
│  🔐 Auth                │
│  📁 Categories      ▼   │
│    • Personal & Family  │
│    • Work               │
│    • Finance            │
│    [+10 more...]        │  ← Collapsible subcategories
├─────────────────────────┤
│  🚫 Junk                │  ← Count badge: "Junk (5)"
│  ⚠️  Needs review       │  ← Count badge: "Review (3)"
│  👥 Senders             │
├─────────────────────────┤
│  ⚙️  Settings            │
│  ❓ Help                 │
└─────────────────────────┘
```

### Components

- **Logo/app name:** "Jev Inbox" at top.
- **Main sections:**
  - Auth (count badge showing unread or total).
  - Categories (collapsible/expandable list).
    - Defaults shown (e.g., Personal & Family, Work, Finance).
    - "[+N more]" if user has >5 categories. Click to expand or "Manage categories" link.
  - Junk (count badge).
  - Needs review (count badge).
  - Senders (no count; live index).
- **Footer:** Settings, Help.

### States

- **Active section:** Highlighted/bold.
- **Unread count:** Badge (e.g., "Junk (5)" means 5 unread in Junk).
- **Collapsed categories:** Show "[+N more]" with expand arrow.

### Accessibility

- Semantic HTML: `<nav>`, `<ul>`, `<li>` for list structure.
- ARIA labels: `aria-label="Navigation"`, `aria-current="page"` for active section.
- Keyboard: Tab/arrow keys to navigate sections, Enter to select.

---

## 2. Main Inbox View (Summary by Sender)

### Layout

After selecting a section (e.g., "Inbox" or "Personal & Family"), display a list of senders grouped by most recent message date.

```
┌──────────────────────────────────────────────────────┐
│ Personal & Family > Inbox                            │
├──────────────────────────────────────────────────────┤
│ [Search senders] [Sort ▼] [Filter ▼] [Select all ☐] │
├──────────────────────────────────────────────────────┤
│                                                       │
│ ┌────────────────────────────────────────┐ Sep 28 15:30 │
│ │ ☐ Apple Support                        │ ●          │
│ │    apple-support@apple.com             │            │
│ │    2 messages, 1 unread                │            │
│ └────────────────────────────────────────┘            │
│                                                       │
│ ┌────────────────────────────────────────┐ Sep 26 10:45 │
│ │ ☐ Amazon Orders                        │            │
│ │    order@amazon.com                    │            │
│ │    5 messages                          │            │
│ └────────────────────────────────────────┘            │
│                                                       │
│ ┌────────────────────────────────────────┐ Sep 20     │
│ │ ☐ GitHub Notifications                 │            │
│ │    notifications@github.com            │            │
│ │    12 messages                         │            │
│ └────────────────────────────────────────┘            │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Components

- **Header:** Breadcrumb (e.g., "Personal & Family > Inbox") or section name.
- **Controls:**
  - Search box (search by sender name or address).
  - Sort dropdown (Latest, Oldest, Sender A–Z, Unread count).
  - Filter dropdown (Unread, Read, Has attachments, Starred).
  - Select all checkbox (for bulk actions).
- **Sender card (per sender):**
  - Checkbox (select for bulk actions).
  - Sender name (or "Unknown Sender" if empty).
  - Full From address (below name, smaller, distinct styling).
  - Count: "N messages, M unread" or "N messages".
  - Date of most recent message (right-aligned).
  - Unread indicator (dot/circle if unread messages).
- **Empty state:** "No messages in this category. Start by checking Needs review or Senders."

### Interactions

- **Click sender card:** Open "All from this sender" detail view.
- **Checkbox + bulk action menu:** Select multiple senders, then show bulk actions (e.g., "Mark junk", "Move to category").
- **Sort/filter:** Reorder or filter senders.
- **Search:** Debounced search on sender name and address (local, in-browser).

### States

- **Unread sender:** Display unread indicator (filled circle or dot).
- **Read sender:** No indicator.
- **Selected sender:** Checkbox checked, card highlighted.
- **Hovering sender:** Subtle background highlight.
- **Loading:** Spinner in place of sender list; "Loading senders...".
- **Error:** "Failed to load senders. Please refresh." with retry button.

### Accessibility

- Semantic HTML: `<section>`, `<article>` for sender card.
- ARIA labels: `role="checkbox"` for select checkboxes, `aria-label="Select sender from [address]"`.
- Keyboard: Tab through cards, Enter to select/open, Space to toggle checkbox.
- Focus visible: Blue outline on focused card.

---

## 3. Message List View (All From This Sender)

### Layout

Opened when user clicks on a sender card from the inbox summary. Displays every message from that sender across all buckets and categories.

```
┌──────────────────────────────────────────────────────┐
│ < Back to Personal & Family                          │
├──────────────────────────────────────────────────────┤
│ Apple Support                                        │
│ apple-support@apple.com                              │
│ 27 messages total, 3 unread                          │
├──────────────────────────────────────────────────────┤
│ [All ▼] [Unread ☐] [Search...] [⭐ ☐] [Select all ☐] │
├──────────────────────────────────────────────────────┤
│                                                       │
│ ☐ ⭐ Sep 28  Apple ID verification         [Auth] ●  │
│ ☐    Sep 26  iCloud Storage Upgrade        [Promo]   │
│ ☐    Sep 20  Order Confirmation #123       [Receipt] │
│ ☐    Sep 15  Your Receipt                  [Receipt] │
│ ☐ ⭐ Sep 10  Unusual Activity Alert        [Auth] ●  │
│ ☐    Sep 5   Thank you for your order      [Promo]   │
│ ☐    Aug 30  Shipped: Order #456           [Shipping]│
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Header Section

- **Back link:** "< Back to [category name]".
- **Sender identity (above message list):**
  - Sender name (large text).
  - Full From address (smaller, distinct styling, below name).
  - Total message count and unread count.
- **Sender actions (buttons or dropdown):**
  - [Allow] — Allowlist this sender (exempt from Junk).
  - [Mark junk] — Denylist this sender (future mail → Junk, unless Auth).
  - [Mute] or [Unmuted] — Toggle mute on new-mail alerts.
  - [...] — More options (e.g., Block domain, Report phishing).

### Message List

- **Columns:**
  - **Checkbox:** Select message for bulk actions.
  - **Star icon:** Toggle star/flag.
  - **Date:** ISO 8601 or relative (e.g., "Sep 28", "Today", "2 days ago").
  - **Subject:** Full subject line (or preview if empty).
  - **Snippet:** First ~60–80 characters of visible body (or empty if no body).
  - **Badge:** Bucket or category (Auth, Junk, Needs review, or category name) in color-coded label.
  - **Unread indicator:** Filled circle or dot if unread.

### Filters (Above Message List)

- **Bucket/category filter:** Dropdown showing "All", "Auth", "Junk", "Needs review", and user-enabled categories. Default: "All".
- **Unread checkbox:** "Unread only" toggle.
- **Star checkbox:** "Starred only" toggle.
- **Search:** Text box for quick search within this sender's messages (searches subject and snippet).

### Interactions

- **Click message row:** Open message detail view (see section 4).
- **Checkbox:** Select message for bulk actions.
- **Star icon:** Toggle star on message.
- **Bulk actions (after selecting ≥1 message):**
  - "Mark as read/unread".
  - "Delete" (soft delete, moved to trash/deleted items).
  - "Move to category" — Show category list; moving Auth mail is blocked with explanation (see below).
  - "Mark junk" — For Needs review or category; blocked for Auth with explanation.
- **Sender actions ([Allow], [Mark junk], [Mute]):** See section 6 (Sender Actions) for dialog details.

### States

- **Auth message in selection:** When bulk action is triggered (e.g., "Move to Junk"):
  - Dialog displays: "1 message is security mail (Auth) and cannot be moved to Junk. Moving 24 other messages."
  - Auth message is skipped; bulk action applies to others.
  - Confirmation shows count: "Moved 24 messages. 1 Auth message stays in Auth."
- **Loading:** Spinner; "Loading messages from this sender...".
- **Error:** "Failed to load messages. Please refresh." with retry button.
- **Empty (no messages):** "No messages from this sender in this view. (Try changing the filter.)"

### Accessibility

- Semantic HTML: `<main>`, `<article>` per message, `<button>` for actions.
- ARIA labels: `aria-label="Message from [sender] on [date]: [subject]"`, `aria-label="Security mail (Auth)"` for Auth badge.
- Keyboard: Tab through message rows, Enter/Space to select, arrow keys to navigate.
- Focus visible: Blue outline on focused message row.

---

## 4. Message Detail View

### Layout

Opened when user clicks a message from the message list or from a category view.

```
┌──────────────────────────────────────────────────────┐
│ < Back to Inbox                                      │
├──────────────────────────────────────────────────────┤
│                                                       │
│ From:    Apple Support <apple-support@apple.com>    │
│ Date:    Sep 28, 2026 at 3:30 PM                     │
│ Subject: Apple ID verification                      │
│                                                       │
│ Category: [Auth]  ← Badge, immutable for Auth       │
│ Confidence: 98%   ← Shown for user categories       │
│ Why filed: "This message contains an authentication │
│            code and password reset link, which are   │
│            security-critical."                       │
│                                                       │
│ [⭐ Star] [Mark as read] [Delete] [Move to...] [...] │
│                                                       │
├──────────────────────────────────────────────────────┤
│                                                       │
│ [Message body, rendered as-is or sanitized HTML]    │
│                                                       │
│ ... (full email content) ...                         │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Header Section

- **Back link:** "< Back to [section name]".
- **Sender info:**
  - From: Full display name and email address.
  - Date: Formatted date/time.
  - Subject: Full subject line.
- **Category badge and explanation:**
  - **Auth bucket:** Immutable badge "Auth" (blue). No explanation; user knows this is security mail.
  - **Junk bucket:** Badge "Junk" (red). "This message was identified as probable spam or abuse."
  - **Needs review bucket:** Badge "Needs review" (orange). "This message couldn't be classified with confidence. You can move it to a category or delete it."
  - **User category:** Badge with category name and color. "Confidence: 98%". Explanation line: "Why filed: This message matches the [Category Name] category because [reason based on jev.ai].".
- **Action buttons:**
  - [⭐ Star] — Toggle star.
  - [Mark as read/unread] — Toggle read status.
  - [Delete] — Soft delete (move to trash).
  - [Move to category ▼] — Dropdown to move to a different bucket/category.
    - **If Auth:** Button is grayed out or absent. Tooltip: "Security mail cannot be moved from Auth."
  - [...] — More options (Report phishing, View headers, etc.).

### Message Body

- Render HTML-sanitized email body or plain text, as-is.
- Display inline images.
- Sanitize links and scripts (no execution).
- Show attachments (with download links, no execution).

### States

- **Auth message:** Category badge is immutable; "Move to" button is disabled; message is read-only in placement.
- **Unread message:** "Mark as read" button shown; unread indicator visible in header.
- **Read message:** "Mark as unread" button shown.
- **Loading:** Spinner; "Loading message...".
- **Error:** "Failed to load message. Please refresh." with retry button.

### Accessibility

- Semantic HTML: `<article>`, `<header>`, `<section>` for message body.
- ARIA labels: `aria-label="Message from [sender] on [date]"`, `aria-label="Category: [name]"`, `aria-label="Security mail (Auth) - cannot be moved"`.
- Keyboard: Tab through buttons, Enter to activate, arrow keys for next/previous message (optional).
- Focus visible: Blue outline on buttons.

---

## 5. Category View

### Layout

Opened when user clicks on a category in the sidebar (e.g., "Promotions", "Work").

```
┌──────────────────────────────────────────────────────┐
│ Promotions > Inbox                                   │
├──────────────────────────────────────────────────────┤
│ [Search messages] [Sort ▼] [Filter ▼] [Select all ☐]│
├──────────────────────────────────────────────────────┤
│                                                       │
│ From: Apple Support                                  │
│ ┌──────────────────────────────────────────┐         │
│ │ Apple ID verification      [Auth]  ●     │ Sep 28  │
│ │ apple-support@apple.com                  │         │
│ └──────────────────────────────────────────┘         │
│                                                       │
│ From: Amazon Orders                                  │
│ ┌──────────────────────────────────────────┐         │
│ │ Flash Sale: 50% Off Everything [Promo]  │ Sep 26  │
│ │ promo@amazon.com                         │         │
│ └──────────────────────────────────────────┘         │
│                                                       │
│ ...                                                   │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Components

- **Header:** Category name (e.g., "Promotions").
- **Controls:**
  - Search box (search by sender, subject).
  - Sort dropdown (Latest, Oldest, Sender A–Z).
  - Filter dropdown (Unread, Read, Has attachments, Starred).
  - Select all checkbox.
- **Message list (by sender):**
  - Grouped by From address (sender).
  - Each message shows: sender name, subject/snippet, category badge, date, unread indicator.
  - Can also be displayed as a flat list without grouping (UX decision).
- **Bulk actions:** Select multiple messages, then show menu (Mark as read, Delete, Move to category, Mark junk).

### Interactions

- **Click message:** Open message detail view.
- **Click sender group header:** Open "All from this sender" view filtered to this category (optional).
- **Bulk actions:** Same as message list view (see section 3).

### States

- **Empty category:** "No messages in [Category]. Messages may have been deleted or moved."
- **Loading:** Spinner; "Loading messages...".
- **Error:** "Failed to load messages. Please refresh."
- **All read:** No unread indicator.

### Accessibility

- Semantic HTML: `<section>`, `<article>` per message.
- ARIA labels: Category name, sender name, message subject.
- Keyboard: Tab, Enter, Space, arrow keys as per message list.

---

## 6. Auth Bucket View

### Layout

Opened when user clicks "Auth" in the sidebar. Shows all authentication and account-security mail.

```
┌──────────────────────────────────────────────────────┐
│ Auth                                                 │
├──────────────────────────────────────────────────────┤
│ [Search senders] [Sort ▼] [Filter ▼] [Select all ☐] │
├──────────────────────────────────────────────────────┤
│                                                       │
│ ℹ️ This folder contains authentication codes,       │
│   password resets, login alerts, and security       │
│   notifications. You cannot move Auth mail to       │
│   Junk, and it is never marked as spam.             │
│                                                       │
│ ☐ Apple Support      Sep 28  Your Apple ID verify... │
│ ☐ Google             Sep 25  Your Google password... │
│ ☐ GitHub             Sep 20  Two-factor auth code... │
│ ☐ Bank XYZ           Sep 15  Login attempt from...   │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Components

- **Header:** "Auth" or "Authentication & Security".
- **Informational banner:** Explain that this folder is protected and cannot be junked.
  - Copy: "This folder contains authentication codes, password resets, login alerts, and security notifications. You cannot move Auth mail to Junk or mark it as spam. This protects your accounts from being locked out."
- **Controls:** Search, sort, filter, select all (same as other views).
- **Message list (by sender, optional):** Same as Category View, or flat list.

### Interactions

- **Click message:** Open message detail view (read-only; no "Move to" option).
- **Click sender card:** Open "All from this sender" view, pre-filtered to Auth bucket.
- **Delete button:** Users can delete Auth mail, but cannot move it to Junk.

### States

- **No Auth messages:** "No auth messages. This is good—you have no pending security alerts."
- **Loading:** Spinner; "Loading auth messages...".
- **Error:** "Failed to load auth messages. Please refresh."

### Accessibility

- ARIA role: `role="main"`, aria-label="Authentication and security mail folder".
- Semantic HTML: `<section>` with banner `<aside>`.
- Keyboard: Tab, Enter, Space as per message list.

---

## 7. Junk Review Queue

### Layout

Opened when user clicks "Junk" in the sidebar. Displays all probable spam/abuse mail with three actions: Keep (restore), Mark junk (denylist sender), Allow sender (allowlist).

```
┌──────────────────────────────────────────────────────┐
│ Junk                                                 │
├──────────────────────────────────────────────────────┤
│ ⚠️  Security mail (Auth) is never in this folder.    │
│    You can review messages and restore them or       │
│    mark senders as junk. Deleted mail cannot be      │
│    recovered.                                        │
├──────────────────────────────────────────────────────┤
│ [Search senders] [Sort ▼] [Filter ▼] [Select all ☐] │
├──────────────────────────────────────────────────────┤
│                                                       │
│ ☐ Unknown Sender                  Sep 28  15:45      │
│    attacker@malicious.com                           │
│    "Re: Claim your prize now!"                       │
│    [Keep] [Mark junk] [Allow sender]                │
│                                                       │
│ ☐ phishing@fake-bank.com           Sep 26  10:15     │
│    "Verify your banking details"                    │
│    [Keep] [Mark junk] [Allow sender]                │
│                                                       │
│ ☐ newsletter@unwanted.com          Sep 20           │
│    "Weekly digest subscription (12 more from this)  │
│    [Keep] [Mark junk] [Allow sender]                │
│                                                       │
│ [Bulk actions: Select ≥1 message]                    │
│ [Restore selected] [Delete selected] [Allow sender] │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Banner

Display prominently at the top:

**Copy:** "Security mail (Auth) is never in this folder. You can review messages and restore them to your inbox, mark senders as junk, or permanently delete. Deleted mail cannot be recovered."

### Components

- **Controls:** Search, sort, filter, select all.
- **Message/sender rows:**
  - Checkbox (select for bulk actions).
  - Sender name and address.
  - Date.
  - Subject/snippet.
  - **Action buttons (per row):**
    - [Keep] — Restore message to its original category or Needs review.
    - [Mark junk] — Denylist sender; confirm dialog (see section below).
    - [Allow sender] — Allowlist sender; confirm dialog.
- **Bulk actions (after selecting ≥1):**
  - [Restore selected] — Restore all selected messages to their original categories.
  - [Delete selected] — Permanently delete selected messages (confirm with user).
  - [Allow sender] — Allowlist sender of selected messages (dialog).
  - [Mark junk] — Denylist sender of selected messages (dialog).

### Interactions

- **[Keep] button:** Restore message; update UI (remove from list or show success toast).
- **[Mark junk] button:** Open "Mark sender as junk" dialog (see section 8 below).
- **[Allow sender] button:** Open "Allow sender" dialog (see section 9 below).
- **[Restore selected] bulk action:** Restore all selected messages; show count ("Restored 5 messages").
- **[Delete selected] bulk action:** Confirm deletion ("Permanently delete 5 messages? This cannot be undone.") then delete.

### States

- **Empty Junk folder:** "No junk messages. Great job keeping your inbox clean!"
- **Loading:** Spinner; "Loading junk messages...".
- **Error:** "Failed to load junk messages. Please refresh."
- **Message restored:** Toast notification "Restored message from [Sender].".
- **Sender allowed:** Toast notification "[Sender] is now allowlisted. Future mail will be filed normally.".
- **Sender marked junk:** Toast notification "[Sender] is now marked junk. Future mail will go to Junk.".

### Accessibility

- ARIA role: `role="main"`, aria-label="Junk review queue".
- Banner: `<aside role="alert">` to announce critical rule.
- Semantic HTML: `<section>`, `<article>` per message.
- Keyboard: Tab through rows and buttons, Enter to activate.
- Focus visible: Blue outline.

---

## 8. Junk Actions: Mark Sender Junk (Denylist Dialog)

### Trigger

User clicks [Mark junk] button in Junk review queue or in sender detail view.

### Dialog

```
┌─────────────────────────────────────────────────────┐
│ Mark sender as junk?                                │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Sender:  attacker@malicious.com                    │
│ (Claimed: Unknown Sender)                          │
│                                                     │
│ Messages from this sender will be moved to Junk.   │
│                                                     │
│ ⚠️  IMPORTANT: Security alerts and password       │
│    resets from this sender will ALWAYS go to      │
│    your Auth folder, not Junk. You cannot silence │
│    security mail by marking a sender junk.        │
│                                                     │
│ Existing messages from this sender:                │
│ [ ] Move 24 existing messages to Junk              │
│     (15 Promotions, 9 Receipts, 0 Auth)            │
│     Note: 0 Auth messages will stay in Auth.       │
│                                                     │
│ [Cancel] [Mark junk]                               │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Components

- **Header:** "Mark sender as junk?"
- **Sender identification:**
  - Full From address (canonical identifier, prominently displayed).
  - Display name below in parentheses (noted as "Claimed: [name]" to indicate spoofing risk).
- **Explanation:** "Messages from this sender will be moved to Junk."
- **Security warning (critical):**
  - **Copy:** "IMPORTANT: Security alerts and password resets from this sender will ALWAYS go to your Auth folder, not Junk. You cannot silence security mail by marking a sender junk."
  - Use warning icon (⚠️) and distinct styling (e.g., yellow/orange background or border).
- **Retroactive action (checkbox):**
  - Text: "Move [N] existing messages to Junk ([breakdown by category], [X] Auth)."
  - Subtext: "Note: [X] Auth messages will stay in Auth."
  - Default: **Checked** (user can uncheck to skip retroactive move).
  - Include category breakdown: "15 Promotions, 9 Receipts, 0 Auth".
  - **If Auth messages exist:** Emphasize "X Auth messages will stay in Auth" in subtext.
- **Buttons:** [Cancel] [Mark junk]

### Behavior

1. **Confirmation:** User clicks [Mark junk].
2. **Denylist added:** Sender is added to user's denylist.
3. **Retroactive move (if checked):**
   - Move all non-Auth messages from this sender to Junk bucket.
   - Auth messages remain in Auth (logic enforced server-side; UI does not attempt to move them).
4. **Success notification:** Toast or confirmation dialog:
   - Copy: "[Sender address] is now marked junk. Auth mail from this sender will still come through. [Undo]"
   - [Undo] link reverts the denylist for this session only (client-side).
5. **UI update:** Remove sender from current view or mark as "marked junk" with status badge.

### Safety Rules

- **Auth mail never moved:** Even if checkbox is checked, Auth mail from this sender stays in Auth.
- **Displayed in dialog:** Show Auth count in the retroactive section so user understands.
- **Warning text:** Explicitly warn that Auth mail cannot be silenced.

### Accessibility

- Modal dialog: `role="dialog"`, `aria-labelledby="dialog-title"`, `aria-modal="true"`.
- Warning text: `role="alert"` to announce the security rule.
- Focus: Trap inside dialog; focus on [Cancel] by default.
- Keyboard: Tab through fields, Enter on [Mark junk], Escape to cancel.

---

## 9. Junk Actions: Allow Sender (Allowlist Dialog)

### Trigger

User clicks [Allow sender] button in Junk review queue, sender detail view, or Junk actions menu.

### Dialog

```
┌─────────────────────────────────────────────────────┐
│ Allow sender?                                       │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Sender: attacker@malicious.com                     │
│                                                     │
│ This sender's messages will no longer be marked    │
│ as junk. They will be filed by category            │
│ (e.g., Promotions, Receipts) or to Needs review   │
│ if we can't classify them.                         │
│                                                     │
│ [Cancel] [Allow]                                   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Components

- **Header:** "Allow sender?"
- **Sender identification:** Full From address.
- **Explanation:** "This sender's messages will no longer be marked as junk. They will be filed by category (e.g., Promotions, Receipts) or to Needs review if we can't classify them."
- **Buttons:** [Cancel] [Allow]

### Behavior

1. **Confirmation:** User clicks [Allow].
2. **Allowlist added:** Sender is added to user's allowlist.
3. **Denylist removed (if marked junk):** If sender was previously marked junk, the denylist is cleared.
4. **No retroactive move:** Existing messages stay in their current location.
5. **Success notification:** Toast: "[Sender] is now allowlisted. Future mail will be classified normally. [Undo]"
6. **UI update:** Remove "marked junk" badge or update sender status.

### Accessibility

- Modal dialog: `role="dialog"`, `aria-labelledby="dialog-title"`, `aria-modal="true"`.
- Focus: Trap inside dialog; focus on [Cancel] by default.
- Keyboard: Tab, Enter, Escape.

---

## 10. Needs Review Queue

### Layout

Opened when user clicks "Needs review" in the sidebar. Shows unclassified mail and low-confidence messages.

```
┌──────────────────────────────────────────────────────┐
│ Needs review                                         │
├──────────────────────────────────────────────────────┤
│ ℹ️  Messages here couldn't be classified with        │
│   confidence or encountered an error. Review and     │
│   file them to a category, or delete.                │
├──────────────────────────────────────────────────────┤
│ [Search senders] [Sort ▼] [Filter ▼] [Select all ☐] │
├──────────────────────────────────────────────────────┤
│                                                       │
│ ☐ Unknown Sender           Sep 28  15:45             │
│    unknown@example.com                              │
│    "Some message with odd content"  [Needs review]  │
│    Why: Low confidence on classification (62%).     │
│    [Move to category ▼] [Keep]                      │
│                                                       │
│ ☐ Random Newsletter        Sep 26  10:15             │
│    random@newsletters.com                           │
│    "This week's update"  [Needs review]             │
│    Why: Provider error; please review manually.     │
│    [Move to category ▼] [Keep]                      │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Components

- **Header:** "Needs review" or "Unclassified".
- **Informational banner:** Explain the reason for this queue.
  - Copy: "Messages here couldn't be classified with confidence or encountered an error. Review them and file to a category, delete, or keep in Needs review."
- **Controls:** Search, sort, filter, select all.
- **Message rows:**
  - Sender name, address, date, subject/snippet.
  - Badge: "Needs review" (orange).
  - **Why filed explanation:** "Low confidence on classification (62%)" or "Provider error; please review manually."
  - **Action buttons:**
    - [Move to category ▼] — Dropdown showing all user categories.
    - [Keep] — Keep in Needs review (dismiss).
    - [Delete] — Delete message.
- **Bulk actions:** Move selected to category, delete selected, keep selected.

### Interactions

- **[Move to category ▼]:** Show category dropdown; user selects a category. Message is moved and removed from view.
- **[Keep]:** Message stays in Needs review; button is disabled or shows "Kept".
- **[Delete]:** Delete message (confirm with user).

### States

- **Empty Needs review:** "Inbox is all caught up! No messages need review."
- **Loading:** Spinner; "Loading messages...".
- **Error:** "Failed to load messages. Please refresh."
- **Message moved:** Toast: "Moved message to [Category].".

### Accessibility

- ARIA role: `role="main"`, aria-label="Needs review queue".
- Banner: `<aside role="alert">`.
- Semantic HTML: `<section>`, `<article>` per message.
- Keyboard: Tab, Enter, Space, arrow keys.
- Focus visible: Blue outline.

---

## 11. Senders List

### Layout

Opened when user clicks "Senders" in the sidebar. Displays a local index of all senders, grouped and sorted by most recent message date.

```
┌──────────────────────────────────────────────────────┐
│ Senders                                              │
├──────────────────────────────────────────────────────┤
│ [Search senders] [Sort ▼] [Settings ⚙]              │
├──────────────────────────────────────────────────────┤
│                                                       │
│ ┌────────────────────────────────────────┐           │
│ │ Apple Support                          │ Sep 28    │
│ │ apple-support@apple.com                │ 27 msgs   │
│ │ 3 Auth, 2 Promo, 22 Other             │ 1 unread  │
│ └────────────────────────────────────────┘           │
│                                                       │
│ ┌────────────────────────────────────────┐           │
│ │ Amazon Orders                          │ Sep 26    │
│ │ order@amazon.com                       │ 15 msgs   │
│ │ 5 Receipts, 10 Promo                  │           │
│ └────────────────────────────────────────┘           │
│                                                       │
│ ┌────────────────────────────────────────┐           │
│ │ GitHub Notifications                   │ Sep 20    │
│ │ notifications@github.com                │ 12 msgs   │
│ │ 12 Notifications (Work)                │           │
│ └────────────────────────────────────────┘           │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Components

- **Header:** "Senders".
- **Controls:**
  - Search box (search by sender name or address).
  - Sort dropdown (Latest, Oldest, Sender A–Z, Message count, Unread count).
  - Settings ⚙ (link to sender grouping settings; see section 12).
- **Sender cards (per sender):**
  - Sender name (or "Unknown Sender" if no display name).
  - Full From address (below name, smaller text).
  - Category breakdown: "[N] Auth, [M] Promo, [K] Receipts, ...".
  - Date of most recent message (right-aligned).
  - Total message count.
  - Unread count (if > 0).
  - Status badges (if applicable): "[Allowlisted]", "[Marked junk]", "[Muted]" (small icons or text).

### Interactions

- **Click sender card:** Open "All from this sender" detail view (see section 3).
- **Hover card:** Show quick actions: [Allow] [Mark junk] [Mute] (optional inline buttons).
- **Search:** Filter senders by name or address (local, in-browser).
- **Sort:** Reorder senders.

### States

- **Empty (no senders):** "No senders yet. Start by checking your inbox or Needs review."
- **Loading:** Spinner; "Loading senders...".
- **Error:** "Failed to load senders. Please refresh."
- **Allowlisted sender:** Show "[Allowlisted]" badge or icon.
- **Marked junk sender:** Show "[Marked junk]" badge or icon.
- **Muted sender:** Show "[Muted]" icon (e.g., bell with slash).

### Accessibility

- ARIA role: `role="main"`, aria-label="Senders list".
- Semantic HTML: `<section>`, `<article>` per sender.
- Keyboard: Tab through cards, Enter to open detail view.
- Focus visible: Blue outline.

---

## 12. Sender Settings (Grouping Options)

### Layout

Opened when user clicks "Settings ⚙" in the Senders view.

```
┌─────────────────────────────────────────────────────┐
│ Sender Grouping Settings                            │
├─────────────────────────────────────────────────────┤
│                                                     │
│ [ ] Group plus-addressed variants                  │
│     Example: john@example.com, john+work@example, │
│     john+promo@example.com are grouped as one      │
│     sender.                                         │
│     Default: ☑ Enabled                              │
│                                                     │
│ [ ] Normalize subdomains to root domain             │
│     Example: noreply@mail.example.com,              │
│     noreply@support.example.com are grouped as     │
│     noreply@example.com.                           │
│     Default: ☐ Disabled                             │
│                                                     │
│ [Save] [Cancel]                                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Components

- **Toggle 1:** "Group plus-addressed variants" (default: enabled).
  - Explanation: "Example: john@example.com, john+work@example.com, john+promo@example.com are grouped as one sender."
- **Toggle 2:** "Normalize subdomains to root domain" (default: disabled).
  - Explanation: "Example: noreply@mail.example.com, noreply@support.example.com are grouped as noreply@example.com."
- **Buttons:** [Save] [Cancel]

### Behavior

- Toggling either option triggers a re-index of the sender list (may take a few seconds for large inboxes).
- User sees a progress indicator: "Rebuilding sender index... please wait."
- On completion, sender list is updated to reflect the new grouping.

### Accessibility

- Modal dialog: `role="dialog"`, `aria-labelledby="settings-title"`, `aria-modal="true"`.
- Checkboxes: `role="checkbox"`, `aria-checked="true/false"`.
- Focus: Tab through toggles, Enter to toggle.

---

## 13. Category Manager

### Layout

Opened when user clicks "Manage categories" or "Categories ⚙" in the sidebar.

```
┌──────────────────────────────────────────────────────┐
│ Category Manager                                     │
│                                                      │
│ Categories: 48 / 48 (at cap)                         │
├──────────────────────────────────────────────────────┤
│                                                      │
│ ENABLED CATEGORIES (36)                              │
│                                                      │
│ [✓] Personal & Family       [Edit] [Disable]         │
│ [✓] Work                    [Edit] [Disable]         │
│ ... (more defaults)                                  │
│                                                      │
│ CUSTOM CATEGORIES (12)                               │
│                                                      │
│ [✓] Mentor                  [Edit] [Disable]         │
│ [✓] Side Gig                [Edit] [Disable]         │
│ ... (user-added)                                     │
│                                                      │
│ DISABLED CATEGORIES (0)                              │
│                                                      │
│ (None. Disabled categories appear here.)             │
│                                                      │
│ ──────────────────────────────────────────────────── │
│ [+ Add custom category]  [Disabled; at 48/48]       │
│                                                      │
│ [Close]                                              │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Components

- **Header:** "Category Manager".
- **Counter:** "Categories: [N] / 48" (shows current count and max cap).
  - If at cap (48), display in red: "48 / 48 (at cap)".
  - Below cap, display in normal color: "36 / 48".
- **Sections (tabbed or accordion):**
  - **Enabled Categories:**
    - List all enabled categories (defaults + custom).
    - Per category: checkbox [✓], category name, [Edit] button, [Disable] button.
  - **Disabled Categories:**
    - List all disabled categories (if any).
    - Per category: checkbox [ ], category name (grayed out), [Edit] button, [Enable] button.
  - **Note on disabled categories:** "Disabled categories count toward the 48-category limit. To free up space, delete a disabled category (permanent) or enable it."

### Actions

- **[Edit]:** Open "Edit category name" dialog for custom categories (defaults cannot be renamed).
- **[Disable]:** Move category from enabled to disabled section. Messages in this category remain accessible in the archive but are not assigned to it on new messages. Category still counts toward 48 cap.
- **[Enable]:** Move category from disabled back to enabled section.
- **[Delete]:** Permanently remove a disabled category (only available on disabled categories). Frees up 1 slot in the 48 cap.
- **[+ Add custom category]:** Button to add a new custom category (enabled only if count < 48).
  - If at 48: Button is grayed out with tooltip "You've reached the 48-category limit. Delete a category to add a new one (disabling does not free a slot)."

### States

- **Below cap (e.g., 36/48):** [+ Add custom category] button is active (blue, clickable).
- **At cap (48/48):** [+ Add custom category] button is grayed out (disabled state, cursor not-allowed, tooltip "At 48-category limit").
- **Edit dialog (custom categories only):**
  ```
  ┌─────────────────────────────────────┐
  │ Edit Category                       │
  ├─────────────────────────────────────┤
  │ Category name:                      │
  │ [___________________] (text input)  │
  │                                     │
  │ [Cancel] [Save]                     │
  └─────────────────────────────────────┘
  ```
- **Disable confirmation:**
  ```
  ┌─────────────────────────────────────┐
  │ Disable "Mentor"?                   │
  ├─────────────────────────────────────┤
  │ Messages in this category will no   │
  │ longer be automatically filed here. │
  │ Existing messages remain in your    │
  │ archive.                            │
  │                                     │
  │ [Cancel] [Disable]                  │
  └─────────────────────────────────────┘
  ```
- **Delete confirmation (disabled categories only):**
  ```
  ┌─────────────────────────────────────┐
  │ Delete "Mentor"?                    │
  ├─────────────────────────────────────┤
  │ This cannot be undone. Messages in  │
  │ this category will be moved to      │
  │ Needs review.                       │
  │                                     │
  │ [Cancel] [Delete]                   │
  └─────────────────────────────────────┘
  ```

### Behavior

- **Enable/Disable:** Instantaneous toggle; no confirmation (user can easily reverse).
- **Add custom category:** Opens dialog with text input. User enters name (max 50 characters). On save, category is added to enabled list, count increments, and [+ Add custom] button may disable if at 48.
- **Rename custom category:** Opens dialog with current name pre-filled. User edits and saves.
- **Delete disabled category:** Permanent; requires confirmation. Messages in this category are moved to Needs review or archived.

### Safety Rules

- **Disabled categories count toward 48:** This is explicit in the UI and help text.
- **No silent deletion:** Deleting a category always moves its messages (not silent delete).
- **Cannot rename defaults:** Defaults (Personal & Family, Work, Finance, etc.) can only be disabled, not renamed. Custom categories can be renamed.

### Accessibility

- Modal dialog: `role="dialog"`, `aria-labelledby="manager-title"`, `aria-modal="true"`.
- Sections: `<section>`, `<h3>` headings.
- Checkboxes: `role="checkbox"`, `aria-checked="true/false"`.
- Counter: `aria-live="polite"` to announce changes ("24 / 48", "48 / 48").
- Keyboard: Tab through categories and buttons, Enter to activate, Space to toggle checkbox.
- Focus visible: Blue outline on buttons and checkboxes.

---

## 14. Settings Screen

### Layout

Opened when user clicks "Settings" in the sidebar.

```
┌──────────────────────────────────────────────────────┐
│ Settings                                             │
├──────────────────────────────────────────────────────┤
│                                                       │
│ CLASSIFICATION THRESHOLDS (Read-Only)                 │
│                                                       │
│ Junk confidence threshold:   90%  (Fixed)            │
│ Auth confidence threshold:   80%  (Fixed)            │
│ Category confidence threshold: 60% (Fixed)           │
│                                                       │
│ These thresholds are system-controlled to ensure     │
│ security and accuracy. Contact support to change.    │
│                                                       │
│ ──────────────────────────────────────────────────── │
│                                                       │
│ CONNECTION STATUS                                     │
│                                                       │
│ Jev.ai Classifier:  [✓ Connected]  [Test]            │
│ Last sync:          Sep 29, 2026 at 2:30 PM         │
│                                                       │
│ [Failure banner (if disconnected)]                   │
│ "Classifier is unavailable. New messages will be     │
│  routed to Needs review until connection is          │
│  restored. Last successful sync: [timestamp]"       │
│                                                       │
│ ──────────────────────────────────────────────────── │
│                                                       │
│ ALLOWLIST / DENYLIST                                  │
│                                                       │
│ Allowed senders (never junked):                       │
│ apple-support@apple.com   [Remove]                   │
│ @github.com              [Remove]                   │
│ [+ Add sender or domain]                             │
│                                                       │
│ Denied senders (always junked, unless Auth):          │
│ spammer@example.com       [Remove]                   │
│ newsletter@unwanted.com   [Remove]                   │
│ [+ Add sender or domain]                             │
│                                                       │
│ ──────────────────────────────────────────────────── │
│                                                       │
│ [Close]                                               │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Sections

#### 1. Classification Thresholds (Read-Only)

- **Display:**
  - Junk confidence threshold: **90%** (Fixed), plus Auth-no >= 90 and the security-shape backstop for jev.ai-initiated Junk.
  - Auth confidence threshold: **80%** (Fixed).
  - Category confidence threshold: **60%** (Fixed).
- **Note:** "These thresholds are system-controlled to ensure security and accuracy. Contact support to change."
- **Purpose:** Inform user of the classification rules without allowing changes.

#### 2. Connection Status

- **Status line:** "Jev.ai Classifier: [✓ Connected]" or "[✗ Disconnected]".
- **Last sync:** Timestamp of last successful jev.ai call.
- **[Test] button:** Trigger a test classification (optional; helps user verify connectivity).
- **Failure banner (if disconnected):**
  - **Copy:** "Classifier is unavailable. New messages will be routed to Needs review until connection is restored. Last successful sync: [timestamp]."
  - **Styling:** Red/orange banner, prominent alert icon.
  - **Action:** Auto-hide on reconnection; show retry button if manually triggered.

#### 3. Allowlist / Denylist (Sender/Domain)

- **Allowlist section:**
  - List of allowed senders or domains (e.g., "apple-support@apple.com", "@github.com").
  - Per entry: [Remove] button.
  - [+ Add sender or domain] button: Opens dialog to add new entry.
- **Denylist section:**
  - List of denied senders or domains.
  - Per entry: [Remove] button.
  - [+ Add sender or domain] button: Opens dialog to add new entry.

#### Dialogs

**Add to Allowlist:**
```
┌──────────────────────────────────────────┐
│ Add Allowed Sender                       │
├──────────────────────────────────────────┤
│ Email or domain:                         │
│ [___________________] (text input)       │
│                                          │
│ Examples:                                │
│   apple-support@apple.com                │
│   @github.com                            │
│                                          │
│ [Cancel] [Add]                           │
└──────────────────────────────────────────┘
```

**Add to Denylist:**
```
┌──────────────────────────────────────────┐
│ Add Denied Sender                        │
├──────────────────────────────────────────┤
│ Email or domain:                         │
│ [___________________] (text input)       │
│                                          │
│ ⚠️  Auth mail from this sender will still│
│    be delivered to your Auth folder.     │
│                                          │
│ [Cancel] [Add]                           │
└──────────────────────────────────────────┘
```

### Behavior

- **Add to Allowlist:** User enters email or domain. On save, sender/domain is added to allowlist; future mail from this sender/domain is exempt from Junk routing.
- **Add to Denylist:** User enters email or domain. On save, sender/domain is added to denylist; future mail routes to Junk (unless Auth signal is present).
- **Remove from list:** Click [Remove]; no confirmation needed (can easily re-add).

### States

- **Connected:** Status shows "[✓ Connected]" with green checkmark and icon.
- **Disconnected:** Status shows "[✗ Disconnected]" or "[⚠️ Connecting...]" with red/orange icon.
- **Empty allowlist/denylist:** "No senders added." with [+ Add] button.

### Accessibility

- Sections: `<section>`, `<h3>` headings.
- Status: `aria-live="polite"` to announce connection changes.
- Dialogs: `role="dialog"`, `aria-modal="true"`.
- Keyboard: Tab through fields and buttons, Enter to activate.
- Focus visible: Blue outline.

---

## 15. Confirmation & Error Dialogs

### Bulk Move to Category Dialog (Auth Blocking)

**Trigger:** User selects ≥1 message and clicks "Move to Junk" or "Move to [category]" when selection includes Auth mail.

**Dialog:**

```
┌─────────────────────────────────────────────────────┐
│ Move to Junk?                                       │
├─────────────────────────────────────────────────────┤
│                                                     │
│ 1 message is security mail (Auth) and cannot       │
│ be moved to Junk.                                  │
│                                                     │
│ Moving 24 other messages to Junk.                  │
│                                                     │
│ [Cancel] [Move 24]                                  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Behavior:**
- Auth message is skipped; other messages are moved.
- Success message: "Moved 24 messages. 1 Auth message stays in Auth."
- Auth message remains visible in the original view (or in Auth bucket if changing view).

---

### Delete Confirmation

**Trigger:** User clicks [Delete] on message or bulk-deletes messages.

**Dialog:**

```
┌─────────────────────────────────────────────────────┐
│ Delete message?                                     │
├─────────────────────────────────────────────────────┤
│ This message will be moved to trash. You can still  │
│ recover it from trash.                              │
│                                                     │
│ [Cancel] [Delete]                                   │
└─────────────────────────────────────────────────────┘
```

---

### Junk Connection Failure Banner

**Trigger:** Jev.ai classifier is unavailable.

**Banner (top of screen or in-context):**

```
┌─────────────────────────────────────────────────────┐
│ ⚠️  Classifier is unavailable.                       │
│                                                     │
│ New messages will be routed to Needs review until   │
│ connection is restored. Last sync: Sep 29 at 2:30PM │
│                                                     │
│ [Retry] [Dismiss]                                   │
└─────────────────────────────────────────────────────┘
```

**Behavior:**
- Banner persists until connection is restored.
- [Retry] button manually triggers a reconnection attempt.
- [Dismiss] hides banner (re-appears on next unread message arrival).
- Auto-hide on reconnection with success message: "Connection restored. Messages are being classified normally again."

---

## 16. Empty and Error States

### No Messages in Category / Bucket

**Copy:**
- **Inbox (empty):** "No messages in [Category]. Start by checking Needs review or Senders."
- **Junk (empty):** "No junk messages. Great job keeping your inbox clean!"
- **Needs review (empty):** "Inbox is all caught up! No messages need review."
- **Senders (empty):** "No senders yet. Start by checking your inbox or Needs review."
- **Auth (empty):** "No auth messages. This is good—you have no pending security alerts."

**Styling:** Large, friendly icon (empty folder), centered on screen with action link (e.g., "Go to Inbox" or "Check Senders").

---

### Failed to Load Messages

**Copy:** "Failed to load messages. Please [Retry]."

**Styling:** Red banner or error box with retry button.

---

### Classifier Connection Error

**Copy (banner):** "Classifier is unavailable. New messages will be routed to Needs review until connection is restored."

**Copy (Settings):** "Jev.ai Classifier: [✗ Disconnected] [Test]"

**Styling:** Red/orange banner with alert icon; prominent in Settings screen.

---

## 17. Loading States

### Spinner Patterns

- **Inbox / Category / Sender list loading:** Skeleton cards (placeholder rectangles) or spinner with "Loading messages...".
- **Message detail loading:** Skeleton header (sender, date, subject) and body area with spinner.
- **Category manager loading (on toggle):** Spinner with "Rebuilding sender index..." (for large operations).

**Styling:** Subtle gray spinners or skeleton screens to avoid jarring UX.

---

## 18. Auth Mail Safety: UI Constraints

### Manual Move Blocked (Message Detail View)

**Scenario:** User opens Auth message detail and tries to click "Move to category" or "Move to Junk".

**UI State:**
- [Move to category ▼] button is **disabled** (grayed out, cursor: not-allowed).
- Tooltip on hover: "Security mail cannot be moved from Auth."

**Alternative:** Show a read-only badge: "[Auth] — immutable, cannot be moved."

---

### Bulk Move Skips Auth (Message List View)

**Scenario:** User selects multiple messages (mix of Auth and non-Auth) and clicks "Move to Junk".

**UI Behavior:**
1. Confirmation dialog appears (see section 15).
2. Dialog states: "[N] message(s) cannot be moved (security mail). Moving [M] other messages."
3. User confirms.
4. Auth messages are skipped; non-Auth messages are moved.
5. Success toast: "Moved [M] messages. [N] Auth message(s) stay in Auth."

---

### Auth Banner (Auth Bucket View)

**Copy:** "This folder contains authentication codes, password resets, login alerts, and security notifications. You cannot move Auth mail to Junk, and it is never marked as spam. This protects your accounts from being locked out."

**Styling:** Blue informational banner with ℹ️ icon, displayed at the top of the Auth bucket view.

---

### Junk Queue Banner (Junk View)

**Copy:** "Security mail (Auth) is never in this folder. You can review messages and restore them to your inbox, mark senders as junk, or permanently delete. Deleted mail cannot be recovered."

**Styling:** Alert banner (⚠️) with orange/red border, displayed at the top of the Junk view.

---

## 19. Accessibility Basics

### WCAG 2.1 AA Compliance

- **Color contrast:** All text meets 4.5:1 contrast ratio (normal text) or 3:1 (large text).
- **Focus visible:** Blue outline (~3px) around all interactive elements (buttons, links, checkboxes, text fields).
- **Semantic HTML:** Use `<button>`, `<a>`, `<label>`, `<input>`, `<section>`, `<nav>`, `<main>`, `<article>`, `<aside>`, `<header>`, `<footer>`.
- **ARIA roles and labels:**
  - `role="main"` on main content area.
  - `role="navigation"` on sidebar.
  - `role="dialog"` on modals.
  - `aria-label` and `aria-labelledby` on dialogs and sections.
  - `aria-live="polite"` on status messages and counters.
  - `aria-current="page"` on active sidebar section.
- **Keyboard navigation:**
  - Tab through all interactive elements.
  - Shift+Tab to navigate backward.
  - Enter to activate buttons/links.
  - Space to toggle checkboxes.
  - Arrow keys to navigate message lists (optional).
  - Escape to close dialogs/modals.
- **Focus trap:** Modals trap focus inside the dialog (Tab cycles within dialog, does not escape).
- **Skip link:** "[Skip to main content]" link at the top of the page (hidden visually, shown on Tab focus).

### Keyboard Navigation

- **Sidebar:** Tab to navigate sections, Enter to select.
- **Message list:** Tab to sender/message rows, Enter to open detail view, Space to select checkbox, arrow keys to move between rows (optional).
- **Buttons:** Tab to button, Enter or Space to activate.
- **Dropdowns:** Tab to dropdown, Enter to open, arrow keys to select, Enter to confirm, Escape to close.
- **Text inputs:** Tab to field, type to enter text, Tab to move to next field, Escape to cancel (in dialogs).

### Screen Reader Support

- **Page title:** "[Category] - Jev Inbox" or "[View] - Jev Inbox".
- **Headings:** Use `<h1>`, `<h2>`, `<h3>` hierarchy.
- **Links:** Descriptive link text (e.g., "[Open] Apple Support sender view" instead of "[Click here]").
- **Buttons:** Label text or `aria-label` (e.g., `<button aria-label="Mark sender as junk">Mark junk</button>`).
- **Form labels:** `<label>` with `for` attribute linked to input `id`.
- **Error messages:** `role="alert"` to announce errors to screen readers.
- **Status updates:** `aria-live="polite"` for messages like "Moved 5 messages".

### Assistive Technology

- **High contrast mode:** All colors pass contrast ratio checks.
- **Zoom:** Layout remains usable at 200% zoom.
- **Reduced motion:** Respect `prefers-reduced-motion` media query; disable animations for users with motion sensitivity.
- **Text size:** Font sizes are readable (base: 16px, minimum 14px).

---

## 20. Responsive Design (Desktop / Tablet / Mobile)

### Desktop (≥1024px)

- Sidebar always visible (left column, 260–280px width).
- Main content area (right, fluid width).
- Message list shows 3–4 columns (sender, date, subject, actions).

### Tablet (768–1023px)

- Sidebar collapsible (hamburger menu ☰ to toggle).
- Message list shows 2–3 columns (sender, subject, date/actions).
- Fonts and buttons slightly smaller to fit screen.

### Mobile (<768px)

- Sidebar hidden by default, accessed via hamburger menu.
- Message list shows 1 column (sender, subject, unread indicator).
- Actions available via swipe (left/right) or long-press context menu.
- Modals and dialogs full-screen or large overlays.
- Touch targets ≥44x44px for buttons and interactive elements.

---

## Summary

This screen spec defines the complete Jev Inbox web app UX, with emphasis on:

1. **Safety:** Auth mail is never rendered in Junk; manual and bulk moves are blocked or skipped with explanations.
2. **Clarity:** Every screen displays full sender addresses (for spoofing protection) and explains why mail is in a bucket/category.
3. **Control:** Users can manage categories (rename, disable, delete), allowlist/denylist senders, and take explicit actions (Keep, Mark junk, Allow).
4. **Accessibility:** Full WCAG 2.1 AA compliance with semantic HTML, keyboard navigation, screen reader support, and ARIA labels.
5. **Reliability:** Error states, loading states, and connection-failure banners guide users when classification is unavailable.
6. **Transparency:** Junk is a review queue, not auto-delete; low-confidence mail routes to Needs review; thresholds are displayed (read-only).

Each screen enforces the never-junk gate at the UI level, ensuring Auth mail remains accessible and user intent is always explicit.
