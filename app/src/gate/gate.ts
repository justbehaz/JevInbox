// The never-junk gate. Spec: inbox/02-never-junk.md (+ 03-jev-contract.md thresholds).
//
// Invariants (checked by tests):
//  - Auth signals (deterministic, or jev.ai Auth yes >= 80) always yield Auth. Never Junk.
//  - Any timeout, error, malformed response, redaction failure or thrown exception yields Needs review.
//  - Junk only from: explicit user mark, or jev.ai-initiated junk that passes every backstop.
//  - Security-shaped mail is never Junk, even for a user-marked sender.
import { DEFAULT_CATEGORIES, Category } from "./categories";
import { addressOf, deterministicAuth, domainOf, matchesList, receiptOrBill, securityShape } from "./detect";
import { buildSnippet, containsCode, redactText } from "./redact";
import { GateResult, Message, ReasonCode, UserContext } from "./types";
import { JevAnswer, JevClient, JevRequest, JevResponse } from "../jev/types";

export const THRESHOLDS = {
  AUTH_YES: 80, // jev.ai Auth yes at or above => Auth
  AUTH_NO_FOR_JUNK: 90, // jev.ai Auth no at or above required for jev.ai-initiated Junk
  JUNK_YES: 90, // jev.ai junk yes at or above required for jev.ai-initiated Junk
  LOW: 60, // below this on Auth no / junk no => Needs review
  CATEGORY_YES: 60,
} as const;

// PLACEHOLDERS until jev.ai API docs arrive. Routing to Needs review does not depend on them.
export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_RETRIES = 2;

export interface GateOptions {
  categories?: Category[];
  timeoutMs?: number;
  retries?: number;
}

const done = (bucket: GateResult["bucket"], reason: ReasonCode, trace: string[], categoryId?: string): GateResult => ({
  bucket, reason, trace, ...(categoryId ? { categoryId } : {}),
});
const review = (reason: ReasonCode, trace: string[]) => done("needs_review", reason, trace);

export function buildRequest(m: Message, categories: Category[]): JevRequest {
  const request: JevRequest = {
    message_id: m.id,
    fields: {
      from: addressOf(m.from),
      subject: redactText(m.subject),
      snippet: buildSnippet(m.body),
    },
    questions: [
      { question_id: "sys_auth", text: "Is this mail from a provider the user has an account with, and does it contain an authentication code, verification request, password reset link, login alert, or security alert?" },
      { question_id: "sys_junk", text: "Is this unwanted mail (spam, scam or abuse)? Not a receipt, bill or known service." },
      ...categories.map((c) => ({ question_id: c.id, text: c.question })),
    ],
  };
  // Final check: no code may leave the device.
  if (containsCode(request.fields.subject) || containsCode(request.fields.snippet)) {
    throw new Error("redaction check failed: code still present");
  }
  return request;
}

async function callWithRetries(jev: JevClient, req: JevRequest, timeoutMs: number, retries: number): Promise<JevResponse> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await jev.classify(req, { timeoutMs });
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

function validate(res: JevResponse, req: JevRequest): Map<string, JevAnswer> | null {
  if (!res || typeof res !== "object") return null;
  if (res.status !== "success") return null; // partial/error/timeout/unknown => provider error
  if (!Array.isArray(res.answers)) return null;
  const asked = new Set(req.questions.map((q) => q.question_id));
  const map = new Map<string, JevAnswer>();
  for (const a of res.answers) {
    if (!a || typeof a.question_id !== "string" || typeof a.answer !== "boolean") return null;
    if (!Number.isInteger(a.confidence) || a.confidence < 0 || a.confidence > 100) return null;
    if (map.has(a.question_id) || !asked.has(a.question_id)) return null;
    map.set(a.question_id, a);
  }
  if (map.size !== asked.size) return null;
  return map;
}

export async function classify(m: Message, ctx: UserContext, jev: JevClient, opts: GateOptions = {}): Promise<GateResult> {
  const trace: string[] = [];
  try {
    return await classifyInner(m, ctx, jev, opts, trace);
  } catch (e) {
    trace.push(`gate error: ${(e as Error).message}`);
    return review("gate_error", trace); // fail-safe: never Junk
  }
}

async function classifyInner(m: Message, ctx: UserContext, jev: JevClient, opts: GateOptions, trace: string[]): Promise<GateResult> {
  const categories = opts.categories ?? DEFAULT_CATEGORIES;
  const address = addressOf(m.from);
  const domain = domainOf(address);

  // 1. Deterministic Auth on the original text. Skips jev.ai.
  if (deterministicAuth(m)) {
    trace.push("deterministic auth");
    return done("auth", "deterministic_auth", trace);
  }

  const allowlisted = matchesList(ctx.allowlist, address);
  const userMarked = matchesList(ctx.markedJunk, address);
  const shape = securityShape(m);
  trace.push(`allowlisted=${allowlisted} userMarked=${userMarked} securityShape=${shape}`);

  // 2. Build the redacted request. Failure => Needs review, nothing sent.
  let req: JevRequest;
  try {
    req = buildRequest(m, categories);
  } catch (e) {
    trace.push(`redaction failed: ${(e as Error).message}`);
    return review("redaction_failed", trace);
  }

  // 3. One jev.ai call (bounded retries). Any failure => Needs review.
  let res: JevResponse;
  try {
    res = await callWithRetries(jev, req, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.retries ?? DEFAULT_RETRIES);
  } catch (e) {
    trace.push(`provider error: ${(e as Error).message}`);
    return review("provider_error", trace);
  }
  const answers = validate(res, req);
  if (!answers) {
    trace.push("invalid jev.ai response");
    return review("invalid_response", trace);
  }
  const auth = answers.get("sys_auth")!;
  const junk = answers.get("sys_junk")!;
  trace.push(`jev auth=${auth.answer}@${auth.confidence} junk=${junk.answer}@${junk.confidence}`);

  // 4. Auth answers.
  if (auth.answer) {
    if (auth.confidence >= THRESHOLDS.AUTH_YES) return done("auth", "jev_auth_yes", trace);
    return review("jev_auth_low_confidence", trace); // yes below 80
  }
  if (auth.confidence < THRESHOLDS.LOW) return review("jev_auth_low_confidence", trace); // "no" below 60

  // 5. Security-shape backstop: never Junk, and not silently filed either.
  if (shape) return review("security_shape_backstop", trace);

  // 6. Explicit user mark (not allowlisted): Junk regardless of jev.ai junk confidence
  //    and regardless of receipt/reply exceptions. Auth already handled above.
  if (userMarked && !allowlisted) return done("junk", "user_marked_junk", trace);

  // 7. jev.ai-initiated Junk.
  if (junk.answer) {
    if (junk.confidence < THRESHOLDS.JUNK_YES) return review("junk_blocked_low_confidence", trace);
    if (auth.confidence < THRESHOLDS.AUTH_NO_FOR_JUNK) return review("junk_blocked_auth_not_sure", trace);
    if (allowlisted) return review("junk_blocked_allowlisted", trace);
    if (receiptOrBill(m)) return review("junk_blocked_receipt_or_bill", trace);
    if (ctx.hasRepliedTo(address)) return review("junk_blocked_reply_history", trace);
    if (ctx.hasAuthHistory(address, domain)) return review("junk_blocked_sender_auth_history", trace);
    return done("junk", "jev_junk", trace);
  }
  if (junk.confidence < THRESHOLDS.LOW) return review("junk_blocked_low_confidence", trace); // "no" below 60

  // 8. Category filing: most confident yes wins, ties by catalogue order.
  let best: { id: string; conf: number; order: number } | null = null;
  categories.forEach((c, order) => {
    const a = answers.get(c.id)!;
    if (a.answer && a.confidence >= THRESHOLDS.CATEGORY_YES) {
      if (!best || a.confidence > best.conf || (a.confidence === best.conf && order < best.order)) {
        best = { id: c.id, conf: a.confidence, order };
      }
    }
  });
  if (best) return done("category", "category_match", trace, (best as { id: string }).id);
  return review("no_category_match", trace);
}

/**
 * Guard for manual moves, bulk moves and retroactive mark-sender-junk moves.
 * Auth mail and security-shaped mail can never be moved to Junk by these paths.
 */
export function canMoveToJunk(m: Message, currentBucket: GateResult["bucket"]): { ok: boolean; reason?: string } {
  if (currentBucket === "auth") return { ok: false, reason: "Security mail (Auth) cannot be moved to Junk." };
  if (deterministicAuth(m)) return { ok: false, reason: "Looks like security mail; it stays out of Junk." };
  if (securityShape(m)) return { ok: false, reason: "Looks like security mail; sent to Needs review instead." };
  return { ok: true };
}
