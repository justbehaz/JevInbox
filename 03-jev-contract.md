# Jev.ai Integration Contract for Jev Inbox

## Overview

Jev Inbox uses jev.ai as its single classification engine. **One call per message.** Each call asks a series of yes/no questions: one per enabled user category, plus two system questions (Auth and Junk). The jev.ai response is deterministic, not a chat model; it returns a binary answer and confidence score per question.

This contract specifies:
- How to construct the request
- How to parse the response
- Validation rules for malformed responses
- Confidence thresholds and routing
- The local safety gates that run before and after the jev.ai call

---

## Architecture: The Classification Pipeline

```
Message arrives
    ↓
[LOCAL: Deterministic Auth detection + allowlist check]
    ↓ (if Auth signal found, route to Auth bucket; skip jev.ai)
    ↓ (if not Auth, proceed to jev.ai)
[JEV.AI CALL: one request with enabled categories + Auth + Junk questions]
    ↓
[LOCAL: Parse response, apply confidence thresholds]
    ↓
[LOCAL: Never-junk gate; apply receipt/bill and reply-history exceptions]
    ↓
[LOCAL: Multi-yes resolution and primary category selection]
    ↓
File into Auth / Junk / user category / Needs review / Other
```

**Critical:** The deterministic Auth detection pass and allowlist run **locally** before the jev.ai call. The jev.ai Auth question is a **confirmation** step, not the authoritative source. A jev.ai junk=true answer **cannot file mail as Junk** without passing the local never-junk gate (02-never-junk.md).

---

## Request Format

### Message ID and Redacted Fields

Each request includes a message identifier and a minimal set of redacted/truncated email fields to protect user privacy.

```json
{
  "message_id": "msg_abc123def456",
  "timestamp": "2026-09-29T14:32:00Z",
  "fields": {
    "from": "sender@example.com",
    "subject": "Your order confirmation",
    "snippet": "Thank you for your purchase. Order #[CODE] is on the way...",
    "authentication_results": "spf=pass dkim=pass dmarc=pass"
  },
  "user_enabled_categories": [
    "cat_001", "cat_002", "cat_003", ..., "cat_036"
  ],
  "questions": [ ... ]
}
```

### Question Set

The `questions` array contains one object per enabled category, plus two system questions (Auth and Junk).

```json
"questions": [
  {
    "question_id": "cat_001",
    "text": "Is this personal correspondence from a friend or family member, or about a family matter?"
  },
  {
    "question_id": "cat_002",
    "text": "Is this message from a work colleague, work project, or professional context?"
  },
  ...
  {
    "question_id": "cat_029",
    "text": "Is this an account creation, billing address update, account confirmation, or account management message that is NOT a security alert or password reset?"
  },
  ...
  {
    "question_id": "sys_auth",
    "text": "Is this mail from a provider the user has an account with, and does it contain an authentication code, verification request, password reset link, login alert, or security alert?"
  },
  {
    "question_id": "sys_junk",
    "text": "Is this likely spam, abuse, phishing, or unsolicited bulk mail?"
  }
]
```

### Redaction and Truncation Rules

- **Payload is exactly four fields:** From, Subject, Snippet, Authentication-Results. Nothing else (no Reply-To, no List-Unsubscribe, no other headers, no body beyond the snippet, no attachments).
- **From:** full address (needed for sender context; allowlist matching is local).
- **Subject:** sent as written, except the code and token redaction below is applied to it too.
- **Snippet:** truncated to 500 characters of visible text, AFTER redaction.
- **Authentication-Results:** SPF/DKIM/DMARC verdicts only.
- **Mandatory local redaction before sending (v1 rule, applies to Subject and Snippet):** replace every standalone 4-10 digit code (with or without spaces or hyphens inside, e.g. 123456, 123 456, 12-34-56; 4-10 matches the range used by the deterministic Auth pass and the security-shape backstop) with `[CODE]`; replace any URL or URL-like string that looks like a reset, verify, magic-link or sign-in link, and any long opaque token (roughly 16 or more URL-safe characters, or a token/code/key/sig query parameter), with `[LINK]`. One-time codes must never leave the device. Redaction runs on device before the request is built. The local deterministic Auth pass and the security-shape backstop always run on the ORIGINAL unredacted text, on device only. If redaction fails or throws, do not send: route to Needs review.
- **Never send:**
  - Raw message body (full text) or attachments
  - Passwords or secrets in headers
  - Received hops
- **User IP, device info, session tokens:** Never send.

---

## Response Format

### Standard Response

jev.ai returns a JSON object with one answer per question:

```json
{
  "message_id": "msg_abc123def456",
  "status": "success",
  "answers": [
    {
      "question_id": "cat_001",
      "answer": false,
      "confidence": 95
    },
    {
      "question_id": "cat_002",
      "answer": true,
      "confidence": 78
    },
    ...
    {
      "question_id": "sys_auth",
      "answer": true,
      "confidence": 92
    },
    {
      "question_id": "sys_junk",
      "answer": false,
      "confidence": 88
    }
  ],
  "response_time_ms": 1850
}
```

### Fields

- `message_id`: Echo of the request ID.
- `status`: "success", "error", "timeout", or "partial".
- `answers`: Array of answer objects.
  - `question_id`: The question ID (cat_NNN or sys_*).
  - `answer`: Boolean (true = yes, false = no).
  - `confidence`: Integer 0–100 representing the model's confidence in the answer.
- `response_time_ms`: Latency in milliseconds.

### Error Response

```json
{
  "message_id": "msg_abc123def456",
  "status": "error",
  "error": "service_unavailable",
  "message": "Jev.ai endpoint is unreachable.",
  "response_time_ms": 5000
}
```

---

## Question Set Assembly

### Enabled Categories

The client constructs the `questions` array at request time based on the user's enabled categories:

1. **Start with the user's list of enabled categories** (e.g., `["cat_001", "cat_002", ..., "cat_036"]`).
   - Default: all 36 defaults are enabled.
   - User can disable any defaults and add up to 12 custom categories (cap: 48 total; disabled categories still count until deleted).
2. **Add system questions:** Always include `sys_auth` and `sys_junk`.
3. **Total questions per request:** up to 50 (fewer if the user disables categories).
   - Typical minimum at ship: 36 (defaults) + 2 (system) = 38.
   - Maximum: 48 (max categories) + 2 (system) = 50.

### Question Text

Use the wording from 01-taxonomy.md **except**:

- **cat_029 (Accounts):** Use the reworded question (see section "Reworded cat_029 Accounts Question" below).
- **Custom categories:** User-provided text.

---

## Validation

### Missing or Duplicate Answers

If jev.ai returns:
- Fewer answers than questions requested: **provider error** → Needs review.
- Duplicate question IDs in the response: **provider error** → Needs review.
- An unknown question ID: **provider error** → Needs review.

### Malformed Confidence

- Confidence not an integer 0–100: **provider error** → Needs review.
- Confidence < 0 or > 100: **provider error** → Needs review.

### Missing Status Field

If `status` is missing or not one of ["success", "error", "timeout", "partial"]: **provider error** → Needs review.

### Partial Responses

If `status = "partial"` (jev.ai answered some questions but not all):
- Use the answers provided.
- Treat missing answers as **no answer** (treat as low confidence, route to Needs review).
- Log a warning and increment provider-error counter.

---

## Timeout and Retry Logic

### Timeout Thresholds

**PLACEHOLDER VALUES.** The 3 second timeout and 2 retries below are placeholders until the jev.ai API docs arrive. Whatever values are used, any timeout, error, or exhausted retry routes the message to Needs review, NEVER Junk.

- **Max latency per request:** 3 seconds (3000 ms).
- If jev.ai takes longer, timeout and return error.

### Retry Policy

- **Max retries:** 2 (up to 3 total attempts).
- **Backoff:** 100 ms, 300 ms (exponential).
- **After 3 attempts:** Give up and route to Needs review (fail-safe).

### On Timeout or Persistent Error

- Route message to **Needs review**, never to Junk.
- Log error with message ID, error code, and timestamp.
- Do NOT cache the error result.

---

## Confidence Thresholds

All thresholds are **deterministic and apply locally**. jev.ai provides confidence; the client applies routing logic.

### Auth Question (sys_auth)

- **Answer = Yes, confidence >=80:** Auth signal confirmed. Route to Auth.
- **Answer = Yes, confidence 60-79:** Low confidence. Route to Needs review.
- **Answer = Yes, confidence <60:** Low confidence. Route to Needs review.
- **Answer = No, confidence >=90:** No Auth signal. Junk may be considered (still subject to the full junk gate).
- **Answer = No, confidence 60-89:** Not Auth for filing purposes, but jev.ai-initiated Junk is BLOCKED. Category filing continues; if the mail would otherwise have been Junk it goes to Needs review.
- **Answer = No, confidence <60:** Low confidence. Route to Needs review.

### Junk Question (sys_junk)

- **Answer = Yes, confidence >=90:** Candidate for Junk (subject to the full gate: Auth "no" >=90, no security-shape backstop hit, no sender Auth history, receipt/bill and reply-history exceptions, not allowlisted).
- **Answer = Yes, confidence <90:** Not Junk. Route to Needs review.
- **Answer = No, confidence >=60:** No junk signal. Proceed to category filing.
- **Answer = No, confidence <60:** Low confidence. Route to Needs review.

### User Categories (cat_NNN)

- **Answer = Yes, confidence ≥60%:** Category match. Candidate for filing.
- **Answer = Yes, confidence 50–59%:** Low confidence. Deprioritize, but do not discard.
- **Answer = Yes, confidence <50%:** Very low confidence. Treat as No.
- **Answer = No:** No match.

---

## Resolution Logic

### Step 1: Auth Gate (Before Junk Evaluation)

If **deterministic Auth detection** (regex + keywords on headers/subject/body) OR **allowlist check** (sender/domain allowlist) returns true:
- Route to **Auth** bucket immediately.
- Skip jev.ai Auth question (optional; can still call for logging/audit).
- Skip Junk evaluation.

If no deterministic signal but **jev.ai sys_auth = Yes, confidence >=80**:
- Route to **Auth** bucket.
- Skip Junk evaluation.

If **jev.ai sys_auth confidence is 60–79%** (any answer):
- Route to **Needs review**.
- Skip other evaluations.

### Step 2: Junk Gate (If No Auth Signal)

Only proceed if no Auth signal was detected (deterministic, security-shape backstop, or jev.ai Auth yes >=80) AND jev.ai sys_auth = No with confidence >=90.

**Junk condition (all must be true):**

1. **No Auth signal** (already checked in Step 1), AND
2. **jev.ai sys_junk = Yes, confidence >=90** and **sys_auth = No, confidence >=90**, AND
3. **No security-shape backstop hit** (02-never-junk.md, "Auth Backstop"), AND
4. **No receipt or bill pattern** (deterministic regex), AND
5. **Not from a sender the user has replied to** (checked in sent history), AND
6. **No sender Auth history** (the exact address or its root domain, including subdomains, has never produced an Auth-filed message; history is kept indefinitely), AND
7. **Not allowlisted by the user**

**If all true → Junk.**

**If jev.ai said sys_junk = Yes but any condition fails → Needs review (never Junk).** If jev.ai said sys_junk = No (confidence >=60), proceed to Step 3 (category filing).

**Special case: User marked sender junk (denylist):**
- If no Auth signal and no other exceptions, user's explicit mark sends mail to Junk (review queue, not silent delete).
- User-initiated Junk is not subject to the 90 thresholds, the sender-history guard or the receipt/reply exceptions (explicit user intent), but it never overrides Auth, the security-shape backstop (those go to Needs review), or allowlist.
- Retroactive sender-junk moves must finish before per-sender cache re-evaluation begins.

### Step 3: Multi-Yes Category Resolution

After the junk gate, evaluate user-category answers:

**Multi-yes scenario:** If multiple categories have `answer=Yes, confidence ≥60%`:

1. **Rank by confidence (highest first).**
2. **Ties:** Break by catalogue order (lowest cat_ number first; custom categories come after defaults in creation order). No user priority UI in v1.
3. **Select primary category:** The highest-ranked yes.
4. **Store all yes labels:** Record all categories that matched (confidence ≥60%) for later reference (e.g., in a debug log or "Also tagged" list).

**Example:**
- cat_007 (Receipts): Yes, confidence 89%
- cat_020 (Promotions): Yes, confidence 76%
- cat_008 (Shopping): Yes, confidence 72%

Primary category: cat_007 (highest confidence).
All yes labels: [cat_007, cat_020, cat_008].

### Step 4: No-Yes Fallback

If no category matches (all confidence ≥50% are No):

**Option A:** File to **cat_036 (Other)** if the jev.ai sys_junk answer is No.

**Option B:** If jev.ai sys_junk = Yes but confidence <90, file to **Needs review** (not Other).

**Option C:** If no answer is sufficient to classify (very low confidence on all categories), file to **Needs review**.

### Step 5: Low Confidence Fallback

If **all category answers have confidence <50%**:
- Do not file to a category.
- Route to **Needs review**.

If **any single category has confidence ≥50% but <60%**:
- Candidate for filing, but lower priority.
- File to highest-confidence category if confidence ≥50%.
- If no category ≥50%, route to **Needs review**.

### Step 6: Provider Failure

If jev.ai returns error, timeout, or malformed response:
- **Always route to Needs review, never to Junk.**
- Log the error with message ID and timestamp.
- Do not retry the message; the next re-delivery attempt will trigger a fresh classification.

---

## The Never-Junk Gate (Local, Independent of jev.ai Response)

### Pre-Jev.ai Gate (Deterministic Pass)

Before calling jev.ai, run **locally**:

1. **Deterministic Auth detection (regex + keywords):**
   - Subject: "OTP", "one-time password", "2FA", "verification code", "magic link", "password reset", "confirm your email", "login alert", "security alert", "unusual activity", "suspicious activity", "unauthorized access".
   - Body: 4–10 digit code in isolation or with "code" nearby.
   - From/Reply-To: noreply, no-reply, security-alert, verify, confirm.
   - Headers: X-Priority: urgent, X-MSMail-Priority: High.
   - Result: If matched, set Auth=true locally and skip jev.ai call (or call for audit).

2. **Allowlist check (sender and domain):**
   - Check From against user-defined allowlist (exact address or domain).
   - Result: If matched, mail is exempt from Junk. File by normal classification (or Auth if Auth signal is also true).

**Gate Result:** If either is true, message goes to Auth. Do not call jev.ai for Auth; call once per email, with all categories.

### Post-Jev.ai Gate (Thresholds and Exceptions)

After jev.ai returns:

1. **Apply Auth threshold:** If jev.ai sys_auth=Yes and confidence ≥80%, route to Auth.
2. **Apply Junk threshold and exceptions:**
   - If jev.ai sys_junk=Yes, confidence >=90, AND jev.ai sys_auth=No, confidence >=90, AND
   - No receipt/bill pattern, AND
   - No reply history, AND
   - Not allowlisted, AND
   - No Auth signal:
     - Route to **Junk**.
   - Else: Route to **Needs review** or category filing.

3. **User denylist (marked junk):**
   - If user marked sender junk and no Auth signal, route to Junk (explicit user intent; review queue).
   - If Auth signal is present, ignore denylist; route to Auth.

### Core Rule: Auth Always Wins

**Never override Auth with Junk or a user-category filing.** If any Auth signal (deterministic, allowlist, or jev.ai ≥80%) is detected, the message goes to Auth and does not enter Junk, Needs review, or a user category.

---

## Idempotency and Caching

### Message ID Idempotency

Each message has a unique `message_id`. If the same message ID is re-processed:

1. **Check cache:** Look up `message_id` in the classification cache.
2. **If found:** Return cached result (do not call jev.ai again).
3. **If not found:** Call jev.ai, cache the response, and return the result.

### Cache Key

```
cache_key = sha256(message_id)
```

### Cache Value

```json
{
  "message_id": "msg_abc123def456",
  "classification": "cat_007",  // Primary category or sys_auth / sys_junk / sys_review
  "all_yes_labels": ["cat_007", "cat_020"],  // For debugging
  "jev_response": { ... },  // Full jev.ai response
  "cached_at": "2026-09-29T14:32:00Z",
  "ttl_seconds": 7776000  // 90 days
}
```

### Cache TTL

- **Default:** 90 days (7,776,000 seconds).
- Rationale: Mail is immutable; re-delivery is rare. Long TTL saves API calls.

### Invalidation

- **User disables a category:** Invalidate cache entries for messages that were filed to that category.
- **User adds, deletes or disables a category:** Invalidate cache entries (re-rank multi-yes results). No user priority ordering in v1.
- **User updates allowlist/denylist:** Invalidate all cache entries (re-evaluate Auth and Junk gates).

### Implementation Note

Use a local database (SQLite, LevelDB, or similar) keyed by `message_id`. Store jev.ai response and final classification. Serialize as JSON for easy inspection.

---

## Cost and Performance Notes

### Questions Per Request

- **Ship default:** 36 (defaults) + 2 (system) = 38 questions.
- **Maximum:** 48 (max categories) + 2 (system) = 50 questions.
- **Average:** ~38–45 questions per user.

### API Calls

- **One call per message:** No batching across multiple messages.
- **Batching within a message:** All questions for a single message in one jev.ai call.
- **Typical latency:** 1–3 seconds per call (depending on model and provider load).

### Cost Scaling

- **Per-question or per-call pricing:** Confirm with jev.ai whether pricing is linear (per question) or flat (per call).
- **Estimate:** If jev.ai charges per call, cost is ~0.001–0.01 USD per message (rough).
- **Daily volume:** For 10,000 messages/day, budget ~10–100 USD/day.

### Caching Benefit

- Cached classification (hit): ~1 ms, ~0 cost.
- Unjunk retry (provider error): Do not retry in the same session; let next re-delivery trigger fresh classification.

### Optimization Opportunities

1. **Lazy category loading:** If user has <36 enabled categories, fewer questions per call.
2. **Batched confidence thresholds:** Jev.ai could batch multiple messages and return results in one response (spec for future version).
3. **Model tuning:** Request jev.ai to optimize for low latency on categories like Promotions, Newsletters, and Shopping (high volume, low false-positive cost).

---

## Privacy and Data Protection

### PII Minimization

- **Send:** From, Subject, Snippet (500 char), Auth-Results header.
- **Do NOT send:** Full body, attachments, passwords, session tokens, IP, device info, user email (except in message headers for context).

### Data Retention

- **Jev.ai:** Assume jev.ai retains request/response logs per their privacy policy. Request explicit data deletion SLAs (e.g., 30-day retention).
- **Client cache:** Store jev.ai responses locally for 90 days, then delete.

### Compliance

- **GDPR:** Subject to deletion requests on user email deletion. Implement a cleanup task to delete cached jev.ai responses for that user within 30 days.
- **CCPA:** User can request a data export of their classification cache.
- **Subpoena:** Jev.ai responses are subject to legal holds. Document retention policy.

### Logging

- Log message IDs, classification results, and error codes.
- Do NOT log full message content, subject, or from field in plaintext logs (use hashes or aggregates).

---

## Reworded cat_029 Accounts Question

### Original (Conflicts with Auth)

> "Is this an account creation, password, account confirmation, or account management message?"

### Reworded (Excludes Auth and Security)

> "Is this an account creation, billing address update, account confirmation, or account management message that is NOT a security alert or password reset?"

### Rationale

The original question overlaps with the Auth system bucket. Reworording explicitly excludes security mail (password resets, security alerts), which always route to Auth if an Auth signal is present. The reworded question captures non-security account maintenance (e.g., billing updates, profile changes, account confirmations for non-sensitive purposes like email verification for newsletters).

### Implementation

- Update jev.ai's question catalog with the reworded text for cat_029.
- When constructing the request, use the reworded text.
- If user disables cat_029 (Accounts category), jev.ai skips the question entirely.

---

## Worked Examples

### Example 1: OTP from Google (Auth)

**Input:**
```json
{
  "message_id": "msg_001",
  "fields": {
    "from": "noreply@google.com",
    "subject": "Your Google verification code is 123456",
    "snippet": "Your one-time password (OTP) is 123456. Do not share..."
  }
}
```

**Local Deterministic Gate:**
- Subject contains "verification code" → Auth=true (match rule 1A).
- Skip jev.ai call; route to **Auth** immediately.

**Result:** Auth bucket.

---

### Example 2: Shipping Notification from Amazon (Shipping Category)

**Input:**
```json
{
  "message_id": "msg_002",
  "fields": {
    "from": "shipment-tracking@amazon.com",
    "subject": "Your Amazon order has shipped",
    "snippet": "Order #123-4567890-1234567 is on the way. Tracking: ..."
  }
}
```

**Local Deterministic Gate:**
- No Auth patterns.
- Amazon not in allowlist.
- Proceed to jev.ai.

**Jev.ai Call:**
```json
{
  "questions": [
    { "question_id": "cat_007", "text": "Is this a receipt or invoice..." },
    { "question_id": "cat_010", "text": "Is this a shipping notification..." },
    { "question_id": "cat_020", "text": "Is this a promotional offer..." },
    { "question_id": "sys_auth", "text": "Is this mail from a provider..." },
    { "question_id": "sys_junk", "text": "Is this likely spam..." }
  ]
}
```

**Jev.ai Response:**
```json
{
  "answers": [
    { "question_id": "cat_007", "answer": true, "confidence": 85 },
    { "question_id": "cat_010", "answer": true, "confidence": 92 },
    { "question_id": "cat_020", "answer": false, "confidence": 95 },
    { "question_id": "sys_auth", "answer": false, "confidence": 88 },
    { "question_id": "sys_junk", "answer": false, "confidence": 96 }
  ]
}
```

**Local Post-Jev.ai Gate:**
- sys_auth=No, confidence 88% → No Auth signal.
- sys_junk=No, confidence 96% → No junk signal.
- Multi-yes: cat_007 (85%), cat_010 (92%).
- Primary: cat_010 (Shipping, highest confidence).
- Receipt pattern: Yes (subject contains "shipped", snippets contains "Order #").
- Reply history: No.
- All exceptions met; route to **cat_010 (Shipping)**.

**Result:** Shipping category.

---

### Example 3: Newsletter from Substack (Low Junk Confidence, Needs Review)

**Input:**
```json
{
  "message_id": "msg_003",
  "fields": {
    "from": "newsletter@substack.com",
    "subject": "This Week's Top Stories",
    "snippet": "Here are this week's trending topics on Substack..."
  }
}
```

**Local Deterministic Gate:**
- No Auth patterns.
- Not allowlisted.
- Proceed to jev.ai.

**Jev.ai Response:**
```json
{
  "answers": [
    { "question_id": "cat_019", "answer": true, "confidence": 88 },
    { "question_id": "cat_020", "answer": true, "confidence": 72 },
    { "question_id": "sys_auth", "answer": false, "confidence": 92 },
    { "question_id": "sys_junk", "answer": true, "confidence": 68 }
  ]
}
```

**Local Post-Jev.ai Gate:**
- sys_auth=No, confidence 92% → No Auth signal.
- sys_junk=Yes, confidence 68% → Below the 90 threshold for Junk.
- Confidence 68% < 90 → Do not route to Junk; route to **Needs review** (low confidence on junk decision).

**Result:** Needs review (user can manually file to Newsletters or trash).

---

### Example 4: Phishing Email (High Junk Confidence, Junk Category)

**Input:**
```json
{
  "message_id": "msg_004",
  "fields": {
    "from": "no-reply@bank-secure-verify.com",
    "subject": "Confirm your banking details immediately",
    "snippet": "Click here to verify your account details now..."
  }
}
```

**Local Deterministic Gate:**
- No clear Auth patterns (fake bank domain, not legitimate provider).
- Not allowlisted.
- Proceed to jev.ai.

**Jev.ai Response:**
```json
{
  "answers": [
    { "question_id": "sys_auth", "answer": true, "confidence": 45 },
    { "question_id": "sys_junk", "answer": true, "confidence": 89 }
  ]
}
```

**Local Post-Jev.ai Gate:**
- sys_auth=Yes, confidence 45% → Low confidence (< 80%). Route to **Needs review** (not Auth, not Junk).

**Result:** Needs review (user should review before trusting; not auto-junked due to low Auth confidence).

---

### Example 5: Promotional Email, User Marked Sender Junk (Explicit Denylist)

**Input:**
```json
{
  "message_id": "msg_005",
  "fields": {
    "from": "promo@retailer.com",
    "subject": "Flash Sale: 50% Off Everything"
  }
}
```

**User has marked retailer.com as junk (denylist).**

**Local Deterministic Gate:**
- No Auth patterns.
- Not allowlisted.
- Sender is in user's denylist.
- Proceed to jev.ai.

**Jev.ai Response:**
```json
{
  "answers": [
    { "question_id": "sys_auth", "answer": false, "confidence": 94 },
    { "question_id": "sys_junk", "answer": true, "confidence": 88 }
  ]
}
```

**Local Post-Jev.ai Gate:**
- sys_auth=No, confidence 94% → No Auth signal.
- sys_junk=Yes, confidence 88% → below 90, but this is user-initiated Junk (explicit mark), so the jev.ai threshold does not apply.
- User denylist active → **Explicit user intent.**
- Route to **Junk** (review queue, not auto-delete).

**Result:** Junk (user marked sender junk; no Auth signal; explicit user intent overrides all other rules).

---

### Example 6: Account Confirmation Email (Non-Security)

**Input:**
```json
{
  "message_id": "msg_006",
  "fields": {
    "from": "support@cloudservice.com",
    "subject": "Billing address updated",
    "snippet": "Your billing address has been changed to: 123 Main St..."
  }
}
```

**Local Deterministic Gate:**
- No Auth patterns (subject is "billing address updated", not "password reset" or "verify").
- Not allowlisted.
- Proceed to jev.ai.

**Jev.ai Response:**
```json
{
  "answers": [
    { "question_id": "cat_029", "answer": true, "confidence": 87 },
    { "question_id": "sys_auth", "answer": false, "confidence": 91 },
    { "question_id": "sys_junk", "answer": false, "confidence": 93 }
  ]
}
```

**Local Post-Jev.ai Gate:**
- sys_auth=No, confidence 91% → No Auth signal.
- sys_junk=No, confidence 93% → No junk signal.
- cat_029=Yes, confidence 87% → Accounts category match (reworded question excludes security mail).
- Route to **cat_029 (Accounts)**.

**Result:** Accounts category.

---

### Example 7: Multiple Category Matches (Multi-Yes Resolution)

**Input:**
```json
{
  "message_id": "msg_007",
  "fields": {
    "from": "order@restaurant.com",
    "subject": "Your food delivery order #5678 is ready",
    "snippet": "Receipt #5678. Total: $42.50. Your order is being prepared..."
  }
}
```

**Jev.ai Response:**
```json
{
  "answers": [
    { "question_id": "cat_007", "answer": true, "confidence": 81 },
    { "question_id": "cat_009", "answer": true, "confidence": 79 },
    { "question_id": "cat_008", "answer": true, "confidence": 72 },
    { "question_id": "sys_auth", "answer": false, "confidence": 90 },
    { "question_id": "sys_junk", "answer": false, "confidence": 88 }
  ]
}
```

**Multi-Yes Resolution:**
- cat_007 (Receipts): 81%
- cat_009 (Food): 79%
- cat_008 (Shopping): 72%
- Rank by confidence: cat_007 > cat_009 > cat_008.
- Primary: **cat_007 (Receipts)**.
- All yes labels: [cat_007, cat_009, cat_008].

**Result:** Receipts category (file message here).

---

## Summary Table

| Scenario | Auth Signal | Jev.ai Auth | Jev.ai Junk | Result | Reasoning |
|----------|-------------|------------|------------|--------|-----------|
| OTP from Google | Deterministic (yes) | N/A | N/A | Auth | Deterministic rule matches before jev.ai call. |
| Newsletter, low junk conf | No | No (92%) | Yes (68%) | Needs review | Junk confidence 68% < 90; low confidence gate. |
| High-confidence phishing | No | Yes (45%) | Yes (89%) | Needs review | Auth confidence 45% < 80 and Auth yes below 60; low confidence gate. |
| User marked sender junk | No | No (94%) | Yes (88%) | Junk | No Auth signal; user denylist + high junk conf. |
| Billing address update | No | No (91%) | No (93%) | Accounts | cat_029 matches; non-security account mail. |
| Shipping from Amazon | No | No (88%) | No (96%) | Shipping | Multi-yes; cat_010 highest (92%); receipt pattern. |
| Multi-yes (receipt, food, shop) | No | No (90%) | No (88%) | Receipts | cat_007 (81%), cat_009 (79%), cat_008 (72%); rank by confidence. |

---

## Implementation Checklist

- [ ] Construct request JSON with message ID, redacted fields, enabled categories, and question set.
- [ ] Validate jev.ai response: all questions answered, confidence in range 0–100.
- [ ] Implement deterministic Auth gate (regex + keywords) before jev.ai call.
- [ ] Implement allowlist check (sender and domain) before jev.ai call.
- [ ] Implement timeout logic: 3 second max, 2 retries, then Needs review.
- [ ] Apply Auth thresholds: yes >=80 routes to Auth, yes 60-79 routes to Needs review; Auth no must be >=90 for Junk to be considered.
- [ ] Apply Junk threshold: >=90 (with Auth no >=90 and all backstops) routes to Junk; anything lower routes to Needs review.
- [ ] Implement on-device redaction of 4-10 digit codes and reset/verify link tokens before building the request; abort to Needs review if redaction fails.
- [ ] Timeout 3 s and 2 retries are placeholders; any timeout or error routes to Needs review, never Junk.
- [ ] Implement receipt/bill pattern exception (deterministic).
- [ ] Implement reply-history exception (sender in Sent folder).
- [ ] Implement user denylist (marked junk) with Auth override.
- [ ] Implement multi-yes resolution: rank by confidence, ties by catalogue order.
- [ ] Implement no-yes fallback: cat_036 (Other) or Needs review.
- [ ] Implement idempotency: cache by message ID, TTL 90 days.
- [ ] Use reworded cat_029 question (exclude security).
- [ ] Log classification results (message ID, category, confidence, exceptions applied).
- [ ] Monitor false positive rate (legitimate mail → Junk) and false negative rate (spam → user category).
- [ ] Test with all worked examples (7 scenarios above).

---

## Conclusion

Jev Inbox classifies each message with a single, deterministic jev.ai call. The request carries only four fields (From, Subject, a 500-character snippet, Auth-Results), with codes and reset or verify link tokens redacted on device, and the response delivers yes/no answers with confidence scores. Local safety gates (Auth detection, allowlist, never-junk thresholds) run before and after the jev.ai call to ensure security mail never lands in Junk and provider errors route safely to Needs review. Caching by message ID saves API calls. The reworded cat_029 question avoids overlap with Auth. Multi-yes resolution ranks by confidence and breaks ties by catalogue order. This contract ensures one call per email, cheap scaling, and privacy-preserving classification.
