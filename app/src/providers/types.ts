// Provider-neutral adapter types. Based on 06-mail-sources.md "Common: Adapter Interface".
// Simplifications for the IMAP step: folder and message ids are strings; Message ids for IMAP
// are "<uidValidity>:<uid>".

export type BucketName = "auth" | "junk" | "needs_review" | "archive";

export interface MessageSummary {
  id: string;
  folder: string;
  from: string;
  subject: string;
  date: Date;
  unread: boolean;
}

export interface MessageDetail extends MessageSummary {
  replyTo?: string;
  listUnsubscribe?: string;
  authenticationResults?: string;
  /** Redacted, <= 500 chars. Safe to log-free display. Never contains codes or link tokens. */
  snippet: string;
  /**
   * ORIGINAL body text sample, kept on device only. The gate's deterministic Auth pass and
   * security-shape backstop need the unredacted text (see 03-jev-contract.md). Never log it,
   * never send it anywhere. The gate redacts its own copy before any jev.ai call.
   */
  bodySample: string;
}

export interface ListResult {
  messages: MessageSummary[];
  /** Opaque sync cursor to pass to the next call. */
  cursor: string;
  /** True if the server reset UIDs (UIDVALIDITY changed) and this is a full resync. */
  resync: boolean;
}

export interface BucketInfo {
  name: string;
  path: string | null; // null when no folder could be used
  created: boolean;
  /** Set when the requested bucket could not be created and another bucket is used instead. */
  fallback?: BucketName;
  /** True when no folder is available: mail stays where it is (app-level label only). */
  inPlace?: boolean;
}

export interface MoveResult {
  success: boolean;
  /** False when mail was deliberately left in place (no usable bucket). */
  moved: boolean;
  messageId: string;
  originalLocation: string;
  destination: string | null;
  bucketUsed: BucketName | "inbox" | null;
  /** How it was done: server MOVE, or COPY plus keyword flag (original kept, nothing deleted). */
  method: "move" | "copy_flag" | "none";
  newMessageId?: string;
  error?: string;
}

export interface AdapterCapabilities {
  pushNotifications: boolean;
  labelSupport: boolean;
  idleSupport: boolean;
  moveSupport: boolean;
  customFolders: boolean;
  authMethods: string[];
}

export interface MailEvent {
  type: "message_added";
  provider: string;
  folder: string;
  messageId: string;
  timestamp: Date;
}

export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  isActive(): boolean;
  mode(): "idle" | "poll" | "stopped";
}

export interface MailAdapter {
  connect(): Promise<void>;
  /** initialLimit: with no cursor, only the newest N messages are listed (first sync). */
  listMessages(folder: string, opts?: { cursor?: string; initialLimit?: number }): Promise<ListResult>;
  fetchHeadersAndSnippet(folder: string, messageId: string): Promise<MessageDetail>;
  ensureBucket(bucket: BucketName): Promise<BucketInfo>;
  /** Moves (never deletes). Falls back per 06: junk -> needs_review -> leave in place. */
  moveToBucket(folder: string, messageId: string, bucket: BucketName): Promise<MoveResult>;
  /** Restore a message to the inbox. */
  moveToInbox(folder: string, messageId: string): Promise<MoveResult>;
  /** Reverse a previous move. */
  undoMove(result: MoveResult): Promise<void>;
  watch(folder: string, callback: (e: MailEvent) => void): Promise<Watcher>;
  capabilities(): Promise<AdapterCapabilities>;
  disconnect(): Promise<void>;
}
