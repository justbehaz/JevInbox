// The runtime owns persistence: the on-disk database (outside the repo), the secret store, the
// saved accounts, and which AppState the UI sees (demo mailbox when no account is saved).
import { homedir } from "node:os";
import { join } from "node:path";
import { AccountService, SecretCredentialsProvider, TransportFactory } from "../accounts/service";
import { AccountStore } from "../accounts/accountStore";
import { CategoryManager } from "../categories/manager";
import { DisconnectedJev } from "../jev/disconnected";
import { ImapAdapter } from "../providers/imap/adapter";
import { ImapFlowTransport } from "../providers/imap/imapflowTransport";
import { createSecretStore, SecretStore } from "../secrets";
import { SenderStore } from "../senders/store";
import { CategoryRepo } from "../storage/categoryRepo";
import { DB_FILE, ensureDataDir } from "../storage/dataDir";
import { openDb } from "../storage/db";
import { SyncService } from "../sync/sync";
import { createDemoState, DemoAppState } from "../ui/demo";
import type { AppState } from "../ui/state";
import type Database from "better-sqlite3";

const REUSE_MS = 4 * 60 * 1000; // reconnect adapters that have been idle for a while

export interface RuntimeDeps {
  dataDir: string;
  secrets: SecretStore;
  makeTransport?: TransportFactory;
  db?: Database.Database;
}

export class Runtime {
  readonly db: Database.Database;
  readonly accounts: AccountStore;
  readonly liveStore: SenderStore;
  readonly secrets: SecretStore;
  readonly service: AccountService;
  readonly sync: SyncService;
  private demo: DemoAppState | null = null;
  private live: AppState | null = null;
  private adapters = new Map<string, { adapter: ImapAdapter; at: number }>();
  private categories: CategoryManager;
  private makeTransport: TransportFactory;
  readonly dataDir: string;

  constructor(d: RuntimeDeps) {
    this.dataDir = d.dataDir;
    this.db = d.db ?? openDb(join(d.dataDir, DB_FILE));
    this.secrets = d.secrets;
    this.accounts = new AccountStore(this.db);
    this.liveStore = new SenderStore(this.db);
    const repo = new CategoryRepo(this.db);
    this.categories = new CategoryManager(undefined, repo.load() ?? undefined, (s) => repo.save(s));
    this.makeTransport = d.makeTransport ?? ((spec) => new ImapFlowTransport({
      accountId: spec.provider + ":" + spec.email, preset: spec.preset,
      credentials: { get: async () => spec.credentials },
    }));
    this.service = new AccountService({
      accounts: this.accounts, secrets: this.secrets, store: this.liveStore, makeTransport: this.makeTransport,
      onChange: () => this.dropAdapters(),
    });
    this.sync = new SyncService({
      accounts: this.accounts, store: this.liveStore, categories: this.categories,
      adapterFor: (id) => this.adapterFor(id), jev: new DisconnectedJev(), jevConnected: false,
    });
  }

  /** The demo mailbox is created lazily and kept in memory. */
  async demoState(): Promise<DemoAppState> {
    return (this.demo ??= await createDemoState());
  }

  get isLive(): boolean {
    return this.accounts.list().length > 0;
  }

  private dropAdapters(): void {
    for (const { adapter } of this.adapters.values()) void adapter.disconnect().catch(() => undefined);
    this.adapters.clear();
  }

  /** A connected adapter for a saved account. Credentials come from the secret store only. */
  async adapterFor(accountId: string): Promise<ImapAdapter> {
    const hit = this.adapters.get(accountId);
    if (hit && Date.now() - hit.at < REUSE_MS) return hit.adapter;
    if (hit) { await hit.adapter.disconnect().catch(() => undefined); this.adapters.delete(accountId); }
    const acct = this.accounts.get(accountId);
    if (!acct) throw new Error("Unknown account.");
    const creds = await new SecretCredentialsProvider(this.secrets, acct.id, acct.email).get();
    const preset = { name: acct.provider === "icloud" ? "iCloud" : "IMAP", host: acct.host, port: acct.port, tls: acct.tls, authHint: "app_password" as const };
    const adapter = new ImapAdapter({ transport: this.makeTransport({ provider: acct.provider, email: acct.email, preset, credentials: creds }), providerName: preset.name });
    await adapter.connect();
    this.adapters.set(accountId, { adapter, at: Date.now() });
    return adapter;
  }

  /** What the UI sees right now. */
  get state(): Promise<AppState> {
    return this.isLive ? Promise.resolve(this.liveState()) : this.demoState();
  }

  private liveState(): AppState {
    return (this.live ??= {
      mode: "live",
      inboxFolder: "INBOX",
      store: this.liveStore,
      categories: this.categories,
      jev: new DisconnectedJev(),
      jevConnected: false,
      adapterFor: (id) => this.adapterFor(id),
      accountIds: () => this.accounts.list().map((a) => a.id),
    });
  }
}

const KEY = "__jevRuntime";
export function getRuntime(): Promise<Runtime> {
  const g = globalThis as unknown as Record<string, Promise<Runtime> | undefined>;
  return (g[KEY] ??= Promise.resolve().then(buildDefaultRuntime));
}

function buildDefaultRuntime(): Runtime {
  const dataDir = ensureDataDir({ env: process.env, platform: process.platform, home: homedir(), cwd: process.cwd() });
  const secrets = createSecretStore({ platform: process.platform, env: process.env, dataDir });
  return new Runtime({ dataDir, secrets });
}
