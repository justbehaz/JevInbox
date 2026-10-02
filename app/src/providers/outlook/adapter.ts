// Outlook / Microsoft 365 implementation of MailAdapter over Microsoft Graph. Folders live under
// the mailbox root; a move is POST /me/messages/{id}/move (the message gets a new id). The Junk Email
// and Deleted Items folders are never read, written or used as a destination, and DELETE is never used.
import { canMoveToJunk } from "../../gate/gate";
import { buildSnippet } from "../../gate/redact";
import {
  AdapterCapabilities, BucketInfo, BucketName, ListResult, MailAdapter, MailEvent, MessageDetail, MessageSummary, MoveResult, Watcher,
} from "../types";
import { Scheduler } from "../imap/adapter";
import { OUR_FOLDER_NAMES } from "./guard";
import { GraphApiError, GraphTransportLike } from "./http";

const BODY_SAMPLE_MAX = 4000;
const SELECT = "id,subject,from,receivedDateTime,isRead,parentFolderId";
export const OUTLOOK_FOLDERS: Record<Exclude<BucketName, "archive">, string> = { auth: "Jev Auth", needs_review: "Jev Needs review", junk: "Jev Junk" };

interface GMsg {
  id: string; subject?: string; receivedDateTime?: string; isRead?: boolean; parentFolderId?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  replyTo?: Array<{ emailAddress?: { address?: string } }>;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  body?: { content?: string; contentType?: string };
  "@removed"?: unknown;
}

const fromOf = (m: GMsg) => {
  const e = m.from?.emailAddress;
  return e?.address ? (e.name ? `${e.name} <${e.address}>` : e.address) : "";
};

export interface OutlookAdapterOptions {
  http: GraphTransportLike;
  /** Shared with the guard. */
  ourFolderIds: Set<string>;
  forbiddenFolderIds: Set<string>;
  scheduler?: Scheduler;
  pollIntervalMs?: number;
}

export class OutlookAdapter implements MailAdapter {
  private folderIds = new Map<string, string>(); // our folder name -> id
  private buckets = new Map<BucketName, BucketInfo>();
  private loaded = false;
  constructor(private readonly o: OutlookAdapterOptions) {}

  async connect(): Promise<void> {
    await this.o.http.get("me/mailFolders/inbox", { $select: "id" }); // verifies the token
    await this.discover();
    await this.loadFolders();
  }
  async disconnect(): Promise<void> { this.buckets.clear(); }
  async capabilities(): Promise<AdapterCapabilities> {
    return { pushNotifications: false, labelSupport: false, idleSupport: false, moveSupport: true, customFolders: true, authMethods: ["oauth"] };
  }

  /** Read-only discovery of the Junk Email and Deleted Items ids, so they can be refused by id too. */
  private async discover(): Promise<void> {
    for (const alias of ["junkemail", "deleteditems"]) {
      try {
        const r = await this.o.http.get<{ id?: string }>(`me/mailFolders/${alias}`, { $select: "id" });
        if (r.id) this.o.forbiddenFolderIds.add(r.id);
      } catch (e) {
        // Fail closed: only "this folder does not exist" (404) means there is nothing to forbid.
        if (!(e instanceof GraphApiError && e.status === 404)) throw e;
      }
    }
  }

  private async loadFolders(): Promise<void> {
    const r = await this.o.http.get<{ value?: Array<{ id: string; displayName: string }> }>("me/mailFolders", { $top: 100, $select: "id,displayName" });
    for (const f of r.value ?? []) {
      if ((OUR_FOLDER_NAMES as readonly string[]).includes(f.displayName) && !this.o.forbiddenFolderIds.has(f.id)) { this.folderIds.set(f.displayName, f.id); this.o.ourFolderIds.add(f.id); }
    }
    this.loaded = true;
  }

  async ensureBucket(bucket: BucketName): Promise<BucketInfo> {
    const cached = this.buckets.get(bucket);
    if (cached) return cached;
    let info: BucketInfo;
    try {
      if (bucket === "archive") {
        await this.o.http.get("me/mailFolders/archive", { $select: "id" }); // the mailbox's own Archive folder
        info = { name: "Archive", path: "archive", created: false };
      } else {
        const name = OUTLOOK_FOLDERS[bucket];
        if (!this.loaded) await this.loadFolders();
        let id = this.folderIds.get(name);
        let created = false;
        if (!id) {
          try {
            id = (await this.o.http.post<{ id: string }>("me/mailFolders", { displayName: name })).id;
            created = true;
          } catch (e) {
            if (e instanceof GraphApiError && (e.status === 409 || e.code === "ErrorFolderExists")) { await this.loadFolders(); id = this.folderIds.get(name); }
            if (!id) throw e;
          }
          this.folderIds.set(name, id); this.o.ourFolderIds.add(id);
        }
        info = { name, path: id, created };
      }
    } catch {
      if (bucket === "junk") info = { ...(await this.ensureBucket("needs_review")), name: OUTLOOK_FOLDERS.junk, fallback: "needs_review" };
      else info = { name: bucket === "archive" ? "Archive" : OUTLOOK_FOLDERS[bucket], path: null, created: false, inPlace: true };
    }
    this.buckets.set(bucket, info);
    return info;
  }

  // ------------------------------------------------------------------ reading
  private toSummary(folder: string, m: GMsg): MessageSummary {
    return { id: m.id, folder, from: fromOf(m), subject: m.subject ?? "", date: new Date(m.receivedDateTime ?? 0), unread: m.isRead === false };
  }

  async listMessages(folder: string, opts: { cursor?: string; initialLimit?: number } = {}): Promise<ListResult> {
    const limit = opts.initialLimit ?? 100;
    let items: GMsg[] = [];
    let cursor = "";
    let resync = false;

    const fullList = async () => {
      const r = await this.o.http.get<{ value?: GMsg[] }>("me/mailFolders/inbox/messages", { $top: limit, $orderby: "receivedDateTime desc", $select: SELECT });
      items = (r.value ?? []).slice().reverse(); // oldest first
      // Baseline so later syncs only see changes. "latest" returns just a deltaLink (verify with Microsoft docs).
      try {
        const b = await this.o.http.get<{ "@odata.deltaLink"?: string }>("me/mailFolders/inbox/messages/delta", { $deltatoken: "latest", $select: SELECT });
        cursor = b["@odata.deltaLink"] ?? "";
      } catch { cursor = ""; } // no baseline: the next sync lists the newest again (upserts are idempotent)
    };

    if (!opts.cursor) await fullList();
    else {
      try {
        let link: string | undefined = opts.cursor;
        let delta = opts.cursor;
        const seen = new Map<string, GMsg>();
        for (let page = 0; link && page < 200; page++) {
          const r: { value?: GMsg[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string } = await this.o.http.get(link);
          for (const m of r.value ?? []) if (!m["@removed"]) seen.set(m.id, m);
          if (r["@odata.deltaLink"]) delta = r["@odata.deltaLink"];
          link = r["@odata.nextLink"];
        }
        items = [...seen.values()];
        cursor = delta;
      } catch (e) {
        if (e instanceof GraphApiError && (e.status === 410 || e.code === "SyncStateNotFound" || e.code === "resyncRequired")) { resync = true; await fullList(); }
        else throw e;
      }
    }
    return { messages: items.map((m) => this.toSummary(folder, m)), cursor, resync };
  }

  partialCursor(prev: string | undefined): string | undefined { return prev; }

  async fetchHeadersAndSnippet(folder: string, messageId: string): Promise<MessageDetail> {
    const m = await this.o.http.get<GMsg>(`me/messages/${messageId}`,
      { $select: `${SELECT},replyTo,internetMessageHeaders,body` }, { Prefer: 'outlook.body-content-type="text"' });
    const hdr = (n: string) => m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value;
    let body = m.body?.content ?? "";
    if (m.body?.contentType === "html") body = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    return {
      ...this.toSummary(folder, m),
      replyTo: m.replyTo?.[0]?.emailAddress?.address, listUnsubscribe: hdr("List-Unsubscribe"), authenticationResults: hdr("Authentication-Results"),
      snippet: buildSnippet(body), bodySample: body.slice(0, BODY_SAMPLE_MAX),
    };
  }

  // ------------------------------------------------------------------ moving
  private fail(base: { messageId: string; originalLocation: string }, e: unknown): MoveResult {
    return { ...base, success: false, moved: false, destination: null, bucketUsed: null, method: "none", error: e instanceof Error ? e.message : "move failed" };
  }

  private async refuseJunkOrDeleted(id: string): Promise<GMsg> {
    const m = await this.o.http.get<GMsg>(`me/messages/${id}`, { $select: "id,parentFolderId" });
    if (m.parentFolderId && this.o.forbiddenFolderIds.has(m.parentFolderId)) throw new Error("moves out of the provider spam folder are not done automatically");
    return m;
  }

  private async doMove(base: { messageId: string; originalLocation: string }, messageId: string, destinationId: string, destName: string, bucketUsed: BucketName | "inbox"): Promise<MoveResult> {
    const r = await this.o.http.post<{ id?: string }>(`me/messages/${messageId}/move`, { destinationId });
    return { ...base, success: true, moved: true, destination: destName, bucketUsed, method: "move", newMessageId: r.id };
  }

  async moveToBucket(folder: string, messageId: string, bucket: BucketName): Promise<MoveResult> {
    const base = { messageId, originalLocation: folder };
    try {
      const meta = await this.refuseJunkOrDeleted(messageId);
      if (bucket === "junk") {
        const d = await this.fetchHeadersAndSnippet(folder, messageId);
        if (!canMoveToJunk({ id: messageId, from: d.from, subject: d.subject, body: d.bodySample }, "junk").ok) bucket = "needs_review";
      }
      const info = await this.ensureBucket(bucket);
      if (info.inPlace || !info.path) return { ...base, success: true, moved: false, destination: null, bucketUsed: null, method: "none" };
      const bucketUsed: BucketName = info.fallback ?? bucket;
      if (meta.parentFolderId && meta.parentFolderId === info.path) return { ...base, success: true, moved: false, destination: info.name, bucketUsed, method: "none" };
      return await this.doMove(base, messageId, info.path, info.name, bucketUsed);
    } catch (e) {
      return this.fail(base, e);
    }
  }

  async moveToInbox(folder: string, messageId: string): Promise<MoveResult> {
    const base = { messageId, originalLocation: folder };
    try {
      await this.refuseJunkOrDeleted(messageId);
      return await this.doMove(base, messageId, "inbox", "INBOX", "inbox");
    } catch (e) {
      return this.fail(base, e);
    }
  }

  async undoMove(result: MoveResult): Promise<void> {
    if (!result.moved || !result.newMessageId) throw new Error("cannot reverse: the new message id is unknown");
    await this.o.http.post(`me/messages/${result.newMessageId}/move`, { destinationId: "inbox" });
  }

  async watch(folder: string, callback: (e: MailEvent) => void): Promise<Watcher> {
    let active = false;
    let timer: unknown;
    let cursor = (await this.listMessages(folder, { initialLimit: 1 })).cursor || undefined;
    const sched = this.o.scheduler ?? { setInterval: (f: () => void, ms: number) => setInterval(f, ms), clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>) };
    const tick = async () => {
      if (!active || !cursor) return;
      try {
        const r = await this.listMessages(folder, { cursor });
        cursor = r.cursor || cursor;
        for (const m of r.messages) callback({ type: "message_added", provider: "outlook", folder, messageId: m.id, timestamp: new Date() });
      } catch { /* try again next tick */ }
    };
    return {
      start: async () => { active = true; timer = sched.setInterval(() => void tick(), this.o.pollIntervalMs ?? 60_000); },
      stop: async () => { active = false; if (timer !== undefined) sched.clearInterval(timer); timer = undefined; },
      isActive: () => active,
      mode: () => (active ? "poll" : "stopped"),
    };
  }
}
