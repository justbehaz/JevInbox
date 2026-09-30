# Jev Inbox Never-Junk Policy

## Overview

The never-junk gate is a mandatory safety layer that runs **before** any junk decision and before user-category filing. It protects authentication and account-security mail from landing in Junk, protects allowlisted senders, and ensures that low-confidence or provider failures route to Needs review, not Junk.

Auth mail goes to the Auth system bucket. Junk is a review queue, not an auto-delete bucket. This policy defines the exact precedence order and fail-safes.

---

## Hierarchy of Signals

### Order of Evaluation

1. **Auth detection pass** (deterministic rules and keywords)
2. **Allowlist check** (user-defined allowlist by sender address or domain)
3. **Jev.ai Auth yes/no question** (classifier-based confirmation)
4. **Junk evaluation** (only if no Auth signal, not allowlisted, and gate passes)
5. **User-category filing** (jev.ai yes/no questions for enabled categories)
6. **Fallback: Needs review** (low confidence, provider error, unclassified)

If any of steps 1–3 return true, the message routes to Auth and skips steps 4–5.

---

## Auth Signal Definition

A message is Auth if **any one** of the following is true:

### A. Deterministic Auth Detection (Rule-Based, No Confidence Required)

Regex and keyword matching on headers and body, no jev.ai call needed:

1. **Authenticator codes, OTP, 2FA**
   - Headers: `X-Priority: urgent`, `X-MSMail-Priority: High`
   - Subject line contains: `OTP`, `one-time`, `one time password`, `2FA`, `two-factor`, `verification code`, `authentication code`, `confirm your identity`
   - Body contains: `[0-9]{4,10}` (numeric code, 4–10 digits, in isolation or with "code" nearby)
   - Reply-To or From patterns: noreply, no-reply, security-alert, verify, confirm

2. **Magic link and password reset**
   - Subject contains: `magic link`, `verify your email`, `password reset`, `reset your password`, `confirm your email`, `activate your account`, `click here to`, `click to confirm`
   - Body contains: `magic link`, `reset link`, `password reset link`, or `https://[^\s]+(verify|reset|confirm)` (URL with verify/reset/confirm in path)
   - Reply-To or From: noreply, no-reply

3. **Account recovery and access recovery**
   - Subject contains: `account recovery`, `recover your account`, `regain access`, `restore access`, `help me log in`
   - Body contains: `recovery code`, `backup code`, `recovery link`

4. **Login alert and security alert**
   - Subject contains: `login attempt`, `login alert`, `sign in attempt`, `security alert`, `unusual activity`, `failed login`, `suspicious activity`, `compromised account`, `unauthorized access`, `verify login`, `confirm login`
   - From or Reply-To: security, alert, abuse, compliance, trust

### B. Allowlist Check (User-Defined, No Confidence Required)

1. **Sender allowlist by exact email address**
   - User has allowlisted `sender@example.com` → all mail from that address is exempt from Junk and is filed by normal classification (Auth if it carries an Auth signal).

2. **Sender allowlist by domain**
   - User has allowlisted `@example.com` → all mail from any address at that domain is exempt from Junk and is filed by normal classification (Auth if it carries an Auth signal).

**Allowlist precedence:** Allowlist always wins over the Junk decision. Allowlisted mail is never Junk. It goes to Auth only if it carries an Auth signal; otherwise it is filed by normal category classification (or Needs review).

### C. Jev.ai Auth Question (Classifier Confidence Required)

A single yes/no question to jev.ai:

**Question:** "Is this mail from a provider the user has an account with, and does it contain an authentication code, verification request, password reset link, login alert, or security alert?"

- **Yes, confidence >=80:** Auth signal detected. Route to Auth.
- **Yes, confidence 60-79 or <60:** Route to Needs review (low confidence, not Junk).
- **No, confidence >=90:** No Auth signal. Junk may be considered (full gate below).
- **No, confidence 60-89:** Not Auth for filing, but jev.ai-initiated Junk is BLOCKED (goes to Needs review if it would have been Junk; otherwise normal category filing).
- **No, confidence <60:** Route to Needs review (low confidence).
- **Provider timeout or error:** Route to Needs review (fail-safe).

---

## Auth Mail Never Overrides

### Precedence Table: User Marks Sender Junk

| Scenario | User Mark | Auth Signal | Result | Reasoning |
|----------|-----------|-------------|--------|-----------|
| OTP from Google, user marked Google junk | Junk | Yes (deterministic + allowlist override) | Auth | Auth always wins. User cannot silence security mail. |
| Magic link from GitHub, user marked GitHub junk | Junk | Yes (deterministic rule) | Auth | Auth always wins. |
| Login alert from bank, user marked bank junk | Junk | Yes (jev.ai Auth ≥80%) | Auth | Auth always wins. |
| Promo from a sender user marked junk | Junk | No (deterministic), No (jev.ai) | Junk | No Auth signal. User denylist applies. |
| Promo from a sender, user allowlisted sender | Allowlist | No | User category (e.g. Promotions) | Allowlist blocks Junk; it does not force Auth. |
| Receipt from Uber, user marked Uber junk | Junk | No (deterministic), No (jev.ai) | Junk | No Auth signal. User denylist applies; explicit user mark, so it goes to the Junk review queue (recoverable). |

**Rule:** User-defined denylist (marking sender junk) never overrides an Auth signal. If Auth is true, the message routes to Auth and stays out of Junk, regardless of the user's junk mark on that sender.

---

## Junk Gate: Deterministic Rule Pass

After Auth detection, allowlist check, and jev.ai Auth question, the message proceeds to the junk gate only if **no Auth signal** was raised.

### Junk Condition (All Must Be True)

Mail routes to Junk **if and only if**:

1. **No Auth signal** (failed steps 1–3 above), AND
2. **Jev.ai junk confidence >=90** AND **jev.ai Auth-no confidence >=90**, AND
3. **No receipt or bill pattern**, AND
4. **Not from a sender the user has replied to**, AND
5. **Not allowlisted by the user**

**If any condition fails, the message routes to Needs review, not Junk.**

### Explicit user junk mark (lead-resolved)

If the user has marked the sender junk, no Auth signal fired, and the sender is not allowlisted, mail goes to Junk regardless of jev.ai junk confidence and regardless of the receipt/reply exceptions (explicit user intent; Junk stays a review queue). The 90 thresholds, the sender-history guard and the receipt/reply exceptions apply only to jev.ai-initiated junking. **Security-shape exception (lead-added):** even for a user-marked sender, a message that hits the security-shape backstop below goes to Needs review, not Junk, so security-like mail is never auto-moved (including retroactive moves). Otherwise the user mark wins.


### Confidence Levels and Routing

- **Jev.ai junk >=90 AND all conditions met (including the Auth backstop section below):** Junk
- **Jev.ai junk yes below 90, or confidence missing:** Needs review
- **Jev.ai junk no, confidence >=60:** no junk signal; normal category filing
- **Jev.ai junk no, confidence <60:** Needs review
- **Jev.ai provider timeout or error:** Needs review (fail-safe)

---

## Receipt and Bill Exception

Mail matching receipt or bill patterns is **never** filed to Junk, even if jev.ai junk is high, because the user likely needs it for records and disputes.

**Patterns (deterministic, no confidence required):**
- Subject: `receipt`, `invoice`, `bill`, `order confirmation`, `purchase confirmation`, `payment confirmation`
- From: `receipt`, `invoice`, `billing`, `order`
- Body: `receipt`, `invoice number`, `order number`, `transaction ID`, `purchase confirmation`, `amount:`, `total:`

Mail matching these patterns routes to the user's category (e.g., Receipts, Shopping) or Needs review if unclassified, never to Junk.

---

## Sender Reply History Exception

Mail from any sender to whom the user has replied in the past (determined by checking the From address against the user's Sent or archive of recipients) **never** routes directly to Junk.

**Logic:**
1. On message arrival, check if From address is in the user's sent history.
2. If yes, route to Needs review or user category (jev.ai classification), never Junk.
3. If no, proceed with the junk gate normally.

**Rationale:** The user has engaged with this sender, so the message merits human review rather than automatic junking.

---

## Taxonomy Conflict: Accounts (cat_029) vs. Auth

**Conflict:** `cat_029 Accounts` is defined as "Is this an account creation, password, account confirmation, or account management message?" This overlaps with Auth system bucket.

**Resolution:**

- **Accounts category (cat_029) must NOT capture security mail.** The classifier question for cat_029 should be refined or disabled if it conflicts with Auth.
- **Auth always wins.** If a message is detected as Auth (deterministic rule, allowlist, or jev.ai Auth ≥80%), it routes to the Auth system bucket and **never** to cat_029, even if the message contains account-related keywords.
- **Non-security account mail (e.g., billing address update, account settings change) MAY be filed to cat_029** if no Auth signal is detected.

**Recommendation:** Modify the cat_029 question to exclude security:

> "Is this an account creation, billing address update, account confirmation, or account management message **that is NOT a security alert or password reset**?"

Or mark cat_029 as disabled by default and let users re-enable if needed, since Auth already captures account-security mail.

---

## Retroactive Rule: Marking a Sender Junk

When the user marks a sender junk (denylist action), the system's retroactive behavior is:

1. **Existing Auth mail from that sender:** Stays in Auth. Do not move.
2. **Existing non-Auth mail from that sender:** Optionally move to Junk review queue (not silent delete).
3. **Future mail from that sender:**
   - Auth signal detected (deterministic, allowlist, or jev.ai ≥80%) → Auth (ignores denylist).
   - No Auth signal → Junk or Needs review (denylist applies).

**User Communication:** "Marking this sender junk protects you from promotions and newsletters, but won't move or hide security alerts and password resets from them."

---

## Fail-Safe: Gate Errors

If the never-junk gate itself encounters an error at **any step**, the message routes to **Needs review**, never to Junk or directly to a user category.

**Error conditions:**
- jev.ai Auth question timeout or returns `error`
- Jev.ai junk question times out or returns `error`
- Allowlist database query fails
- Sender reply history lookup fails
- Regex engine crash or timeout

**Logic:**
```
if (gate_error):
    return Needs_review
else if (auth_signal):
    return Auth
else if (junk_condition):
    return Junk
else:
    return Needs_review or classify_categories
```

---

## No Silent Delete, No Auto-Purge

1. **Junk is a review queue.** Messages routed to Junk are not auto-deleted. The user can review and delete in bulk from the Junk view.
2. **No auto-purge by age.** Junk mail does not expire and auto-delete after N days. Manual deletion only.
3. **No training from odd subject lines.** Do not mark a message junk solely because it has an unusual subject line. If jev.ai junk confidence is low or the message has no other spam signals, it goes to Needs review.

---

## Jev.ai Contract for Never-Junk

The classifier must provide:

1. **Auth yes/no with confidence (0–100%)**
   - Question: "Is this mail from a provider the user has an account with, and does it contain an authentication code, verification request, password reset link, login alert, or security alert?"
   - Return: `{ auth_signal: bool, confidence: int }`

2. **Junk yes/no with confidence (0–100%)**
   - Question: "Is this likely spam, abuse, phishing, or unsolicited bulk mail?"
   - Return: `{ junk_signal: bool, confidence: int }`
   - Caveats: Do not return junk=true if the message is a receipt, bill, or from a known service.

3. **Timeout or error handling**
   - Max latency: 3 seconds per question.
   - On timeout: Return `error` or `null`; gate routes to Needs review.

---

## Test Cases

| ID | Scenario | Det. Auth | Sec. Shape | Jev Auth | Jev Junk | User Mark | Allowlist | Receipt | Reply | Auth Hist | Bucket | Reason |
|----|----------|-----------|-----------|----------|----------|-----------|-----------|---------|-------|-----------|--------|--------|
| T1 | OTP from Google | Yes | No | N/A | N/A | – | – | No | – | – | Auth | Deterministic rule: OTP keyword + code match. |
| T2 | Magic link from GitHub (allowlisted), deterministic pass misses | No | No | Yes 92 | – | – | Yes | No | – | – | Auth | Allowlist only exempts from Junk; Auth comes from the jev.ai Auth yes >=80. |
| T3 | Login alert from bank, user marked bank junk | Yes | No | N/A | N/A | Junk | – | No | – | – | Auth | Auth signal always wins over user denylist. |
| T4 | Verification code, jev.ai Auth 65% (low) | No | No | Yes 65 | N/A | – | – | No | – | – | Needs review | Auth yes but confidence 65% < 80; low confidence gate. |
| T5 | Password reset, jev.ai timeout | No | No | Timeout | – | – | – | No | – | – | Needs review | Provider error: timeout routes to Needs review (fail-safe). |
| T6 | Password reset deterministic match | Yes | No | N/A | N/A | – | – | No | – | – | Auth | Deterministic rule: "password reset" subject line. |
| T7 | Promo, user marked junk, jev.ai junk 92% | No | No | No 95 | Yes 92 | Junk | – | No | – | – | Junk | User-marked sender + no Auth + no security shape -> explicit junk (review queue). |
| T8 | Promo, user replied to sender before | No | No | No 91 | Yes 91 | – | – | No | Yes | – | Needs review | Reply-history exception overrides jev.ai junk (jev.ai-initiated rule only). |
| T9 | Phishing-like email, low junk confidence 55% | No | No | No 88 | Yes 55 | – | – | No | – | – | Needs review | Junk confidence 55% < 90; below threshold for jev.ai-initiated Junk. |
| T10 | Receipt from Uber, user marked Uber junk | No | No | No 92 | Yes 15 | Junk | – | Yes | – | – | Junk | User-marked sender (explicit intent) overrides receipt exception; goes to Junk review queue. |
| T11 | Bill from utility, user replied before | No | No | No 90 | Yes 88 | – | – | Yes | Yes | – | Needs review | Receipt+bill exception applies to jev.ai junk; reply history protects; goes to Needs review. |
| T12 | Verification code from new provider, jev.ai Auth 85% | No | No | Yes 85 | – | – | – | No | – | – | Auth | Jev.ai Auth yes, confidence 85% >= 80; Auth signal confirmed. |
| T13 | Newsletter, user marked junk, jev.ai junk 88% | No | No | No 92 | Yes 88 | Junk | – | No | – | – | Junk | Explicit user mark: the 90 threshold applies to jev.ai-initiated Junk only (corrected in code phase; earlier row said Needs review, contradicting the explicit-user-mark rule). |
| T14 | Account confirmation, Auth >=80% detected | Yes | No | N/A | N/A | – | – | No | – | – | Auth | Deterministic Auth signal; cat_029 override never applies. |
| T15 | Shipping notification from Amazon, marked junk | No | No | No 87 | Yes 12 | Junk | – | Yes | – | – | Junk | User-marked sender; receipt exception only protects jev.ai-initiated junk, not user marks. |
| T16 | Unusual password-reset wording, Auth no 85%, junk 80% | No | No | No 85 | Yes 80 | – | – | No | – | – | Needs review | Auth no 85% < 90 (blocks jev.ai junk); junk 80% < 90 (not junk anyway). |
| T17 | Similar unusual wording, Auth no 95%, junk 95%, body has 6-digit code | No | Yes | No 95 | Yes 95 | – | – | No | – | – | Needs review | Security-shape backstop (code in body) triggers; never Junk even with high confidence. |
| T18 | Login notice, Auth no 95%, junk 95%, sender domain sent OTP before | No | No | No 95 | Yes 95 | – | – | No | – | Yes | Needs review | Sender-history guard (domain has Auth history); jev.ai-initiated Junk blocked. |
| T19 | Pure promo, Auth no 97%, junk 93%, no security shape, no sender history | No | No | No 97 | Yes 93 | – | – | No | – | – | Junk | All conditions for jev.ai Junk met: Auth no >=90, junk >=90, no backstops, no history. |
| T20 | User-marked sender sends OTP | Yes | No | N/A | N/A | Junk | – | No | – | – | Auth | Auth signal overrides user denylist; user cannot silence security mail. |
| T21 | User-marked sender sends promotional email | No | No | No 93 | Yes 91 | Junk | – | No | – | – | Junk | No Auth signal, user mark active, no security shape; explicit junk applies. |
| T22 | User-marked sender, security-like message but no Auth flag | No | Yes | No 92 | Yes 89 | Junk | – | No | – | – | Needs review | Security-shape backstop overrides user mark; suspected security mail routed to review. |
| T23 | CODE REDACTION: 6-digit code, deterministic Auth on original text | Yes | No | N/A | N/A | – | – | No | – | – | Auth | Original text triggers deterministic Auth pass; jev.ai request carries [CODE], never the digits. |
| T24 | CODE REDACTION: deterministic misses, jev.ai gets [CODE], Auth no 92%, junk no 88% | No | No | No 92 | No 88 | – | – | No | – | – | Normal category filing | Deterministic missed; jev.ai request carried [CODE]. Auth no 92 allows the junk gate, but junk no 88 (>=60) means no junk signal, so the mail is filed by category (Needs review if no category matches confidently). Note: a 6-digit code would trip the security-shape backstop, so this row applies only to non-code cases; with a code present see T23. |
| T25 | Jev.ai TIMEOUT on sys_auth question (after retries) | No | No | Timeout | – | – | – | No | – | – | Needs review | Timeout is provider error; fail-safe routes to Needs review, never Junk. |
| T26 | Jev.ai ERROR or malformed response | No | No | Error | – | – | – | No | – | – | Needs review | Provider error (malformed, unexpected status, etc.); fail-safe to Needs review. |

### Test Case Notes

- **T1–T3, T6, T12, T14, T20:** Auth signals (deterministic, allowlist, or jev.ai >=80%) always route to Auth; user denylist cannot suppress security mail.
- **T4, T5, T16:** Low jev.ai Auth confidence (60-79%) or timeout routes to Needs review, not Auth or Junk.
- **T7, T21:** User-marked sender with no Auth signal and no security shape -> Junk (explicit user intent; review queue, not auto-delete).
- **T8, T11:** Reply-history exception (jev.ai-initiated Junk only) protects engaged senders; user marks do not override reply history in jev.ai-initiated cases.
- **T9:** Jev.ai junk confidence below 90% is not Junk when the sender is not user-marked; routes to Needs review.
- **T13:** User-marked sender: junk confidence is irrelevant; explicit mark wins (Junk) absent Auth, allowlist and security shape.
- **T10, T15:** Receipts and bills from user-marked senders still go to Junk (user mark is explicit; receipt exception only protects jev.ai-initiated Junk).
- **T17, T22:** Security-shape backstop (keywords like "verify", "code", "confirm", or a 4-10 digit code in body) always routes to Needs review, even for user-marked senders or high jev.ai junk confidence.
- **T18:** Sender-history guard: if a sender's domain has ever produced an Auth-filed message, jev.ai-initiated Junk is blocked for that domain (Needs review instead).
- **T19:** Represents the pass case for jev.ai-initiated Junk: Auth no >=90, Junk >=90, all negative (no security shape, no sender Auth history, no reply history, no receipt, not allowlisted, no user mark exception applies).
- **T23, T24:** Code redaction happens on device before the jev.ai request is built; codes never leave the device. Deterministic Auth pass runs on original unredacted text.
- **T25, T26:** Timeout or provider error always routes to Needs review; placeholder values (3s timeout, 2 retries) are not load-bearing, but any timeout or error must route to Needs review, never Junk.

---

## Implementation Checklist

- [ ] Implement deterministic Auth detection (regex, keywords, headers on original unredacted text).
- [ ] Implement allowlist check (exact sender and domain).
- [ ] Implement Jev.ai Auth question with confidence threshold (>=80% for Auth, 60-79% for Needs review, <60% for low confidence).
- [ ] Implement Auth "no" confidence check: >=90 required for Junk gate to proceed; 60-89 blocks jev.ai-initiated Junk.
- [ ] Implement on-device code redaction: replace standalone 4-8 digit codes with [CODE] before building jev.ai request. If redaction fails, route to Needs review.
- [ ] Implement on-device link/token redaction: replace reset/verify/sign-in URLs and long tokens with [LINK] before request. If redaction fails, route to Needs review.
- [ ] Implement receipt and bill pattern detection (deterministic).
- [ ] Implement sender reply history lookup (check user Sent folder and recipient archive).
- [ ] Implement security-shape backstop: local regex for "verify", "confirm your", "code", "reset", "security", "login", "sign in", etc., and 4-10 digit code in isolation. Any match -> Needs review (never Junk from jev.ai).
- [ ] Implement sender-history guard: if a sender address or domain has ever produced an Auth-filed message, block jev.ai-initiated Junk for that sender/domain (Needs review instead).
- [ ] Implement Jev.ai junk question with confidence threshold: >=90% for Junk (subject to all backstops), <90% -> Needs review.
- [ ] Implement timeout and retry logic: max 3 seconds per question, 2 retries (placeholders); any timeout or error -> Needs review, never Junk.
- [ ] Implement fail-safe error handling: any gate error, malformed response, or missing answer routes to Needs review.
- [ ] Implement explicit user junk mark: no Auth + no allowlist + no security-shape hit -> Junk (review queue); if security-shape hit -> Needs review (backstop overrides mark).
- [ ] Implement retroactive denylist rule: Auth mail from marked-junk senders stays in Auth; existing non-Auth mail can move to Junk review queue.
- [ ] Implement user-category filing (only after Auth gate passes and no Junk decision).
- [ ] Implement UI: Needs review queue shows Auth, low-confidence, error cases, and security-shape backstop hits for user action.
- [ ] Document precedence table in user FAQ: "Can I silence security alerts by marking a sender junk? No; security mail always comes through."
- [ ] Refine cat_029 Accounts question to exclude password resets and security alerts.
- [ ] Monitor false positive rate (legitimate -> Junk) and false negative rate (spam -> user category); track security-mail precision (catch all Auth-relevant mail).

---

## Summary

The never-junk gate is **mandatory and deterministic**. Auth signals override all other routing decisions, including user-defined denylist. Low confidence and provider errors route to Needs review, not Junk. Junk is a review queue, not a delete bucket. User engagement (reply history) and transactional patterns (receipt, bill) are protected from Junk. The gate's core principle: security mail and user-engaged senders never auto-junk; spam review is always human-mediated.

## Auth Backstop for jev.ai-initiated Junk (lead-added after review BLOCK)

Review finding: a double false negative (deterministic miss plus jev.ai Auth "no" at >=80) followed by jev.ai junk "yes" could file real security mail to Junk. These extra conditions are ALL required, in addition to the junk conditions above, before jev.ai may initiate Junk. Failing any one routes to Needs review, never Junk.

1. Broad security-shape backstop (deterministic, deliberately over-inclusive, checked on subject, snippet and body sample): any standalone 4-10 digit code; any of "verify", "verification", "confirm your", "one-time", "passcode", "security code", "reset", "recover", "sign-in", "sign in", "log in", "login", "new device", "unrecognized", "2-step", "two-step", "authenticator", "magic link", "secure link", "expires in" combined with a link or code. A hit means Needs review (never Junk) even if jev.ai says Auth = no.
2. Auth "no" must be >= 90 confidence for Junk to proceed (80-89 "no" goes to Needs review). Junk "yes" must be >= 90 for jev.ai-initiated Junk.
3. Sender-history guard: if the sender address or domain has EVER produced an Auth-filed message for this user, jev.ai-initiated Junk is blocked for that sender and domain (Needs review instead). Only the explicit user mark-junk rule applies to such senders, and it still never overrides Auth.
4. Auth-bearing senders are not offered auto-junk in any UI suggestion.
5. Residual risk (stated honestly): no classifier guarantees zero misses. The guarantee is structural: jev.ai alone can never produce Junk for mail that has any security shape, any Auth history, or any doubt. (See test cases T16–T19 above for the merged backstop test scenarios.)

## Timeouts, Errors and Redaction Failures (stated explicitly)

- Any jev.ai timeout, error, partial or malformed response, or exhausted retry routes the message to Needs review, never Junk. The 3 s timeout and 2 retries are placeholders until the jev.ai API docs arrive; the Needs review routing does not depend on those values.
- Before any request, standalone 4-8 digit codes and reset/verify link tokens are redacted on device from Subject and Snippet (see 03-jev-contract.md). One-time codes never leave the device. If redaction fails, no request is sent and the message goes to Needs review.
