import { MessageOutcome } from "../pipeline/run";
import { MailAdapter, MessageDetail } from "../providers/types";
import { JunkMover, RecordInput, SenderStore, StoredBucket } from "./store";

/** Provider-side mover for mark-junk retroactive moves. The adapter adds its own Auth guard. */
export function adapterMover(adapter: MailAdapter): JunkMover {
  return async ({ messageId, folder }) => {
    const r = await adapter.moveToBucket(folder, messageId, "junk");
    return { success: r.success && r.moved, bucketUsed: r.bucketUsed, newMessageId: r.newMessageId, folder: r.destination };
  };
}

export function toStoredBucket(b: string | null | undefined): StoredBucket | null {
  switch (b) {
    case "auth": case "junk": case "needs_review": case "inbox": return b;
    case "archive": return "archived";
    default: return null;
  }
}

/** Pipeline hook: store each classified message in the local sender view, at its FINAL location. */
export function recordOutcome(store: SenderStore, detail: MessageDetail, outcome: MessageOutcome, accountId = "default"): void {
  const moved = outcome.move?.moved ? outcome.move : null;
  const bucket: StoredBucket = toStoredBucket(moved?.bucketUsed) ?? toStoredBucket(outcome.target) ?? "category";
  const input: RecordInput = {
    messageId: moved?.newMessageId ?? detail.id,
    accountId,
    folder: moved?.destination ?? detail.folder,
    from: detail.from,
    subject: detail.subject,
    snippet: detail.snippet,
    date: detail.date,
    unread: detail.unread,
    bucket,
    categoryId: bucket === "category" ? outcome.gate.categoryId : undefined,
    reason: outcome.override ? "security_override" : outcome.gate.reason,
    bodySample: detail.bodySample,
  };
  store.recordMessage(input);
}
