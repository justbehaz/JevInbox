// Types for the never-junk gate. Spec: inbox/02-never-junk.md, 03-jev-contract.md.

export type Bucket = "auth" | "junk" | "needs_review" | "category";

export type ReasonCode =
  | "deterministic_auth"
  | "jev_auth_yes"
  | "jev_auth_low_confidence"
  | "security_shape_backstop"
  | "user_marked_junk"
  | "jev_junk"
  | "junk_blocked_low_confidence"
  | "junk_blocked_auth_not_sure"
  | "junk_blocked_receipt_or_bill"
  | "junk_blocked_reply_history"
  | "junk_blocked_allowlisted"
  | "junk_blocked_sender_auth_history"
  | "category_match"
  | "no_category_match"
  | "provider_error"
  | "invalid_response"
  | "redaction_failed"
  | "gate_error";

export interface Message {
  id: string;
  from: string; // full address, e.g. "Name <a@b.com>" or "a@b.com"
  replyTo?: string;
  subject: string;
  /** Body sample used ONLY locally by deterministic passes (never sent as is). */
  body: string;
}

export interface UserContext {
  /** Exact addresses ("a@b.com") or domains ("@b.com"). */
  allowlist: string[];
  /** Senders the user marked junk (same formats). */
  markedJunk: string[];
  /** True if the user has replied to this sender address. */
  hasRepliedTo: (address: string) => boolean;
  /** True if this address OR its domain has ever been filed as Auth. */
  hasAuthHistory: (address: string, domain: string) => boolean;
}

export interface GateResult {
  bucket: Bucket;
  categoryId?: string;
  reason: ReasonCode;
  trace: string[];
}
