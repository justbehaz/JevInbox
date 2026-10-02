import { MessageOutcome } from "../pipeline/run";
import { MailAdapter, MessageDetail } from "../providers/types";
import { JunkMover, RecordInput, SenderStore, StoredBucket } from "./store";

/** Provider-side mover for mark-junk retroactive moves. The adapter adds its own Auth guard. */
export function adapterMover(adapter: MailAdapter): JunkMover {
  return async ({ messageId, folder }) => {
    const r = await adapter.moveToBucket(folder, messageId, "junk");
    return { success: r.success && r.moved, bucketUsed: r.bucketUsed };
  };
}

/** Pipeline hook: store each classified message in the local sender view. */
export function recordOutcome(store: SenderStore, detail: MessageDetail, outcome: MessageOutcome, accountId = "default"): void {
  const bucket: StoredBucket = outcome.move?.bucketUsed ?? outcome.target ?? "category";
  const input: RecordInput = {
    messageId: detail.id,
    accountId,
    folder: detail.folder,
    from: detail.from,
    subject: detail.subject,
    snippet: detail.snippet,
    date: detail.date,
    unread: detail.unread,
    bucket,
    categoryId: outcome.gate.categoryId,
    bodySample: detail.bodySample,
  };
  store.recordMessage(input);
}
