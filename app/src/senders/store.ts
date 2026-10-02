// Local sender view on SQLite (better-sqlite3). Nothing here talks to jev.ai or the network.
// A sender is a group-by on the normalised From address; it is not a category.
//
// Rules enforced here (02-never-junk.md):
//  - mark-junk never moves Auth mail, and never moves security-shaped mail (the backstop applies
//    to retroactive moves too);
//  - mute only hides, it never moves anything, and Auth mail is never hidden;
//  - nothing is ever deleted.
import Database from "better-sqlite3";
import { deterministicAuth, securityShape } from "../gate/detect";
import { UserContext } from "../gate/types";
import { normalizeSender, NormalizeOptions, rootDomain } from "./normalize";

export type StoredBucket = "auth" | "junk" | "needs_review" | "category" | "inbox";

export interface RecordInput {
  messageId: string;
  accountId?: string;
  folder: string;
  from: string;
  subject: string;
  /** Already-redacted snippet is what gets stored. */
  snippet: string;
  date: Date;
  unread: boolean;
  bucket: StoredBucket;
  categoryId?: string;
  /** Original body sample. Used only to compute security flags; NEVER stored. */
  bodySample: string;
}

export interface SenderSummary {
  senderKey: string;
  displayName: string | null;
  rootDomain: string;
  messageCount: number;
  unreadCount: number;
  lastSeen: string | null;
  firstSeen: string | null;
  auth: number;
  junk: number;
  needsReview: number;
  category: number;
  inbox: number;
  allowlisted: boolean;
  markedJunk: boolean;
  muted: boolean;
}

export interface StoredMessage {
  messageId: string;
  accountId: string;
  folder: string;
  senderKey: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  starred: boolean;
  bucket: StoredBucket;
  categoryId: string | null;
}

export interface DomainRollup {
  rootDomain: string;
  senderCount: number;
  messageCount: number;
  lastSeen: string | null;
}

export interface BucketBreakdownRow {
  label: string; // "auth" | "junk" | "needs_review" | "inbox" | category id
  count: number;
  unread: number;
}

/** Moves one message into Junk (provider-side). Return success and the bucket actually used. */
export type JunkMover = (m: { messageId: string; accountId: string; folder: string }) => Promise<{ success: boolean; bucketUsed?: "junk" | "needs_review" | "auth" | null }>;

export interface MarkJunkResult {
  moved: number;
  skippedAuth: number;
  skippedSecurityShape: number;
  failed: number;
  alreadyJunk: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS senders (
  sender_key   TEXT PRIMARY KEY,
  root_domain  TEXT NOT NULL,
  display_name TEXT,
  allowlisted  INTEGER NOT NULL DEFAULT 0,
  marked_junk  INTEGER NOT NULL DEFAULT 0,
  muted        INTEGER NOT NULL DEFAULT 0,
  auth_ever    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (NOT (allowlisted = 1 AND marked_junk = 1))
);
CREATE TABLE IF NOT EXISTS messages (
  message_id  TEXT NOT NULL,
  account_id  TEXT NOT NULL DEFAULT 'default',
  folder      TEXT NOT NULL,
  sender_key  TEXT NOT NULL REFERENCES senders(sender_key),
  subject     TEXT NOT NULL DEFAULT '',
  snippet     TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL,
  unread      INTEGER NOT NULL DEFAULT 1,
  starred     INTEGER NOT NULL DEFAULT 0,
  bucket      TEXT NOT NULL CHECK (bucket IN ('auth','junk','needs_review','category','inbox')),
  category_id TEXT,
  prev_bucket TEXT,
  det_auth    INTEGER NOT NULL DEFAULT 0,
  sec_shape   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_senders_root_domain ON senders(root_domain);
CREATE INDEX IF NOT EXISTS idx_messages_sender_date ON messages(sender_key, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender_bucket ON messages(sender_key, bucket);
`;

const SUMMARY_SQL = `
SELECT s.sender_key AS senderKey, s.display_name AS displayName, s.root_domain AS rootDomain,
  COUNT(m.message_id) AS messageCount,
  COALESCE(SUM(m.unread), 0) AS unreadCount,
  MAX(m.date) AS lastSeen, MIN(m.date) AS firstSeen,
  COALESCE(SUM(m.bucket = 'auth'), 0) AS auth,
  COALESCE(SUM(m.bucket = 'junk'), 0) AS junk,
  COALESCE(SUM(m.bucket = 'needs_review'), 0) AS needsReview,
  COALESCE(SUM(m.bucket = 'category'), 0) AS category,
  COALESCE(SUM(m.bucket = 'inbox'), 0) AS inbox,
  s.allowlisted, s.marked_junk AS markedJunk, s.muted
FROM senders s LEFT JOIN messages m ON m.sender_key = s.sender_key
`;

function toSummary(r: any): SenderSummary {
  return { ...r, allowlisted: !!r.allowlisted, markedJunk: !!r.markedJunk, muted: !!r.muted };
}

export class SenderStore {
  constructor(private readonly db: Database.Database, private readonly norm: NormalizeOptions = {}) {
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    this.actionSql = {
    allow: db.prepare(`UPDATE senders SET allowlisted = 1, marked_junk = 0, updated_at = @now WHERE sender_key = @k`),
    unallow: db.prepare(`UPDATE senders SET allowlisted = 0, updated_at = @now WHERE sender_key = @k`),
    mute: db.prepare(`UPDATE senders SET muted = 1, updated_at = @now WHERE sender_key = @k`),
    unmute: db.prepare(`UPDATE senders SET muted = 0, updated_at = @now WHERE sender_key = @k`),
    unmark: db.prepare(`UPDATE senders SET marked_junk = 0, updated_at = @now WHERE sender_key = @k`),
    mark: db.prepare(`UPDATE senders SET marked_junk = 1, allowlisted = 0, updated_at = @now WHERE sender_key = @k`),
  };
  }

  static open(file = ":memory:", norm: NormalizeOptions = {}): SenderStore {
    return new SenderStore(new Database(file), norm);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- ingest
  recordMessage(m: RecordInput): void {
    const id = normalizeSender(m.from, this.norm);
    const now = new Date().toISOString();
    const original = { id: m.messageId, from: m.from, subject: m.subject, body: m.bodySample };
    const detAuth = deterministicAuth(original) ? 1 : 0;
    const secShape = securityShape(original) ? 1 : 0;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO senders (sender_key, root_domain, display_name, created_at, updated_at)
           VALUES (@key, @root, @name, @now, @now)
           ON CONFLICT(sender_key) DO UPDATE SET
             display_name = COALESCE(@name, display_name), updated_at = @now`,
        )
        .run({ key: id.key, root: id.rootDomain, name: id.displayName, now });
      this.db
        .prepare(
          `INSERT INTO messages (message_id, account_id, folder, sender_key, subject, snippet, date, unread,
                                 bucket, category_id, det_auth, sec_shape)
           VALUES (@mid, @acct, @folder, @key, @subject, @snippet, @date, @unread, @bucket, @cat, @det, @shape)
           ON CONFLICT(account_id, message_id) DO UPDATE SET
             folder = @folder, bucket = @bucket, category_id = @cat, unread = @unread,
             det_auth = MAX(det_auth, @det), sec_shape = MAX(sec_shape, @shape)`, // flags are sticky: a re-record can never clear them
        )
        .run({
          mid: m.messageId, acct: m.accountId ?? "default", folder: m.folder, key: id.key,
          subject: m.subject, snippet: m.snippet, date: m.date.toISOString(), unread: m.unread ? 1 : 0,
          bucket: m.bucket, cat: m.categoryId ?? null, det: detAuth, shape: secShape,
        });
      if (m.bucket === "auth" || detAuth) {
        this.db.prepare(`UPDATE senders SET auth_ever = 1, updated_at = ? WHERE sender_key = ?`).run(now, id.key);
      }
    });
    tx();
  }

  // ---------------------------------------------------------------- queries
  /** Every message from one sender across ALL buckets and categories (never filtered by mute). */
  messagesFromSender(senderKey: string, opts: { bucket?: string; limit?: number } = {}): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT message_id AS messageId, account_id AS accountId, folder, sender_key AS senderKey, subject, snippet,
                date, unread, starred, bucket, category_id AS categoryId
         FROM messages WHERE sender_key = @k AND (@bucket IS NULL OR bucket = @bucket)
         ORDER BY date DESC, message_id DESC LIMIT @limit`,
      )
      .all({ k: senderKey.toLowerCase(), bucket: opts.bucket ?? null, limit: opts.limit ?? 1_000_000 }) as any[];
    return rows.map((r) => ({ ...r, unread: !!r.unread, starred: !!r.starred }));
  }

  /** Count and last-seen per sender. Muted senders are hidden unless they have Auth mail. */
  senderSummary(opts: { includeMuted?: boolean } = {}): SenderSummary[] {
    const rows = this.db
      .prepare(`${SUMMARY_SQL} GROUP BY s.sender_key ORDER BY lastSeen DESC, s.sender_key`)
      .all() as any[];
    return rows.map(toSummary).filter((s) => opts.includeMuted || !s.muted || s.auth > 0);
  }

  sender(senderKey: string): SenderSummary | null {
    const r = this.db.prepare(`${SUMMARY_SQL} WHERE s.sender_key = ? GROUP BY s.sender_key`).get(senderKey.toLowerCase());
    return r ? toSummary(r) : null;
  }

  bucketBreakdown(senderKey: string): BucketBreakdownRow[] {
    return this.db
      .prepare(
        `SELECT CASE WHEN bucket = 'category' THEN COALESCE(category_id, 'category') ELSE bucket END AS label,
                COUNT(*) AS count, COALESCE(SUM(unread), 0) AS unread
         FROM messages WHERE sender_key = ? GROUP BY label ORDER BY count DESC, label`,
      )
      .all(senderKey.toLowerCase()) as BucketBreakdownRow[];
  }

  domainRollup(): DomainRollup[] {
    return this.db
      .prepare(
        `SELECT s.root_domain AS rootDomain, COUNT(DISTINCT s.sender_key) AS senderCount,
                COUNT(m.message_id) AS messageCount, MAX(m.date) AS lastSeen
         FROM senders s LEFT JOIN messages m ON m.sender_key = s.sender_key
         GROUP BY s.root_domain ORDER BY lastSeen DESC, rootDomain`,
      )
      .all() as DomainRollup[];
  }

  /** Messages for default inbox-style lists: hides a muted sender's mail, but never Auth mail. */
  visibleMessages(opts: { limit?: number } = {}): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.message_id AS messageId, m.account_id AS accountId, m.folder, m.sender_key AS senderKey, m.subject,
                m.snippet, m.date, m.unread, m.starred, m.bucket, m.category_id AS categoryId
         FROM messages m JOIN senders s ON s.sender_key = m.sender_key
         WHERE s.muted = 0 OR m.bucket = 'auth'
         ORDER BY m.date DESC, m.message_id DESC LIMIT ?`,
      )
      .all(opts.limit ?? 1_000_000) as any[];
    return rows.map((r) => ({ ...r, unread: !!r.unread, starred: !!r.starred }));
  }

  // ---------------------------------------------------------------- gate wiring
  /** Gate inputs derived from sender actions. Reply history comes from the caller (Sent folder). */
  userContext(hasRepliedTo: (address: string) => boolean = () => false): UserContext {
    const allowed = this.db.prepare(`SELECT sender_key FROM senders WHERE allowlisted = 1`);
    const marked = this.db.prepare(`SELECT sender_key FROM senders WHERE marked_junk = 1`);
    const keys = (st: Database.Statement) => (st.all() as { sender_key: string }[]).map((r) => r.sender_key);
    const authHist = this.db.prepare(`SELECT 1 FROM senders WHERE auth_ever = 1 AND (sender_key = ? OR root_domain = ?) LIMIT 1`);
    return {
      allowlist: keys(allowed),
      markedJunk: keys(marked),
      hasRepliedTo,
      hasAuthHistory: (address, domain) => !!authHist.get(address.toLowerCase(), rootDomain(domain)),
    };
  }

  // ---------------------------------------------------------------- sender actions
  // Fixed statements only: no SQL text is ever built from variable input.
  private readonly actionSql: Record<"allow" | "unallow" | "mute" | "unmute" | "unmark" | "mark", Database.Statement>;

  private act(senderKey: string, action: "allow" | "unallow" | "mute" | "unmute" | "unmark" | "mark"): void {
    const info = this.actionSql[action].run({ k: senderKey.toLowerCase(), now: new Date().toISOString() });
    if (!info.changes) throw new Error("unknown sender");
  }

  /** Allow: future mail is exempt from Junk and filed normally. Existing mail stays put. */
  allow(senderKey: string): void {
    this.act(senderKey, "allow");
  }
  unallow(senderKey: string): void {
    this.act(senderKey, "unallow");
  }

  /** Mute only hides. It never moves, flags or changes any message. */
  mute(senderKey: string): void {
    this.act(senderKey, "mute");
  }
  unmute(senderKey: string): void {
    this.act(senderKey, "unmute");
  }

  /** Unmark: future mail follows normal classification. Mail already in Junk stays put. */
  unmarkJunk(senderKey: string): void {
    this.act(senderKey, "unmark");
  }

  /**
   * Mark sender junk. Future mail: the gate's explicit-user-mark rule (Auth still wins).
   * Existing mail: only non-Auth, non-security-shaped mail is moved to Junk, one message at a
   * time through `mover`; each stays where it is if the move fails.
   */
  async markJunk(senderKey: string, mover: JunkMover): Promise<MarkJunkResult> {
    const key = senderKey.toLowerCase();
    this.act(key, "mark"); // allowlist and junk mark are exclusive
    const rows = this.db
      .prepare(`SELECT message_id AS messageId, account_id AS accountId, folder, bucket, det_auth AS detAuth, sec_shape AS secShape
                FROM messages WHERE sender_key = ? ORDER BY date`)
      .all(key) as Array<{ messageId: string; accountId: string; folder: string; bucket: StoredBucket; detAuth: number; secShape: number }>;
    const result: MarkJunkResult = { moved: 0, skippedAuth: 0, skippedSecurityShape: 0, failed: 0, alreadyJunk: 0 };
    for (const r of rows) {
      if (r.bucket === "auth" || r.detAuth) { result.skippedAuth++; continue; }
      if (r.secShape) { result.skippedSecurityShape++; continue; }
      if (r.bucket === "junk") { result.alreadyJunk++; continue; }
      let res;
      try { res = await mover({ messageId: r.messageId, accountId: r.accountId, folder: r.folder }); } catch { res = { success: false }; }
      if (!res.success) { result.failed++; continue; }
      const newBucket: StoredBucket = res.bucketUsed === "needs_review" ? "needs_review" : res.bucketUsed === "auth" ? "auth" : "junk";
      this.db.prepare(`UPDATE messages SET prev_bucket = bucket, bucket = ? WHERE account_id = ? AND message_id = ?`)
        .run(newBucket, r.accountId, r.messageId);
      result.moved++;
    }
    return result;
  }
}
