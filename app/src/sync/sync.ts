// Sync = the existing pipeline (fetch, redact, never-junk gate, move) run for each saved account.
// jev.ai is not connected yet: the gate runs on deterministic rules only, nothing is ever junked,
// and only Auth mail is moved. Everything else stays in place (logged as Needs review where the gate
// says so). Cursors advance only past messages that were fully handled.
import type { AccountStore } from "../accounts/accountStore";
import { DisconnectedJev } from "../jev/disconnected";
import { JevClient } from "../jev/types";
import { runPipeline } from "../pipeline/run";
import { scrub } from "../providers/imap/sanitize";
import { SenderStore } from "../senders/store";
import { recordOutcome } from "../senders/wiring";
import { CategoryManager } from "../categories/manager";
import { ReconnectRequiredError } from "../oauth/tokens";
import type { MailAdapter } from "../providers/types";

export interface SyncSummary {
  accountId: string;
  processed: number;
  auth: number;
  needsReview: number;
  leftInPlace: number;
  preview?: boolean;
  error?: string;
}

export interface SyncDeps {
  accounts: AccountStore;
  store: SenderStore;
  categories: CategoryManager;
  adapterFor: (accountId: string) => Promise<MailAdapter>;
  jev?: JevClient;
  jevConnected?: boolean;
  folder?: string;
  initialLimit?: number;
  maxBatch?: number;
}

export class SyncService {
  private running: Promise<SyncSummary[]> | null = null;
  constructor(private readonly d: SyncDeps) {}

  /** One sync at a time; concurrent callers share the running one. */
  syncAll(): Promise<SyncSummary[]> {
    if (!this.running) {
      this.running = this.run().finally(() => { this.running = null; });
    }
    return this.running;
  }

  private async run(): Promise<SyncSummary[]> {
    const out: SyncSummary[] = [];
    for (const acct of this.d.accounts.list()) out.push(await this.syncOne(acct.id));
    return out;
  }

  async syncOne(accountId: string): Promise<SyncSummary> {
    const acct = this.d.accounts.get(accountId);
    const summary: SyncSummary = { accountId, processed: 0, auth: 0, needsReview: 0, leftInPlace: 0 };
    if (!acct) return { ...summary, error: "Unknown account." };
    summary.preview = acct.preview;
    try {
      const adapter = await this.d.adapterFor(accountId);
      const res = await runPipeline({
        adapter,
        folder: this.d.folder ?? "INBOX",
        jev: this.d.jev ?? new DisconnectedJev(),
        jevConnected: this.d.jevConnected ?? false,
        // Preview mode: classify and record in the app only; the adapter is read-only too.
        // Re-read per message, and fail closed (preview) if the account disappears.
        dryRun: () => this.d.accounts.get(accountId)?.preview ?? true,
        user: this.d.store.userContext(),
        cursor: acct.cursor ?? undefined,
        initialLimit: this.d.initialLimit ?? 200,
        maxBatch: this.d.maxBatch ?? 500,
        gateOptions: { categories: this.d.categories.enabled(), retries: 0 },
        onClassified: (detail, outcome) => recordOutcome(this.d.store, detail, outcome, accountId),
      });
      for (const o of res.outcomes) {
        summary.processed++;
        const bucket = o.move?.bucketUsed ?? o.target;
        if (bucket === "auth") summary.auth++;
        else if (bucket === "needs_review") summary.needsReview++;
        if (!o.move?.moved) summary.leftInPlace++;
        if (o.error) summary.error = o.error;
      }
      if (res.cursor) this.d.accounts.setCursor(accountId, res.cursor);
      const note = `${summary.processed} new: ${summary.auth} Auth, ${summary.needsReview} Needs review, ${summary.leftInPlace} left in place${acct.preview ? " (Preview: nothing moved)" : ""}`;
      this.d.accounts.recordSync(accountId, summary.error ? "error" : "ok", summary.error ? `${note}; ${scrub(summary.error, []).slice(0, 120)}` : note);
    } catch (e) {
      summary.error = scrub(e instanceof Error ? e.message : "sync failed", []).slice(0, 200);
      this.d.accounts.recordSync(accountId, e instanceof ReconnectRequiredError ? "reconnect" : "error", summary.error);
    }
    return summary;
  }
}

export function describeSync(s: SyncSummary[]): string {
  if (!s.length) return "No account is connected, so there is nothing to sync.";
  const errs = s.filter((x) => x.error);
  const n = s.reduce((a, x) => a + x.processed, 0);
  const auth = s.reduce((a, x) => a + x.auth, 0);
  const nr = s.reduce((a, x) => a + x.needsReview, 0);
  const base = `Synced ${n} new message${n === 1 ? "" : "s"}: ${auth} Auth, ${nr} in Needs review.${s.some((x) => x.preview) ? " Preview mode: nothing was moved on your mailbox." : ""}`;
  return errs.length ? `${base} ${errs.length} account${errs.length === 1 ? "" : "s"} had a problem: ${errs[0].error}` : base;
}
