// The thin seam between the adapter and an IMAP library. The interface deliberately has NO
// delete, expunge, or \Deleted-flag operation, so the adapter cannot delete mail even by mistake.

export interface FolderInfo {
  path: string;
  delimiter: string;
  specialUse?: string; // "\\Junk", "\\Trash", ...
}

export interface TransportCapabilities {
  move: boolean; // MOVE extension (RFC 6851)
  idle: boolean;
  xoauth2: boolean; // AUTH=XOAUTH2 advertised
}

export interface RawMessage {
  uid: number;
  from: string;
  replyTo?: string;
  subject: string;
  date: Date;
  unread: boolean;
  listUnsubscribe?: string;
  authenticationResults?: string;
  /** Plain-text body sample (bounded). */
  bodyText: string;
}

export interface FolderState {
  uidValidity: number;
  uidNext: number;
}

export interface ImapTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  capabilities(): Promise<TransportCapabilities>;
  listFolders(): Promise<FolderInfo[]>;
  /** Returns true if created, false if it already existed. Throws if it cannot be created. */
  createFolder(path: string): Promise<boolean>;
  folderState(path: string): Promise<FolderState>;
  /** Messages with uid > afterUid, ascending. */
  fetchSince(path: string, afterUid: number): Promise<RawMessage[]>;
  /** The newest `limit` messages, ascending by UID. Read-only. */
  fetchLatest(path: string, limit: number): Promise<RawMessage[]>;
  fetchOne(path: string, uid: number): Promise<RawMessage | null>;
  /** Server-side MOVE. Only call if capabilities().move. */
  move(path: string, uid: number, destination: string): Promise<{ destUid?: number }>;
  /** COPY; the source message is left untouched. */
  copy(path: string, uid: number, destination: string): Promise<{ destUid?: number }>;
  /** Add/remove a harmless keyword. Implementations MUST reject "\\Deleted". */
  setKeyword(path: string, uid: number, keyword: string, on: boolean): Promise<void>;
  /** Notify on new mail in `path` (IDLE). Resolves with a stopper. */
  idle(path: string, onChange: () => void): Promise<{ stop(): Promise<void> }>;
}

export const FORBIDDEN_KEYWORDS = /^\\?(deleted)$/i;
