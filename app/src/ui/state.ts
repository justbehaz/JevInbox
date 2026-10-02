// App state for the UI. v1 runs on a seeded demo mailbox (in-memory fake IMAP server, in-memory
// SQLite, scripted jev.ai). Nothing is written to disk and no account is connected.
import { CategoryManager } from "../categories/manager";
import { DemoJev } from "../demo/demoJev";
import { demoScripts, seedMailbox } from "../demo/seed";
import { JevClient } from "../jev/types";
import { runPipeline } from "../pipeline/run";
import { ImapAdapter } from "../providers/imap/adapter";
import { FakeImapTransport } from "../providers/imap/testing/fakeTransport";
import { SenderStore } from "../senders/store";
import { recordOutcome } from "../senders/wiring";

export interface AppState {
  accountId: string;
  inboxFolder: string;
  adapter: ImapAdapter;
  transport: FakeImapTransport;
  store: SenderStore;
  jev: JevClient;
  categories: CategoryManager;
}

export async function createDemoState(): Promise<AppState> {
  const transport = new FakeImapTransport({ move: true, idle: false });
  seedMailbox(transport);
  const adapter = new ImapAdapter({ transport, providerName: "demo" });
  await adapter.connect();
  const store = SenderStore.open();
  const jev = new DemoJev(demoScripts());
  const categories = new CategoryManager();
  const state: AppState = { accountId: "default", inboxFolder: "INBOX", adapter, transport, store, jev, categories };
  await ingest(state);
  return state;
}

/** Fetch new mail -> redact -> never-junk gate -> move -> store. Uses the existing pipeline. */
export async function ingest(state: AppState, cursor?: string): Promise<string> {
  const res = await runPipeline({
    adapter: state.adapter,
    folder: state.inboxFolder,
    jev: state.jev,
    user: state.store.userContext(),
    cursor,
    gateOptions: { categories: state.categories.enabled() },
    onClassified: (detail, outcome) => recordOutcome(state.store, detail, outcome, state.accountId),
  });
  return res.cursor;
}

const KEY = "__jevInboxState";
export function getAppState(): Promise<AppState> {
  const g = globalThis as unknown as Record<string, Promise<AppState> | undefined>;
  return (g[KEY] ??= createDemoState());
}
