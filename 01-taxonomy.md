# Jev Inbox Category Taxonomy

## Core Principle

The classifier asks one yes/no question per enabled category, per email. Each question must be answerable by jev.ai in one pass and cheap to compute. Categories never imply junk for account-security mail. Promotions and newsletters are categories, not junk, unless the user marks the sender junk.

---

## System Buckets (Do Not Count Toward Cap)

These are system-reserved and do not consume any of the 48-category limit:

| ID | Name | Purpose |
|---|---|---|
| `sys_auth` | Auth | Authenticator, OTP, 2FA, verification code, magic link, password reset, account recovery, login or security alert. Never junk. Allowlisted senders/domains bypass junk. |
| `sys_junk` | Junk | Review queue for probable spam/abuse. No silent delete. Low-confidence mail goes to Needs review, not Junk. |
| `sys_review` | Needs review | Unclassified mail and provider failures. Classifier confidence below threshold or no match. Never Junk; never Other. |

---

## Default User Categories (36 Enabled at Ship, 12 Free Custom Slots)

**Hard cap: 48 total user categories.** User may rename, disable, or add custom until reaching 48. Custom adds stop at 48. Other is the only catch-all and is not junk.

| ID | Name | Jev.ai Yes/No Question |
|---|---|---|
| `cat_001` | Personal & Family | Is this personal correspondence from a friend or family member, or about a family matter? |
| `cat_002` | Work | Is this message from a work colleague, work project, or professional context? |
| `cat_003` | Finance | Is this about financial accounts, investments, banking, or money management? |
| `cat_004` | Tax | Is this about taxes, tax filing, tax refunds, or tax documents? |
| `cat_005` | Insurance | Is this about an insurance policy, claim, or insurance provider? |
| `cat_006` | Utilities | Is this from a utility provider (power, water, gas, internet, phone)? |
| `cat_007` | Receipts | Is this a receipt or invoice for a purchase or transaction? |
| `cat_008` | Shopping | Is this from a retailer, marketplace, or shopping-related seller? |
| `cat_009` | Food | Is this from a restaurant, food delivery, grocery, or food business? |
| `cat_010` | Shipping | Is this a shipping notification, tracking update, or delivery status? |
| `cat_011` | Travel | Is this about travel bookings, flights, hotels, or travel plans? |
| `cat_012` | Health | Is this from a health provider, clinic, pharmacy, or health-related sender? |
| `cat_013` | School & Kids | Is this from a school, university, daycare or educational institution, or about children or parenting? |
| `cat_014` | Government | Is this from a government agency or government official? |
| `cat_015` | Legal | Is this from a lawyer, law firm, or about legal matters? |
| `cat_016` | Jobs | Is this a job listing, job application, or recruitment message? |
| `cat_017` | Property | Is this about real estate, property, rent, or a landlord? |
| `cat_018` | Subscriptions | Is this a subscription service (paid or trial membership)? |
| `cat_019` | Newsletters | Is this a newsletter or regular mailing list subscription? |
| `cat_020` | Promotions | Is this a promotional offer, sale, coupon, or marketing campaign? |
| `cat_021` | Social | Is this from a social network or social media platform? |
| `cat_022` | Notifications | Is this an app or service notification alert? |
| `cat_023` | Events | Is this a calendar invite, meeting request, event invitation, event details or event registration? |
| `cat_024` | Support | Is this from customer support or technical support? |
| `cat_025` | Product updates | Is this a software update, release notes, or product announcement? |
| `cat_026` | Clubs | Is this from a club, group, or organization membership? |
| `cat_027` | Faith | Is this from a religious organization or faith community? |
| `cat_028` | Photos | Is this a photo sharing, photo storage, or photo service message? |
| `cat_029` | Accounts | Is this an account creation, billing address update, account confirmation, or account management message that is NOT a security alert, verification code, or password reset? |
| `cat_030` | Surveys | Is this a survey, feedback request, or research questionnaire? |
| `cat_031` | Projects | Is this about a project, project management, or collaboration? |
| `cat_032` | Vehicles | Is this about a vehicle, car, bike, or automotive service? |
| `cat_033` | Returns & Refunds | Is this about returning an item, a refund, a chargeback or a return label? |
| `cat_034` | Charity & Donations | Is this from a charity or nonprofit, or about a donation or fundraising? |
| `cat_035` | Warranties & Manuals | Is this about a product warranty, registration, user manual or recall notice? |
| `cat_036` | Other | Is this email none of the above? |

---

## Custom Category Behavior

**Free slots:** 12. User may add up to 12 custom categories (36 defaults + 12 = 48).

**Hard cap (no adds):** 48. When user reaches 48 enabled categories (36 default + custom), the add-category UI disables. Disabled categories COUNT toward the 48 cap until they are deleted. User must delete at least one category (disabling is not enough) to add a new custom category.

**Renaming and disabling:** User may disable (or delete) any of the 36 defaults or custom categories at any time. Only custom categories can be renamed (defaults keep their names so jev.ai questions stay stable). Disabled categories still count toward 48 until deleted.

**Migration:** If a user disables a category (it still counts toward 48 until deleted), mail in that category remains accessible in the user's archive but is not classified into it on new messages.

---

## Classifier Contract (Jev.ai)

- **One call per message:** For each enabled category, ask the yes/no question in parallel or sequence.
- **Question format:** Simple, unambiguous, one predicate.
- **Confidence threshold:** Questions returning confidence below the platform's default threshold route to Needs review, not Junk or Other.
- **Multiple matches:** The most confident yes wins as primary category. Ties break by catalogue order (lowest cat_ number first). All yes labels are stored. No user priority UI in v1.
- **Auth exceptions:** Auth detection is a separate pass (regex + allowlist) before classification. Auth never lands in Junk, Needs review, or user categories; it always lands in Auth.
- **Sender allowlist/denylist:** User-defined allowlist overrides Junk. User-defined denylist routes to Junk (but not Auth).

---

## Policies

1. **Promotions and newsletters are not junk.** They are user categories. User may mark a sender junk to opt out; this does not retroactively change category assignment.

2. **Account security mail never goes to junk.** Auth bucket is system-protected. Authenticator codes, OTP, 2FA, verification, password reset, account recovery, login alert, and security alert are hard-coded to Auth.

3. **Low confidence goes to Needs review.** Unclassifiable mail and provider failures route to Needs review, not Junk, not Other. User reviews and manually files as needed.

4. **Junk is a review queue.** No silent delete. User can bulk-delete from Junk, but the default is review-required.

5. **Other is the only catch-all.** If mail does not match any enabled category after the jev.ai pass, it lands in Other (cat_036), which counts toward the 36/48 cap.

6. **Sender view is local.** The UI groups messages by From header locally. This is not a category or a jev.ai question; it is a read-only grouping. Sender view does not count toward the cap.

---

## Summary

- **36 defaults:** Personal & Family, Work, Finance, Tax, Insurance, Utilities, Receipts, Shopping, Food, Shipping, Travel, Health, School & Kids, Government, Legal, Jobs, Property, Subscriptions, Newsletters, Promotions, Social, Notifications, Events (includes calendar invites), Support, Product updates, Clubs, Faith, Photos, Accounts, Surveys, Projects, Vehicles, Returns & Refunds, Charity & Donations, Warranties & Manuals, Other.
- **12 free slots:** User adds custom categories (e.g., "Mentor", "Side gig", "Board") up to 48.
- **3 system buckets (not counted):** Auth, Junk, Needs review.
- **Auth is protected.** Security mail never lands in Junk.
- **Low confidence is safe.** Unclassified mail routes to Needs review, not Junk.
