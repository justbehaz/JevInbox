// Demo mailbox: in-memory fake IMAP server, in-memory SQLite, scripted jev.ai. Used when no account
// is saved. Nothing is written to disk and no credentials are needed.
import { CategoryManager } from "../categories/manager";
import { DemoJev } from "../demo/demoJev";
import { demoScripts, seedMailbox } from "../demo/seed";
import { runPipeline } from "../pipeline/run";
import { ImapAdapter } from "../providers/imap/adapter";
import { FakeImapTransport } from "../providers/imap/testing/fakeTransport";
import { SenderStore } from "../senders/store";
import { recordOutcome } from "../senders/wiring";
import type { AppState } from "./state";

export const DEMO_ACCOUNT = "default";

export interface DemoAppState extends AppState {
  transport: FakeImapTransport;
  adapter: ImapAdapter;
}

export async function createDemoState(): Promise<DemoAppState> {
  const transport = new FakeImapTransport({ move: true, idle: false });
  seedMailbox(transport);
  const adapter = new ImapAdapter({ transport, providerName: "demo" });
  await adapter.connect();
  const store = SenderStore.open();
  const state: DemoAppState = {
    mode: "demo", inboxFolder: "INBOX", store, categories: new CategoryManager(), jev: new DemoJev(demoScripts()),
    jevConnected: true, transport, adapter,
    adapterFor: async () => adapter,
    isPreview: () => false,
    accountIds: () => [DEMO_ACCOUNT],
  };
  await ingestDemo(state);
  return state;
}

/** Fetch -> redact -> never-junk gate -> move -> store, with the scripted stand-in for jev.ai. */
export async function ingestDemo(state: DemoAppState, cursor?: string): Promise<string> {
  const res = await runPipeline({
    adapter: state.adapter, folder: state.inboxFolder, jev: state.jev, user: state.store.userContext(), cursor,
    gateOptions: { categories: state.categories.enabled() },
    onClassified: (detail, outcome) => recordOutcome(state.store, detail, outcome, DEMO_ACCOUNT),
  });
  return res.cursor;
}
