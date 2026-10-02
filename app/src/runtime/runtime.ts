// The runtime owns persistence: the on-disk database (outside the repo), the secret store, the
// saved accounts, and which AppState the UI sees (demo mailbox when no account is saved).
import { homedir } from "node:os";
import { join } from "node:path";
import { AccountService, SecretCredentialsProvider, TransportFactory } from "../accounts/service";
import { AccountStore } from "../accounts/accountStore";
import { CategoryManager } from "../categories/manager";
import { DisconnectedJev } from "../jev/disconnected";
import { ImapAdapter } from "../providers/imap/adapter";
import { GmailAdapter, GMAIL_LABELS } from "../providers/gmail/adapter";
import { GmailHttp } from "../providers/gmail/http";
import { OutlookAdapter, OUTLOOK_FOLDERS } from "../providers/outlook/adapter";
import { GraphHttp } from "../providers/outlook/http";
import { missingConfigMessage, OAuthProvider, oauthClient, PROVIDERS } from "../oauth/config";
import { OAuthService } from "../oauth/service";
import { TokenManager } from "../oauth/tokens";
import type { MailAdapter } from "../providers/types";
import { ImapFlowTransport } from "../providers/imap/imapflowTransport";
import { DEFAULT_BUCKET_FOLDERS } from "../providers/imap/folders";
import { ReadOnlyTransport } from "../providers/imap/readonly";
import { createSecretStore, SecretStore } from "../secrets";
import { SenderStore } from "../senders/store";
import { CategoryRepo } from "../storage/categoryRepo";
import { DB_FILE, ensureDataDir } from "../storage/dataDir";
import { openDb } from "../storage/db";
import { SyncService } from "../sync/sync";
import { createDemoState, DemoAppState } from "../ui/demo";
import type { AppState } from "../ui/state";
import { scrub } from "../providers/imap/sanitize";
import type Database from "better-sqlite3";

const REUSE_MS = 4 * 60 * 1000; // reconnect adapters that have been idle for a while

export interface RuntimeDeps {
  dataDir: string;
  secrets: SecretStore;
  makeTransport?: TransportFactory;
  db?: Database.Database;
  /** Injected in tests (mocked HTTP). Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Where OAuth client ids come from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface ApplyPlan { accountId: string; email: string; authToMove: number; willCreate: string[] }
export type ApplyResult = { ok: true; created: string[]; moved: number; failed: number } | { ok: false; error: string };

export class Runtime {
  readonly db: Database.Database;
  readonly accounts: AccountStore;
  readonly liveStore: SenderStore;
  readonly secrets: SecretStore;
  readonly service: AccountService;
  readonly sync: SyncService;
  private demo: DemoAppState | null = null;
  private live: AppState | null = null;
  private adapters = new Map<string, { adapter: MailAdapter; at: number }>();
  private tokens = new Map<string, TokenManager>();
  private fetchFn: typeof fetch;
  private env: Record<string, string | undefined>;
  readonly oauth: OAuthService;
  private categories: CategoryManager;
  private makeTransport: TransportFactory;
  readonly dataDir: string;

  constructor(d: RuntimeDeps) {
    this.dataDir = d.dataDir;
    this.fetchFn = d.fetchFn ?? ((...a) => fetch(...a));
    this.env = d.env ?? process.env;
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
      onChange: () => { this.dropAdapters(); this.tokens.clear(); },
    });
    this.oauth = new OAuthService({ accounts: this.accounts, secrets: this.secrets, fetchFn: this.fetchFn, env: this.env, onChange: () => { this.dropAdapters(); this.tokens.clear(); } });
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

  private dropAdapters(accountId?: string): void {
    for (const [k, { adapter }] of this.adapters) {
      if (accountId && !k.startsWith(`${accountId}:`)) continue;
      void adapter.disconnect().catch(() => undefined);
      this.adapters.delete(k);
    }
  }

  /**
   * A connected adapter for a saved account. Credentials come from the secret store only.
   * While the account is in PREVIEW mode the transport is wrapped read-only, so no write (folder
   * creation, move, copy, flag) can reach the server, whatever calls the adapter. Only
   * applyFiling asks for a writable adapter (`write: true`), and only before preview is turned off.
   */
  async adapterFor(accountId: string, opts: { write?: boolean } = {}): Promise<MailAdapter> {
    const acct = this.accounts.get(accountId);
    if (!acct) throw new Error("Unknown account.");
    const readOnly = acct.preview && !opts.write;
    const key = `${accountId}:${readOnly ? "ro" : "rw"}`;
    const hit = this.adapters.get(key);
    if (hit && Date.now() - hit.at < REUSE_MS) return hit.adapter;
    if (hit) { await hit.adapter.disconnect().catch(() => undefined); this.adapters.delete(key); }

    let adapter: MailAdapter;
    if (acct.provider === "gmail" || acct.provider === "outlook") {
      adapter = this.oauthAdapter(acct.provider, acct.id, readOnly);
    } else {
      const creds = await new SecretCredentialsProvider(this.secrets, acct.id, acct.email).get();
      const preset = { name: acct.provider === "icloud" ? "iCloud" : "IMAP", host: acct.host, port: acct.port, tls: acct.tls, authHint: "app_password" as const };
      const raw = this.makeTransport({ provider: acct.provider, email: acct.email, preset, credentials: creds });
      adapter = new ImapAdapter({ transport: readOnly ? new ReadOnlyTransport(raw) : raw, providerName: preset.name });
    }
    await adapter.connect();
    this.adapters.set(key, { adapter, at: Date.now() });
    return adapter;
  }

  /** Gmail / Outlook: tokens come from the secret store; while in Preview the HTTP guard is read-only. */
  private oauthAdapter(provider: OAuthProvider, accountId: string, readOnly: boolean): MailAdapter {
    const client = oauthClient(provider, this.env);
    if (!client) throw new Error(missingConfigMessage(provider));
    let tokens = this.tokens.get(accountId);
    if (!tokens) {
      tokens = new TokenManager({ cfg: PROVIDERS[provider], client, secrets: this.secrets, secretName: accountId, fetchFn: this.fetchFn });
      this.tokens.set(accountId, tokens);
    }
    if (provider === "gmail") {
      const ourLabelIds = new Set<string>();
      const http = new GmailHttp({ tokens, fetchFn: this.fetchFn, ctx: { readOnly, allowedLabelIds: () => ourLabelIds } });
      return new GmailAdapter({ http, ourLabelIds });
    }
    const ourFolderIds = new Set<string>();
    const forbiddenFolderIds = new Set<string>();
    const http = new GraphHttp({ tokens, fetchFn: this.fetchFn, ctx: { readOnly, ourFolderIds: () => ourFolderIds, forbiddenFolderIds: () => forbiddenFolderIds } });
    return new OutlookAdapter({ http, ourFolderIds, forbiddenFolderIds });
  }

  isPreview(accountId: string): boolean {
    return this.accounts.get(accountId)?.preview ?? false;
  }

  setPreview(accountId: string, on: boolean): void {
    this.accounts.setPreview(accountId, on);
    this.dropAdapters(accountId);
  }

  /** What "Apply filing" would do. Reads the app's own records only. */
  applyPlan(accountId: string): ApplyPlan | null {
    const acct = this.accounts.get(accountId);
    if (!acct) return null;
    const authToMove = this.liveStore.query({ bucket: "auth" }).filter((m) => m.accountId === accountId && m.folder === "INBOX").length;
    const names = acct.provider === "gmail" ? GMAIL_LABELS : acct.provider === "outlook" ? OUTLOOK_FOLDERS : DEFAULT_BUCKET_FOLDERS;
    return { accountId, email: acct.email, authToMove, willCreate: (["auth", "needs_review", "junk"] as const).map((b) => names[b]) };
  }

  /**
   * Turn preview OFF. This is the only place the Jev folders are created. Order: create folders
   * (if the Auth folder cannot be made, stop and stay in preview), turn preview off, then move the
   * Auth mail already recorded. Never junks or deletes anything.
   */
  private applying = new Set<string>();

  async applyFiling(accountId: string): Promise<ApplyResult> {
    if (this.applying.has(accountId)) return { ok: false, error: "Applying is already in progress for this account." };
    this.applying.add(accountId);
    try {
      return await this.applyFilingInner(accountId);
    } finally {
      this.applying.delete(accountId);
    }
  }

  private async applyFilingInner(accountId: string): Promise<ApplyResult> {
    const acct = this.accounts.get(accountId);
    if (!acct) return { ok: false, error: "Unknown account." };
    if (!acct.preview) return { ok: false, error: "Preview mode is already off for this account." };
    const created: string[] = [];
    try {
      const writer = await this.adapterFor(accountId, { write: true });
      for (const b of ["auth", "needs_review", "junk"] as const) {
        const info = await writer.ensureBucket(b);
        if (info.created) created.push(info.name);
        if (b === "auth" && (info.inPlace || !info.path)) {
          return { ok: false, error: "Could not create the Jev Auth folder on your mailbox, so Preview mode stays on and nothing was moved." };
        }
      }
    } catch (e) {
      return { ok: false, error: `Could not prepare your mailbox: ${scrub(e instanceof Error ? e.message : "connection failed", []).slice(0, 200)} Preview mode stays on.` };
    }
    this.setPreview(accountId, false);
    let moved = 0;
    let failed = 0;
    const adapter = await this.adapterFor(accountId); // now writable
    for (const m of this.liveStore.query({ bucket: "auth" }).filter((x) => x.accountId === accountId && x.folder === "INBOX")) {
      const r = await adapter.moveToBucket(m.folder, m.messageId, "auth");
      if (r.success && r.moved) {
        this.liveStore.updateLocation(accountId, m.folder, m.messageId, { bucket: "auth", newMessageId: r.newMessageId, folder: r.destination });
        moved++;
      } else failed++;
    }
    return { ok: true, created, moved, failed };
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
      isPreview: (id) => this.isPreview(id),
      accountIds: () => this.accounts.list().map((a) => a.id),
    });
  }
}

// Versioned: a dev-server hot reload must not keep serving a runtime object built by older code.
const KEY = "__jevRuntime_v2";
export function getRuntime(): Promise<Runtime> {
  const g = globalThis as unknown as Record<string, Promise<Runtime> | undefined>;
  return (g[KEY] ??= Promise.resolve().then(buildDefaultRuntime));
}

function buildDefaultRuntime(): Runtime {
  const dataDir = ensureDataDir({ env: process.env, platform: process.platform, home: homedir(), cwd: process.cwd() });
  const secrets = createSecretStore({ platform: process.platform, env: process.env, dataDir });
  return new Runtime({ dataDir, secrets });
}
