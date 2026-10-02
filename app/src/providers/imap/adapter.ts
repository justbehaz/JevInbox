// IMAP implementation of MailAdapter. No delete, no expunge, no writes to provider spam.
import {
  AdapterCapabilities, BucketInfo, BucketName, ListResult, MailAdapter, MailEvent,
  MessageDetail, MessageSummary, MoveResult, Watcher,
} from "../types";
import { canMoveToJunk } from "../../gate/gate";
import { buildSnippet } from "../../gate/redact";
import { DEFAULT_BUCKET_FOLDERS, assertNotProviderSpam, isProviderSpamFolder, validateBucketNames } from "./folders";
import { ImapAdapterError } from "./sanitize";
import { ImapTransport, RawMessage } from "./transport";

export const MOVED_KEYWORD = "$JevMoved";
const BODY_SAMPLE_MAX = 4000;

export interface Scheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
const realScheduler: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface ImapAdapterOptions {
  transport: ImapTransport;
  /** Shown in events only. */
  providerName?: string;
  bucketFolders?: Partial<Record<BucketName, string>>;
  pollIntervalMs?: number; // default 45000
  scheduler?: Scheduler;
  /** Reading the provider's spam folder is off by default (06-mail-sources.md). */
  allowReadProviderSpam?: boolean;
  onError?: (e: ImapAdapterError) => void;
}

const idOf = (validity: number, uid: number) => `${validity}:${uid}`;
function parseId(id: string): { validity: number; uid: number } {
  const m = /^(\d+):(\d+)$/.exec(id);
  if (!m) throw new ImapAdapterError("bad message id");
  return { validity: Number(m[1]), uid: Number(m[2]) };
}
function parseCursor(c?: string): { validity: number; lastUid: number } | null {
  if (!c) return null;
  const m = /^(\d+):(\d+)$/.exec(c);
  return m ? { validity: Number(m[1]), lastUid: Number(m[2]) } : null;
}

export class ImapAdapter implements MailAdapter {
  private readonly t: ImapTransport;
  private readonly names: Record<BucketName, string>;
  private readonly buckets = new Map<BucketName, BucketInfo>();
  private readonly sched: Scheduler;
  private readonly pollMs: number;

  constructor(private readonly opts: ImapAdapterOptions) {
    this.t = opts.transport;
    this.names = { ...DEFAULT_BUCKET_FOLDERS, ...(opts.bucketFolders ?? {}) } as Record<BucketName, string>;
    validateBucketNames(this.names);
    this.sched = opts.scheduler ?? realScheduler;
    this.pollMs = opts.pollIntervalMs ?? 45_000;
  }

  async connect(): Promise<void> {
    await this.t.connect();
  }

  async disconnect(): Promise<void> {
    this.buckets.clear();
    await this.t.close();
  }

  async capabilities(): Promise<AdapterCapabilities> {
    const c = await this.t.capabilities();
    return {
      pushNotifications: c.idle,
      labelSupport: false,
      idleSupport: c.idle,
      moveSupport: c.move,
      customFolders: true,
      authMethods: c.xoauth2 ? ["app_password", "xoauth2"] : ["app_password"],
    };
  }

  private async guardReadable(folder: string): Promise<void> {
    if (this.opts.allowReadProviderSpam) return;
    const folders = await this.t.listFolders();
    if (isProviderSpamFolder(folder, folders)) {
      throw new ImapAdapterError("reading the provider spam folder is disabled");
    }
  }

  private summary(folder: string, validity: number, m: RawMessage): MessageSummary {
    return { id: idOf(validity, m.uid), folder, from: m.from, subject: m.subject, date: m.date, unread: m.unread };
  }

  async listMessages(folder: string, o: { cursor?: string } = {}): Promise<ListResult> {
    await this.guardReadable(folder);
    const state = await this.t.folderState(folder);
    const cur = parseCursor(o.cursor);
    const resync = !!cur && cur.validity !== state.uidValidity;
    const after = cur && !resync ? cur.lastUid : 0;
    const raw = await this.t.fetchSince(folder, after);
    const fresh = raw.filter((m) => m.uid > after).sort((a, b) => a.uid - b.uid);
    const last = fresh.length ? fresh[fresh.length - 1].uid : after;
    return {
      messages: fresh.map((m) => this.summary(folder, state.uidValidity, m)),
      cursor: `${state.uidValidity}:${last}`,
      resync,
    };
  }

  async fetchHeadersAndSnippet(folder: string, messageId: string): Promise<MessageDetail> {
    await this.guardReadable(folder);
    const { validity, uid } = parseId(messageId);
    const state = await this.t.folderState(folder);
    if (state.uidValidity !== validity) throw new ImapAdapterError("stale message id (UIDVALIDITY changed)");
    const m = await this.t.fetchOne(folder, uid);
    if (!m) throw new ImapAdapterError("message not found");
    return {
      ...this.summary(folder, validity, m),
      replyTo: m.replyTo,
      listUnsubscribe: m.listUnsubscribe,
      authenticationResults: m.authenticationResults,
      snippet: buildSnippet(m.bodyText),
      bodySample: m.bodyText.slice(0, BODY_SAMPLE_MAX),
    };
  }

  async ensureBucket(bucket: BucketName): Promise<BucketInfo> {
    const cached = this.buckets.get(bucket);
    if (cached) return cached;
    const name = this.names[bucket];
    let info: BucketInfo;
    try {
      const folders = await this.t.listFolders();
      assertNotProviderSpam(name, folders);
      const exists = folders.some((f) => f.path.toLowerCase() === name.toLowerCase());
      const created = exists ? false : await this.t.createFolder(name);
      info = { name, path: folders.find((f) => f.path.toLowerCase() === name.toLowerCase())?.path ?? name, created };
    } catch {
      // Fallback per 06-mail-sources.md: Junk -> Needs review -> leave in place.
      if (bucket === "junk") {
        const nr = await this.ensureBucket("needs_review");
        info = { ...nr, name, fallback: "needs_review" };
      } else {
        info = { name, path: null, created: false, inPlace: true };
      }
    }
    this.buckets.set(bucket, info);
    return info;
  }

  async moveToBucket(folder: string, messageId: string, bucket: BucketName): Promise<MoveResult> {
    const base = { messageId, originalLocation: folder };
    try {
      const folders = await this.t.listFolders();
      if (isProviderSpamFolder(folder, folders)) {
        throw new ImapAdapterError("moves out of the provider spam folder are not done automatically");
      }
      const { validity, uid } = parseId(messageId);
      const state = await this.t.folderState(folder);
      if (state.uidValidity !== validity) throw new ImapAdapterError("stale message id (UIDVALIDITY changed)");

      // Adapter-level defence: whoever calls this, Auth or security-shaped mail never goes to Junk.
      if (bucket === "junk") {
        const raw = await this.t.fetchOne(folder, uid);
        if (!raw) throw new ImapAdapterError("message not found");
        const check = canMoveToJunk({ id: messageId, from: raw.from, subject: raw.subject, body: raw.bodyText }, "junk");
        if (!check.ok) bucket = "needs_review";
      }

      const info = await this.ensureBucket(bucket);
      if (info.inPlace || !info.path) {
        return { ...base, success: true, moved: false, destination: null, bucketUsed: null, method: "none" };
      }
      // Final write guard: never write to provider spam, whatever the config says.
      assertNotProviderSpam(info.path, folders.concat(info.created ? [{ path: info.path, delimiter: "/" }] : []));
      const bucketUsed: BucketName = info.fallback ?? bucket;
      if (info.path === folder) {
        return { ...base, success: true, moved: false, destination: info.path, bucketUsed, method: "none" };
      }

      const caps = await this.t.capabilities();
      if (caps.move) {
        const r = await this.t.move(folder, uid, info.path);
        return {
          ...base, success: true, moved: true, destination: info.path, bucketUsed, method: "move",
          newMessageId: r.destUid ? this.destId(info.path, r.destUid) : undefined,
        };
      }
      // No MOVE: COPY, then flag the original with a harmless keyword. Never \Deleted, never EXPUNGE.
      const r = await this.t.copy(folder, uid, info.path);
      await this.t.setKeyword(folder, uid, MOVED_KEYWORD, true);
      return {
        ...base, success: true, moved: true, destination: info.path, bucketUsed, method: "copy_flag",
        newMessageId: r.destUid ? this.destId(info.path, r.destUid) : undefined,
      };
    } catch (e) {
      return {
        ...base, success: false, moved: false, destination: null, bucketUsed: null, method: "none",
        error: e instanceof Error ? e.message : "move failed",
      };
    }
  }

  // Destination ids need the destination's UIDVALIDITY; looked up lazily and only for undo.
  private destId(path: string, uid: number): string {
    return `${path}\u0000${uid}`;
  }

  async undoMove(result: MoveResult): Promise<void> {
    if (!result.moved || !result.destination) return;
    const { uid: origUid } = parseId(result.messageId);
    if (result.method === "copy_flag") {
      await this.t.setKeyword(result.originalLocation, origUid, MOVED_KEYWORD, false);
      return; // original was never removed; the copy in the bucket is left (nothing is deleted)
    }
    if (result.method === "move" && result.newMessageId) {
      const [path, uidStr] = result.newMessageId.split("\u0000");
      const caps = await this.t.capabilities();
      if (!caps.move) throw new ImapAdapterError("cannot reverse: MOVE not available");
      await this.t.move(path, Number(uidStr), result.originalLocation);
      return;
    }
    throw new ImapAdapterError("cannot reverse: server did not report the new UID (UIDPLUS missing)");
  }

  async watch(folder: string, callback: (e: MailEvent) => void): Promise<Watcher> {
    await this.guardReadable(folder);
    const caps = await this.t.capabilities();
    const state = await this.t.folderState(folder);
    let cursor = `${state.uidValidity}:${state.uidNext - 1}`;
    let active = false;
    let mode: "idle" | "poll" | "stopped" = "stopped";
    let timer: unknown;
    let idleStop: { stop(): Promise<void> } | undefined;
    let busy = false;

    const syncNew = async () => {
      if (busy || !active) return;
      busy = true;
      try {
        const res = await this.listMessages(folder, { cursor });
        cursor = res.cursor;
        for (const m of res.messages) {
          callback({ type: "message_added", provider: this.opts.providerName ?? "imap", folder, messageId: m.id, timestamp: new Date() });
        }
      } catch (e) {
        this.opts.onError?.(e instanceof ImapAdapterError ? e : new ImapAdapterError("sync failed"));
      } finally {
        busy = false;
      }
    };

    const startPolling = () => {
      mode = "poll";
      timer = this.sched.setInterval(() => void syncNew(), this.pollMs);
    };

    return {
      start: async () => {
        if (active) return;
        active = true;
        if (caps.idle) {
          try {
            idleStop = await this.t.idle(folder, () => void syncNew());
            mode = "idle";
          } catch {
            startPolling(); // IDLE failed: fall back to polling
          }
        } else {
          startPolling();
        }
      },
      stop: async () => {
        active = false;
        mode = "stopped";
        if (timer !== undefined) this.sched.clearInterval(timer);
        timer = undefined;
        if (idleStop) await idleStop.stop();
        idleStop = undefined;
      },
      isActive: () => active,
      mode: () => mode,
    };
  }
}
