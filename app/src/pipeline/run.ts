// fetch -> redact -> never-junk gate -> move.
// Redaction happens inside the gate before any jev.ai request is built (src/gate/gate.ts).
import { addressOf } from "../gate/detect";
import { canMoveToJunk, GateOptions, classify } from "../gate/gate";
import { Bucket, GateResult, Message, UserContext } from "../gate/types";
import { JevClient } from "../jev/types";
import { BucketName, MailAdapter, MessageDetail, MoveResult } from "../providers/types";

export interface PipelineOptions {
  adapter: MailAdapter;
  folder: string;
  jev: JevClient;
  user: UserContext;
  cursor?: string;
  gateOptions?: GateOptions;
  /** Called when a message is filed as Auth, so the sender-history guard can learn it. */
  recordAuth?: (address: string) => void;
  /**
   * False when jev.ai is not connected (deterministic rules only). Then nothing is ever junked, and
   * only Auth mail is moved; everything else is recorded where it logically belongs but left in place.
   */
  jevConnected?: boolean;
  /** Preview mode: classify and report only. No move is ever attempted. */
  dryRun?: boolean | (() => boolean);
  /** First sync of a mailbox looks at the newest N messages only. */
  initialLimit?: number;
  /** At most this many messages per run (the cursor stops after the last one handled). */
  maxBatch?: number;
  /** Called after each message is handled (e.g. to store it in the local sender view). */
  onClassified?: (detail: MessageDetail, outcome: MessageOutcome) => void;
}

export interface MessageOutcome {
  messageId: string;
  gate: GateResult;
  /** Bucket we asked the adapter to use, or null when the mail stays in place (categories). */
  target: BucketName | null;
  move: MoveResult | null;
  /** Set if the pipeline overrode the gate (should never happen for Auth). */
  override?: string;
  /** Set when the move was deliberately skipped (jev.ai not connected): the mail stays in place. */
  moveSkipped?: "jev_disconnected" | "preview";
  error?: string;
}

export interface PipelineResult {
  outcomes: MessageOutcome[];
  /** Advances only past messages that were fully handled. */
  cursor: string | undefined;
  resync: boolean;
}

function targetFor(bucket: Bucket): BucketName | null {
  switch (bucket) {
    case "auth": return "auth";
    case "junk": return "junk";
    case "needs_review": return "needs_review";
    case "category": return null; // category folders arrive in a later step; mail stays put
  }
}

export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const full = await o.adapter.listMessages(o.folder, { cursor: o.cursor, initialLimit: o.initialLimit });
  const truncated = o.maxBatch !== undefined && full.messages.length > o.maxBatch;
  const list = truncated ? { ...full, messages: full.messages.slice(0, o.maxBatch) } : full;
  const outcomes: MessageOutcome[] = [];
  let lastHandled: string | null = null;
  let failed = false;

  for (const summary of list.messages) {
    let outcome: MessageOutcome;
    let fetched: MessageDetail | undefined;
    try {
      const detail = await o.adapter.fetchHeadersAndSnippet(o.folder, summary.id);
      const message: Message = {
        id: detail.id,
        from: detail.from,
        replyTo: detail.replyTo,
        subject: detail.subject,
        body: detail.bodySample, // original text, local only; the gate redacts before jev.ai
      };
      fetched = detail;
      const gate = await classify(message, o.user, o.jev, o.gateOptions);
      let target = targetFor(gate.bucket);
      let override: string | undefined;

      // Defence in depth: whatever the gate said, Auth-looking mail never goes to Junk.
      if (target === "junk") {
        const check = canMoveToJunk(message, gate.bucket);
        if (!check.ok) {
          target = "needs_review";
          override = check.reason;
        }
      }
      if (gate.bucket === "auth") o.recordAuth?.(addressOf(detail.from));

      // jev.ai not connected: never junk, and only move Auth mail.
      let moveSkipped: MessageOutcome["moveSkipped"];
      // Evaluated per message, so turning Preview back on mid-run stops further moves at once.
      if (typeof o.dryRun === "function" ? o.dryRun() : o.dryRun) moveSkipped = "preview";
      if (o.jevConnected === false) {
        if (target === "junk") { target = "needs_review"; override = "jev_disconnected"; }
        if (target !== "auth" && !moveSkipped) moveSkipped = "jev_disconnected";
      }

      let move: MoveResult | null = null;
      if (target && !moveSkipped) move = await o.adapter.moveToBucket(o.folder, summary.id, target);
      outcome = { messageId: summary.id, gate, target, move, override, moveSkipped };
      if (move && !move.success) outcome.error = move.error ?? "move failed";
    } catch (e) {
      outcome = {
        messageId: summary.id,
        gate: { bucket: "needs_review", reason: "gate_error", trace: ["pipeline error"] },
        target: null,
        move: null,
        error: e instanceof Error ? e.message : "pipeline error",
      };
    }
    if (fetched) {
      try { o.onClassified?.(fetched, outcome); } catch { /* the sender view must never break filing */ }
    }
    outcomes.push(outcome);
    if (outcome.error) failed = true;
    if (!failed) lastHandled = summary.id;
  }

  const cursor = failed || truncated ? o.adapter.partialCursor(o.cursor, list.cursor, lastHandled) : list.cursor;
  return { outcomes, cursor, resync: list.resync };
}
