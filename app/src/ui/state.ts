// App state seen by the UI action layer. The runtime (src/runtime) decides whether this is the demo
// mailbox or the user's saved accounts.
import type { CategoryManager } from "../categories/manager";
import type { JevClient } from "../jev/types";
import type { ImapAdapter } from "../providers/imap/adapter";
import type { SenderStore } from "../senders/store";
import { getRuntime } from "../runtime/runtime";

export interface AppState {
  mode: "demo" | "live";
  inboxFolder: string;
  store: SenderStore;
  categories: CategoryManager;
  jev: JevClient;
  /** False until the real jev.ai client exists: deterministic rules only. */
  jevConnected: boolean;
  /** A connected adapter for one account (cached). */
  adapterFor(accountId: string): Promise<ImapAdapter>;
  accountIds(): string[];
}

export async function getAppState(): Promise<AppState> {
  return (await getRuntime()).state;
}
