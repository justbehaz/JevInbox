// Add / confirm / remove accounts.
//  - testConnection: connects READ-ONLY (ReadOnlyTransport), lists folders and capabilities.
//    Nothing on the mailbox changes and nothing is saved. The password waits in server memory.
//  - confirm: only after the user confirms. Stores the password in the SecretStore (Keychain /
//    encrypted file) and the account metadata in SQLite, with PREVIEW MODE ON. It creates nothing on
//    the server: the Jev folders are created only when the user applies filing (Runtime.applyFiling).
//  - remove: deletes our stored credentials and local metadata. It NEVER connects to the server.
import { randomBytes } from "node:crypto";
import { CredentialsProvider, ImapCredentials } from "../providers/imap/credentials";
import { DEFAULT_BUCKET_FOLDERS } from "../providers/imap/folders";
import { ICLOUD_PRESET, ImapPreset, TlsMode, genericPreset } from "../providers/imap/presets";
import { ReadOnlyTransport } from "../providers/imap/readonly";
import { scrub } from "../providers/imap/sanitize";
import { FolderInfo, ImapTransport, TransportCapabilities } from "../providers/imap/transport";
import { SecretStore } from "../secrets/store";
import { SenderStore } from "../senders/store";
import { AccountProvider, AccountRow, AccountStore, accountIdFor } from "./accountStore";

export interface NewAccountInput {
  provider: AccountProvider;
  email: string;
  password: string;
  host?: string;
  port?: number | string;
  tls?: string;
}

export interface TransportSpec { provider: AccountProvider; email: string; preset: ImapPreset; credentials: ImapCredentials }
export type TransportFactory = (spec: TransportSpec) => ImapTransport;

export interface ConnectionReport {
  provider: AccountProvider;
  email: string;
  host: string;
  port: number;
  tls: TlsMode;
  capabilities: TransportCapabilities;
  folders: FolderInfo[];
  /** Folders that will be created later, when the user applies filing (never at confirm time). */
  willCreate: string[];
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

interface Pending { input: NewAccountInput; preset: ImapPreset; report: ConnectionReport; expires: number }

/** Reads a saved secret back as imapflow credentials. */
export class SecretCredentialsProvider implements CredentialsProvider {
  constructor(private readonly secrets: SecretStore, private readonly name: string, private readonly email: string) {}
  async get(): Promise<ImapCredentials> {
    const raw = await this.secrets.get(this.name);
    if (!raw) throw new Error("no saved credentials for this account");
    const parsed = JSON.parse(raw) as { password?: string; accessToken?: string };
    return { user: this.email, password: parsed.password, accessToken: parsed.accessToken };
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 5;

export interface AccountServiceDeps {
  accounts: AccountStore;
  secrets: SecretStore;
  store: SenderStore;
  makeTransport: TransportFactory;
  /** Called after an account is saved or removed (the runtime switches demo/live). */
  onChange?: () => void;
  now?: () => number;
}

export class AccountService {
  private pending = new Map<string, Pending>();
  private now: () => number;
  constructor(private readonly d: AccountServiceDeps) {
    this.now = d.now ?? Date.now;
  }

  private presetFor(i: NewAccountInput): ImapPreset {
    if (i.provider === "icloud") return ICLOUD_PRESET;
    return genericPreset({ host: String(i.host ?? ""), port: Number(i.port), tls: String(i.tls ?? "") as TlsMode });
  }

  /** Read-only connection test. The returned report never contains the password. */
  async testConnection(input: NewAccountInput): Promise<Result<{ token: string; report: ConnectionReport }>> {
    const email = (input.email ?? "").trim().toLowerCase();
    const password = input.password ?? "";
    if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter the full email address." };
    if (!password) return { ok: false, error: "Enter the password." };
    if (input.provider !== "icloud" && input.provider !== "imap") return { ok: false, error: "Unsupported account type." };
    let preset: ImapPreset;
    try { preset = this.presetFor(input); } catch (e) { return { ok: false, error: (e as Error).message }; }
    if (this.d.accounts.get(accountIdFor(input.provider, email))) return { ok: false, error: "That account is already added." };

    const transport = new ReadOnlyTransport(this.d.makeTransport({ provider: input.provider, email, preset, credentials: { user: email, password } }));
    try {
      await transport.connect();
      const capabilities = await transport.capabilities();
      const folders = await transport.listFolders();
      const have = new Set(folders.map((f) => f.path.toLowerCase()));
      const willCreate = (["auth", "junk", "needs_review"] as const).map((b) => DEFAULT_BUCKET_FOLDERS[b]).filter((n) => !have.has(n.toLowerCase()));
      const report: ConnectionReport = { provider: input.provider, email, host: preset.host, port: preset.port, tls: preset.tls, capabilities, folders, willCreate };
      this.gc();
      const token = randomBytes(16).toString("hex");
      // The password stays in server memory only, for at most 10 minutes, and is used once.
      this.pending.set(token, { input: { ...input, email, password }, preset, report, expires: this.now() + TTL_MS });
      return { ok: true, token, report };
    } catch (e) {
      return { ok: false, error: this.safe(e, [password]) };
    } finally {
      try { await transport.close(); } catch { /* ignore */ }
    }
  }

  pendingReport(token: string): ConnectionReport | null {
    this.gc();
    return this.pending.get(token)?.report ?? null;
  }

  discard(token: string): void {
    this.pending.delete(token);
  }

  /** The user confirmed: save the secret and the account (preview mode on). No server writes. */
  async confirm(token: string): Promise<Result<{ account: AccountRow }>> {
    this.gc();
    const p = this.pending.get(token);
    if (!p) return { ok: false, error: "That connection test expired. Test the connection again." };
    this.pending.delete(token); // single use
    const { input, preset } = p;
    const password = input.password;
    const id = accountIdFor(input.provider, input.email);
    if (this.d.accounts.get(id)) return { ok: false, error: "That account is already added." };

    try {
      await this.d.secrets.set(id, JSON.stringify({ password }));
    } catch (e) {
      return { ok: false, error: `Could not store the password securely: ${this.safe(e, [password])}` };
    }
    try {
      const account = this.d.accounts.add({ id, provider: input.provider, email: input.email, host: preset.host, port: preset.port, tls: preset.tls });
      this.d.onChange?.();
      return { ok: true, account };
    } catch (e) {
      await this.d.secrets.delete(id).catch(() => undefined); // do not leave an orphaned secret
      return { ok: false, error: this.safe(e, [password]) };
    }
  }

  /**
   * Remove an account: delete our stored credentials and local metadata. This never connects to the
   * mail server and never touches mail on it.
   */
  async remove(accountId: string): Promise<Result<{ messages: number; senders: number }>> {
    const acct = this.d.accounts.get(accountId);
    if (!acct) return { ok: false, error: "Unknown account." };
    await this.d.secrets.delete(accountId);
    const counts = this.d.store.deleteAccountData(accountId);
    this.d.accounts.remove(accountId);
    this.d.onChange?.();
    return { ok: true, ...counts };
  }

  private safe(e: unknown, secrets: string[]): string {
    const msg = e instanceof Error ? e.message : "connection failed";
    return scrub(msg, secrets).slice(0, 300);
  }

  private gc(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
  }
}
