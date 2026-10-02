// App state seen by the UI action layer. The runtime (src/runtime) decides whether this is the demo
// mailbox or the user's saved accounts.
import type { CategoryManager } from "../categories/manager";
import type { JevClient } from "../jev/types";
import type { MailAdapter } from "../providers/types";
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
  adapterFor(accountId: string): Promise<MailAdapter>;
  /** Preview mode: filing is recorded in the app only and nothing is written to the server. */
  isPreview(accountId: string): boolean;
  accountIds(): string[];
}

export async function getAppState(): Promise<AppState> {
  return (await getRuntime()).state;
}
