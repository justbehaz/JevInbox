// Gmail implementation of MailAdapter over REST. Labels, not folders: a "move" adds one of our
// Jev/* labels and removes INBOX. SPAM and TRASH are never read, added, removed or moved. No
// delete or trash endpoint exists in the guard's allow-list.
import { buildSnippet } from "../../gate/redact";
import { canMoveToJunk } from "../../gate/gate";
import {
  AdapterCapabilities, BucketInfo, BucketName, ListResult, MailAdapter, MailEvent, MessageDetail, MessageSummary, MoveResult, Watcher,
} from "../types";
import { Scheduler } from "../imap/adapter";
import { OUR_LABEL_NAMES } from "./guard";
import { GmailApiError, GmailTransportLike } from "./http";

const BODY_SAMPLE_MAX = 4000;
const INBOX = "INBOX";
export const GMAIL_LABELS: Record<Exclude<BucketName, "archive">, string> = {
  auth: "Jev/Auth", needs_review: "Jev/Needs review", junk: "Jev/Junk",
};
const ARCHIVE_NAME = "All Mail";

interface GmailMessage {
  id: string; labelIds?: string[]; internalDate?: string; snippet?: string;
  payload?: { headers?: Array<{ name: string; value: string }>; mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
}
interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] }

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
const b64 = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");

function textOf(p?: GmailPart | GmailMessage["payload"]): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return b64(p.body.data);
  for (const c of p.parts ?? []) { const t = textOf(c); if (t) return t; }
  if (p.mimeType === "text/html" && p.body?.data) return b64(p.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if (p.body?.data) return b64(p.body.data);
  return "";
}

export interface GmailAdapterOptions {
  http: GmailTransportLike;
  /** Shared with the guard so it knows which label ids are ours. */
  ourLabelIds: Set<string>;
  scheduler?: Scheduler;
  pollIntervalMs?: number;
}

export class GmailAdapter implements MailAdapter {
  private labelIds = new Map<string, string>(); // name -> id (ours only)
  private buckets = new Map<BucketName, BucketInfo>();
  private labelsLoaded = false;
  constructor(private readonly o: GmailAdapterOptions) {}

  async connect(): Promise<void> {
    await this.o.http.get("profile"); // verifies the token
    await this.loadLabels();
  }
  async disconnect(): Promise<void> { this.buckets.clear(); }

  async capabilities(): Promise<AdapterCapabilities> {
    return { pushNotifications: false, labelSupport: true, idleSupport: false, moveSupport: true, customFolders: true, authMethods: ["oauth"] };
  }

  /** Lists labels so the guard knows our label ids. Reads only. */
  private async loadLabels(): Promise<void> {
    const r = await this.o.http.get<{ labels?: Array<{ id: string; name: string }> }>("labels");
    for (const l of r.labels ?? []) {
      if ((OUR_LABEL_NAMES as readonly string[]).includes(l.name)) { this.labelIds.set(l.name, l.id); this.o.ourLabelIds.add(l.id); }
    }
    this.labelsLoaded = true;
  }

  async ensureBucket(bucket: BucketName): Promise<BucketInfo> {
    const cached = this.buckets.get(bucket);
    if (cached) return cached;
    let info: BucketInfo;
    if (bucket === "archive") {
      info = { name: ARCHIVE_NAME, path: ARCHIVE_NAME, created: false }; // Archive = remove INBOX; stays in All Mail
    } else {
      const name = GMAIL_LABELS[bucket];
      try {
        if (!this.labelsLoaded) await this.loadLabels();
        let id = this.labelIds.get(name);
        let created = false;
        if (!id) {
          const r = await this.o.http.post<{ id: string }>("labels", { name, labelListVisibility: "labelShow", messageListVisibility: "show" });
          id = r.id; created = true;
          this.labelIds.set(name, id); this.o.ourLabelIds.add(id);
        }
        info = { name, path: name, created };
      } catch {
        // Fallback per 06-mail-sources.md: Junk -> Needs review -> leave in place.
        if (bucket === "junk") info = { ...(await this.ensureBucket("needs_review")), name, fallback: "needs_review" };
        else info = { name, path: null, created: false, inPlace: true };
      }
    }
    this.buckets.set(bucket, info);
    return info;
  }

  // ------------------------------------------------------------------ reading
  private async getMeta(id: string): Promise<GmailMessage> {
    return this.o.http.get<GmailMessage>(`messages/${id}`, { format: "metadata", metadataHeaders: "From,Subject,Date" });
  }
  private toSummary(folder: string, m: GmailMessage): MessageSummary {
    return {
      id: m.id, folder, from: header(m, "From") ?? "", subject: header(m, "Subject") ?? "",
      date: new Date(m.internalDate ? Number(m.internalDate) : header(m, "Date") ?? 0), unread: (m.labelIds ?? []).includes("UNREAD"),
    };
  }

  async listMessages(folder: string, opts: { cursor?: string; initialLimit?: number } = {}): Promise<ListResult> {
    const limit = opts.initialLimit ?? 100;
    let ids: string[] = [];
    let resync = false;
    let cursor: string;

    const fullList = async () => {
      const profile = await this.o.http.get<{ historyId: string }>("profile"); // read BEFORE listing: no gaps
      const r = await this.o.http.get<{ messages?: Array<{ id: string }> }>("messages", { labelIds: INBOX, maxResults: limit });
      ids = (r.messages ?? []).map((x) => x.id).reverse(); // oldest first
      cursor = profile.historyId;
    };

    if (!opts.cursor) {
      await fullList();
    } else {
      try {
        const found = new Set<string>();
        let pageToken: string | undefined;
        let latest = opts.cursor;
        do {
          const r = await this.o.http.get<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }> }>; historyId?: string; nextPageToken?: string }>(
            "history", { startHistoryId: opts.cursor, historyTypes: "messageAdded", labelId: INBOX, maxResults: 500, pageToken });
          for (const h of r.history ?? []) for (const a of h.messagesAdded ?? []) if ((a.message.labelIds ?? []).includes(INBOX)) found.add(a.message.id);
          if (r.historyId) latest = r.historyId;
          pageToken = r.nextPageToken;
        } while (pageToken);
        ids = [...found];
        cursor = latest;
      } catch (e) {
        if (e instanceof GmailApiError && e.status === 404) { resync = true; await fullList(); } // history too old: full resync
        else throw e;
      }
    }

    const messages: MessageSummary[] = [];
    for (const id of ids) {
      try { messages.push(this.toSummary(folder, await this.getMeta(id))); }
      catch (e) { if (!(e instanceof GmailApiError && e.status === 404)) throw e; } // deleted meanwhile
    }
    return { messages, cursor: cursor!, resync };
  }

  /** Gmail history cannot resume mid-way: on failure or truncation keep the previous cursor. */
  partialCursor(prev: string | undefined): string | undefined { return prev; }

  async fetchHeadersAndSnippet(folder: string, messageId: string): Promise<MessageDetail> {
    const m = await this.o.http.get<GmailMessage>(`messages/${messageId}`, { format: "full" });
    const body = textOf(m.payload) || m.snippet || "";
    return {
      ...this.toSummary(folder, m),
      replyTo: header(m, "Reply-To"), listUnsubscribe: header(m, "List-Unsubscribe"), authenticationResults: header(m, "Authentication-Results"),
      snippet: buildSnippet(body), bodySample: body.slice(0, BODY_SAMPLE_MAX),
    };
  }

  // ------------------------------------------------------------------ moving
  private fail(base: { messageId: string; originalLocation: string }, e: unknown): MoveResult {
    return { ...base, success: false, moved: false, destination: null, bucketUsed: null, method: "none", error: e instanceof Error ? e.message : "move failed" };
  }

  private async refuseSpamTrash(id: string): Promise<GmailMessage> {
    const m = await this.getMeta(id);
    if ((m.labelIds ?? []).some((l) => l === "SPAM" || l === "TRASH")) throw new Error("moves out of the provider spam folder are not done automatically");
    return m;
  }

  async moveToBucket(folder: string, messageId: string, bucket: BucketName): Promise<MoveResult> {
    const base = { messageId, originalLocation: folder };
    try {
      let meta = await this.refuseSpamTrash(messageId);
      // Adapter-level defence: whoever calls this, Auth or security-shaped mail never goes to Junk.
      if (bucket === "junk") {
        const d = await this.fetchHeadersAndSnippet(folder, messageId);
        if (!canMoveToJunk({ id: messageId, from: d.from, subject: d.subject, body: d.bodySample }, "junk").ok) bucket = "needs_review";
      }
      const info = await this.ensureBucket(bucket);
      if (info.inPlace || !info.path) return { ...base, success: true, moved: false, destination: null, bucketUsed: null, method: "none" };
      const bucketUsed: BucketName = info.fallback ?? bucket;
      const labelId = bucketUsed === "archive" ? undefined : this.labelIds.get(GMAIL_LABELS[bucketUsed]);
      const have = new Set(meta.labelIds ?? []);
      if (!have.has(INBOX) && (!labelId || have.has(labelId))) return { ...base, success: true, moved: false, destination: info.path, bucketUsed, method: "none" };
      await this.o.http.post(`messages/${messageId}/modify`, { ...(labelId ? { addLabelIds: [labelId] } : {}), removeLabelIds: [INBOX] });
      return { ...base, success: true, moved: true, destination: info.path, bucketUsed, method: "move" };
    } catch (e) {
      return this.fail(base, e);
    }
  }

  async moveToInbox(folder: string, messageId: string): Promise<MoveResult> {
    const base = { messageId, originalLocation: folder };
    try {
      const meta = await this.refuseSpamTrash(messageId);
      const ours = [...this.labelIds.values()].filter((id) => (meta.labelIds ?? []).includes(id));
      if ((meta.labelIds ?? []).includes(INBOX) && !ours.length) return { ...base, success: true, moved: false, destination: INBOX, bucketUsed: "inbox", method: "none" };
      await this.o.http.post(`messages/${messageId}/modify`, { addLabelIds: [INBOX], ...(ours.length ? { removeLabelIds: ours } : {}) });
      return { ...base, success: true, moved: true, destination: INBOX, bucketUsed: "inbox", method: "move" };
    } catch (e) {
      return this.fail(base, e);
    }
  }

  async undoMove(result: MoveResult): Promise<void> {
    if (!result.moved) return;
    const label = result.bucketUsed && result.bucketUsed !== "archive" && result.bucketUsed !== "inbox" ? this.labelIds.get(GMAIL_LABELS[result.bucketUsed]) : undefined;
    await this.o.http.post(`messages/${result.messageId}/modify`, { addLabelIds: [INBOX], ...(label ? { removeLabelIds: [label] } : {}) });
  }

  async watch(folder: string, callback: (e: MailEvent) => void): Promise<Watcher> {
    let active = false;
    let timer: unknown;
    let cursor = (await this.o.http.get<{ historyId: string }>("profile")).historyId;
    const sched = this.o.scheduler ?? { setInterval: (f: () => void, ms: number) => setInterval(f, ms), clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>) };
    const tick = async () => {
      if (!active) return;
      try {
        const r = await this.listMessages(folder, { cursor });
        cursor = r.cursor;
        for (const m of r.messages) callback({ type: "message_added", provider: "gmail", folder, messageId: m.id, timestamp: new Date() });
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
