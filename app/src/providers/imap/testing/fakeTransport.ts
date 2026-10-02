// In-memory IMAP "server" for tests. Records every operation. It has no delete/expunge, mirroring
// the ImapTransport interface.
import { FORBIDDEN_KEYWORDS, FolderInfo, FolderState, ImapTransport, RawMessage, TransportCapabilities } from "../transport";

interface FakeMsg extends RawMessage { keywords: Set<string> }
interface FakeFolder {
  specialUse?: string;
  uidValidity: number;
  nextUid: number;
  msgs: Map<number, FakeMsg>;
}

export interface FakeOptions {
  move?: boolean;
  idle?: boolean;
  xoauth2?: boolean;
  /** Folder creation fails for these paths (permissions, limits, name clash). */
  failCreate?: (path: string) => boolean;
  failIdle?: boolean;
  /** Extra folders to pre-create. */
  folders?: Array<{ path: string; specialUse?: string }>;
}

export interface Op { op: string; path?: string; uid?: number; dest?: string; keyword?: string }

export class FakeImapTransport implements ImapTransport {
  ops: Op[] = [];
  connected = false;
  private folders = new Map<string, FakeFolder>();
  private idleHandlers = new Map<string, Array<() => void>>();

  constructor(private opts: FakeOptions = {}) {
    this.addFolder("INBOX");
    this.addFolder("Sent", "\\Sent");
    this.addFolder("Junk", "\\Junk");
    this.addFolder("Trash", "\\Trash");
    this.addFolder("Archive", "\\Archive");
    for (const f of opts.folders ?? []) this.addFolder(f.path, f.specialUse);
  }

  private addFolder(path: string, specialUse?: string) {
    this.folders.set(path, { specialUse, uidValidity: 1000, nextUid: 1, msgs: new Map() });
  }
  private f(path: string): FakeFolder {
    const f = this.folders.get(path);
    if (!f) throw new Error(`no such folder ${path}`);
    return f;
  }

  // ---- test helpers
  deliver(path: string, m: { from: string; subject: string; body: string; replyTo?: string; unread?: boolean }): number {
    const f = this.f(path);
    const uid = f.nextUid++;
    f.msgs.set(uid, {
      uid, from: m.from, subject: m.subject, replyTo: m.replyTo, date: new Date(1_700_000_000_000 + uid * 1000),
      unread: m.unread ?? true, bodyText: m.body, keywords: new Set(),
    });
    for (const h of this.idleHandlers.get(path) ?? []) h();
    return uid;
  }
  bumpUidValidity(path: string) { this.f(path).uidValidity += 1; }
  folderPaths(): string[] { return [...this.folders.keys()]; }
  messages(path: string): FakeMsg[] { return [...this.f(path).msgs.values()]; }
  all(): Array<{ path: string; subject: string; keywords: string[] }> {
    const out: Array<{ path: string; subject: string; keywords: string[] }> = [];
    for (const [path, f] of this.folders) for (const m of f.msgs.values()) out.push({ path, subject: m.subject, keywords: [...m.keywords] });
    return out;
  }
  totalMessages(): number { return this.all().length; }
  idleHandlerCount(): number { return [...this.idleHandlers.values()].reduce((n, a) => n + a.length, 0); }

  // ---- ImapTransport
  async connect() { this.connected = true; this.ops.push({ op: "connect" }); }
  async close() { this.connected = false; this.ops.push({ op: "close" }); }
  async capabilities(): Promise<TransportCapabilities> {
    return { move: this.opts.move ?? true, idle: this.opts.idle ?? true, xoauth2: this.opts.xoauth2 ?? false };
  }
  async listFolders(): Promise<FolderInfo[]> {
    return [...this.folders.entries()].map(([path, f]) => ({ path, delimiter: "/", specialUse: f.specialUse }));
  }
  async createFolder(path: string): Promise<boolean> {
    this.ops.push({ op: "create", path });
    if (this.folders.has(path)) return false;
    if (this.opts.failCreate?.(path)) throw new Error("NO [CANNOT] mailbox creation not permitted");
    this.addFolder(path);
    return true;
  }
  async folderState(path: string): Promise<FolderState> {
    const f = this.f(path);
    return { uidValidity: f.uidValidity, uidNext: f.nextUid };
  }
  async fetchSince(path: string, afterUid: number): Promise<RawMessage[]> {
    this.ops.push({ op: "fetchSince", path, uid: afterUid });
    return this.messages(path).filter((m) => m.uid > afterUid).map(({ keywords, ...m }) => m);
  }
  async fetchLatest(path: string, limit: number): Promise<RawMessage[]> {
    this.ops.push({ op: "fetchLatest", path, uid: limit });
    return this.messages(path).sort((a, b) => a.uid - b.uid).slice(-limit).map(({ keywords, ...m }) => m);
  }
  async fetchOne(path: string, uid: number): Promise<RawMessage | null> {
    this.ops.push({ op: "fetchOne", path, uid });
    const m = this.f(path).msgs.get(uid);
    if (!m) return null;
    const { keywords, ...raw } = m;
    return raw;
  }
  private put(dest: string, m: FakeMsg): number {
    const d = this.f(dest);
    const uid = d.nextUid++;
    d.msgs.set(uid, { ...m, uid, keywords: new Set(m.keywords) });
    return uid;
  }
  async move(path: string, uid: number, dest: string) {
    this.ops.push({ op: "move", path, uid, dest });
    if (!(this.opts.move ?? true)) throw new Error("MOVE not supported");
    const m = this.f(path).msgs.get(uid);
    if (!m) throw new Error("no such message");
    const destUid = this.put(dest, m);
    this.f(path).msgs.delete(uid); // server-side MOVE: same message, new location (not a delete)
    return { destUid };
  }
  async copy(path: string, uid: number, dest: string) {
    this.ops.push({ op: "copy", path, uid, dest });
    const m = this.f(path).msgs.get(uid);
    if (!m) throw new Error("no such message");
    return { destUid: this.put(dest, m) };
  }
  async setKeyword(path: string, uid: number, keyword: string, on: boolean) {
    if (FORBIDDEN_KEYWORDS.test(keyword.trim())) throw new Error("refusing to touch the \\Deleted flag");
    this.ops.push({ op: on ? "keyword+" : "keyword-", path, uid, keyword });
    const m = this.f(path).msgs.get(uid);
    if (!m) throw new Error("no such message");
    if (on) m.keywords.add(keyword); else m.keywords.delete(keyword);
  }
  async idle(path: string, onChange: () => void) {
    this.ops.push({ op: "idle", path });
    if (this.opts.failIdle) throw new Error("IDLE failed");
    const arr = this.idleHandlers.get(path) ?? [];
    arr.push(onChange);
    this.idleHandlers.set(path, arr);
    return {
      stop: async () => {
        this.idleHandlers.set(path, (this.idleHandlers.get(path) ?? []).filter((h) => h !== onChange));
      },
    };
  }
}
