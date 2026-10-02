// ImapTransport backed by the imapflow library. Logging is disabled (imapflow would otherwise
// log protocol traffic, which can include credentials). Errors are scrubbed before they leave.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { CredentialsProvider, ImapCredentials } from "./credentials";
import { ImapPreset } from "./presets";
import { safeError } from "./sanitize";
import {
  FORBIDDEN_KEYWORDS, FolderInfo, FolderState, ImapTransport, RawMessage, TransportCapabilities,
} from "./transport";

const SOURCE_MAX = 16_384;

export type ImapFlowFactory = (opts: ConstructorParameters<typeof ImapFlow>[0]) => ImapFlow;

export interface ImapFlowTransportOptions {
  accountId: string;
  preset: ImapPreset;
  credentials: CredentialsProvider;
  /** Injected in tests. */
  createClient?: ImapFlowFactory;
}

export class ImapFlowTransport implements ImapTransport {
  private client: ImapFlow | null = null;
  private creds: ImapCredentials | null = null;
  private readonly make: ImapFlowFactory;

  constructor(private readonly o: ImapFlowTransportOptions) {
    this.make = o.createClient ?? ((opts) => new ImapFlow(opts));
  }

  private secrets() {
    return [this.creds?.password, this.creds?.accessToken];
  }

  private build(auth: { user: string; pass?: string; accessToken?: string }): ImapFlow {
    const { preset } = this.o;
    return this.make({
      host: preset.host,
      port: preset.port,
      secure: preset.tls === "implicit",
      doSTARTTLS: preset.tls === "starttls" ? true : undefined,
      auth,
      logger: false, // never log protocol traffic
    });
  }

  async connect(): Promise<void> {
    this.creds = await this.o.credentials.get(this.o.accountId);
    const { user, password, accessToken } = this.creds;
    // XOAUTH2 first when a token exists (imapflow uses XOAUTH2 for accessToken); fall back to password.
    const attempts: Array<{ user: string; pass?: string; accessToken?: string }> = [];
    if (accessToken) attempts.push({ user, accessToken });
    if (password) attempts.push({ user, pass: password });
    if (!attempts.length) throw safeError(new Error("no usable credentials"), this.secrets());
    let lastErr: unknown;
    for (const auth of attempts) {
      const c = this.build(auth);
      try {
        await c.connect();
        this.client = c;
        return;
      } catch (e) {
        lastErr = e;
        try { await c.close(); } catch { /* ignore */ }
      }
    }
    throw safeError(lastErr, this.secrets());
  }

  private c(): ImapFlow {
    if (!this.client) throw safeError(new Error("not connected"), this.secrets());
    return this.client;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw safeError(e, this.secrets());
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.creds = null;
    if (c) {
      try { await c.logout(); } catch { /* ignore */ }
    }
  }

  async capabilities(): Promise<TransportCapabilities> {
    const caps = this.c().capabilities;
    return { move: caps.has("MOVE"), idle: caps.has("IDLE"), xoauth2: caps.has("AUTH=XOAUTH2") };
  }

  listFolders(): Promise<FolderInfo[]> {
    return this.guard(async () => {
      const list = await this.c().list();
      return list.map((f) => ({ path: f.path, delimiter: f.delimiter, specialUse: f.specialUse }));
    });
  }

  createFolder(path: string): Promise<boolean> {
    return this.guard(async () => (await this.c().mailboxCreate(path)).created);
  }

  folderState(path: string): Promise<FolderState> {
    return this.guard(async () => {
      const s = await this.c().status(path, { uidNext: true, uidValidity: true });
      if (!s || s.uidValidity === undefined || s.uidNext === undefined) throw new Error("folder status unavailable");
      return { uidValidity: Number(s.uidValidity), uidNext: Number(s.uidNext) };
    });
  }

  private async toRaw(m: { uid: number; flags?: Set<string>; envelope?: any; source?: Buffer | false }): Promise<RawMessage> {
    const parsed = m.source ? await simpleParser(m.source) : null;
    const env = m.envelope ?? {};
    const f = env.from?.[0];
    const from = f?.address ? (f.name ? `${f.name} <${f.address}>` : f.address) : "";
    const hdr = (n: string) => {
      const v = parsed?.headers.get(n);
      return typeof v === "string" ? v : undefined;
    };
    const replyTo = parsed?.replyTo?.value?.[0]?.address;
    return {
      uid: m.uid,
      from,
      replyTo,
      subject: env.subject ?? "",
      date: env.date ? new Date(env.date) : new Date(0),
      unread: !m.flags?.has("\\Seen"),
      listUnsubscribe: hdr("list-unsubscribe"),
      authenticationResults: hdr("authentication-results"),
      bodyText: (parsed?.text ?? "").trim(),
    };
  }

  fetchSince(path: string, afterUid: number): Promise<RawMessage[]> {
    return this.guard(async () => {
      const client = this.c();
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const out: RawMessage[] = [];
        // "n:*" always returns at least the last message, so filter by uid afterwards.
        for await (const m of client.fetch(`${afterUid + 1}:*`, { uid: true, flags: true, envelope: true, source: { maxLength: SOURCE_MAX } }, { uid: true })) {
          if (m.uid > afterUid) out.push(await this.toRaw(m as any));
        }
        return out.sort((a, b) => a.uid - b.uid);
      } finally {
        lock.release();
      }
    });
  }

  fetchLatest(path: string, limit: number): Promise<RawMessage[]> {
    return this.guard(async () => {
      const client = this.c();
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const exists = client.mailbox && typeof client.mailbox === "object" ? Number((client.mailbox as { exists: number }).exists) : 0;
        if (!exists) return [];
        const first = Math.max(1, exists - limit + 1);
        const out: RawMessage[] = [];
        // sequence-number range (no {uid:true}), newest `limit` messages
        for await (const m of client.fetch(`${first}:*`, { uid: true, flags: true, envelope: true, source: { maxLength: SOURCE_MAX } })) {
          out.push(await this.toRaw(m as any));
        }
        return out.sort((a, b) => a.uid - b.uid).slice(-limit);
      } finally {
        lock.release();
      }
    });
  }

  fetchOne(path: string, uid: number): Promise<RawMessage | null> {
    return this.guard(async () => {
      const client = this.c();
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const m = await client.fetchOne(String(uid), { uid: true, flags: true, envelope: true, source: { maxLength: SOURCE_MAX } }, { uid: true });
        return m ? await this.toRaw(m as any) : null;
      } finally {
        lock.release();
      }
    });
  }

  move(path: string, uid: number, destination: string): Promise<{ destUid?: number }> {
    return this.guard(async () => {
      const client = this.c();
      const lock = await client.getMailboxLock(path);
      try {
        const r = await client.messageMove(String(uid), destination, { uid: true });
        if (!r) throw new Error("move failed");
        return { destUid: r.uidMap?.get(uid) };
      } finally {
        lock.release();
      }
    });
  }

  copy(path: string, uid: number, destination: string): Promise<{ destUid?: number }> {
    return this.guard(async () => {
      const client = this.c();
      const lock = await client.getMailboxLock(path);
      try {
        const r = await client.messageCopy(String(uid), destination, { uid: true });
        if (!r) throw new Error("copy failed");
        return { destUid: r.uidMap?.get(uid) };
      } finally {
        lock.release();
      }
    });
  }

  setKeyword(path: string, uid: number, keyword: string, on: boolean): Promise<void> {
    if (FORBIDDEN_KEYWORDS.test(keyword.trim())) {
      return Promise.reject(safeError(new Error("refusing to touch the \\Deleted flag"), this.secrets()));
    }
    return this.guard(async () => {
      const client = this.c();
      const lock = await client.getMailboxLock(path);
      try {
        if (on) await client.messageFlagsAdd(String(uid), [keyword], { uid: true });
        else await client.messageFlagsRemove(String(uid), [keyword], { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  idle(path: string, onChange: () => void): Promise<{ stop(): Promise<void> }> {
    return this.guard(async () => {
      const client = this.c();
      const lock = await client.getMailboxLock(path, { readOnly: true });
      const handler = () => onChange();
      client.on("exists", handler); // imapflow enters IDLE automatically while the mailbox is open
      return {
        stop: async () => {
          client.off("exists", handler);
          lock.release();
        },
      };
    });
  }
}
