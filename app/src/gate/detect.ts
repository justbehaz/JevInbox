// Deterministic passes. All run on ORIGINAL (unredacted) text, on device only.
import { Message } from "./types";

const has = (hay: string, needles: string[]) => {
  const h = hay.toLowerCase();
  return needles.some((n) => h.includes(n));
};

// ---- Deterministic Auth (02 section A). Interpretation note: the spec's sender
// patterns (noreply etc.) alone do NOT make mail Auth, otherwise every promo would be
// Auth. A sender pattern only counts together with a subject/body signal.
const SUBJECT_AUTH = [
  "otp", "one-time", "one time password", "2fa", "two-factor", "verification code",
  "authentication code", "confirm your identity", "magic link", "verify your email",
  "password reset", "reset your password", "confirm your email", "activate your account",
  "account recovery", "recover your account", "regain access", "restore access",
  "help me log in", "login attempt", "login alert", "sign in attempt", "sign-in attempt",
  "security alert", "unusual activity", "failed login", "suspicious activity",
  "compromised account", "unauthorized access", "verify login", "confirm login",
  "new sign-in", "new login",
];
const BODY_AUTH = [
  "magic link", "reset link", "password reset link", "recovery code", "backup code",
  "recovery link", "verification code", "one-time code", "one-time password", "security code",
];
const AUTH_URL_RE = /https?:\/\/[^\s]+(verify|reset|confirm)/i;
const CODE_NEAR_RE = /(code|otp|pin|passcode)\W{0,20}\b\d{4,10}\b|\b\d{4,10}\b\W{0,20}(is your|code)/i;
const SECURITY_SENDER_RE = /(security|alert|abuse|compliance|trust|verify|confirm)/i;

export function deterministicAuth(m: Message): boolean {
  if (has(m.subject, SUBJECT_AUTH)) return true;
  if (has(m.body, BODY_AUTH)) return true;
  if (AUTH_URL_RE.test(m.body)) return true;
  if (CODE_NEAR_RE.test(m.body) || CODE_NEAR_RE.test(m.subject)) return true;
  // sender pattern needs a supporting security word
  if (SECURITY_SENDER_RE.test(m.from) && has(m.subject + " " + m.body, ["password", "sign in", "sign-in", "login", "log in", "code", "account"])) return true;
  return false;
}

// ---- Security-shape backstop (02 "Auth Backstop"): deliberately over-inclusive.
const SHAPE_WORDS = [
  "verify", "verification", "confirm your", "one-time", "passcode", "security code",
  "reset", "recover", "sign-in", "sign in", "log in", "login", "new device", "unrecognized",
  "2-step", "two-step", "authenticator", "magic link", "secure link", "expires in",
];
const STANDALONE_CODE_RE = /(?<![\w@.#-])\d{4,10}(?![\w])/;

export function securityShape(m: Message): boolean {
  const text = `${m.subject}\n${m.body}`;
  if (STANDALONE_CODE_RE.test(text)) return true;
  return has(text, SHAPE_WORDS);
}

// ---- Receipt / bill (02 exception). "noreply" senders are NOT a pattern by themselves.
const RB_SUBJECT = ["receipt", "invoice", "bill", "order confirmation", "purchase confirmation", "payment confirmation"];
const RB_FROM = ["receipt", "invoice", "billing", "order"];
const RB_BODY = ["receipt", "invoice number", "order number", "transaction id", "purchase confirmation", "amount:", "total:"];

export function receiptOrBill(m: Message): boolean {
  return has(m.subject, RB_SUBJECT) || has(m.from, RB_FROM) || has(m.body, RB_BODY);
}

// ---- Address helpers
export function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}
export function domainOf(address: string): string {
  const i = address.lastIndexOf("@");
  return i >= 0 ? address.slice(i + 1) : "";
}
export function matchesList(list: string[], address: string): boolean {
  const d = domainOf(address);
  return list.some((e) => {
    const x = e.trim().toLowerCase();
    return x.startsWith("@") ? x.slice(1) === d : x === address;
  });
}
