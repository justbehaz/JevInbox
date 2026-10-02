// A transport wrapper that makes writes impossible. Used by the smoke script so a dry run can
// never create a folder, move, copy, flag or watch anything on a real account.
import { FolderInfo, FolderState, ImapTransport, RawMessage, TransportCapabilities } from "./transport";

export class ReadOnlyViolation extends Error {
  constructor(op: string) {
    super(`read-only transport: "${op}" is not allowed`);
    this.name = "ReadOnlyViolation";
  }
}

export class ReadOnlyTransport implements ImapTransport {
  constructor(private readonly inner: ImapTransport) {}

  // reads
  connect() { return this.inner.connect(); }
  close() { return this.inner.close(); }
  capabilities(): Promise<TransportCapabilities> { return this.inner.capabilities(); }
  listFolders(): Promise<FolderInfo[]> { return this.inner.listFolders(); }
  folderState(path: string): Promise<FolderState> { return this.inner.folderState(path); }
  fetchSince(path: string, afterUid: number): Promise<RawMessage[]> { return this.inner.fetchSince(path, afterUid); }
  fetchOne(path: string, uid: number): Promise<RawMessage | null> { return this.inner.fetchOne(path, uid); }
  fetchLatest(path: string, limit: number): Promise<RawMessage[]> { return this.inner.fetchLatest(path, limit); }

  // writes: always refused
  createFolder(_path: string): Promise<boolean> { throw new ReadOnlyViolation("createFolder"); }
  move(_p: string, _u: number, _d: string): Promise<{ destUid?: number }> { throw new ReadOnlyViolation("move"); }
  copy(_p: string, _u: number, _d: string): Promise<{ destUid?: number }> { throw new ReadOnlyViolation("copy"); }
  setKeyword(_p: string, _u: number, _k: string, _on: boolean): Promise<void> { throw new ReadOnlyViolation("setKeyword"); }
  idle(_p: string, _c: () => void): Promise<{ stop(): Promise<void> }> { throw new ReadOnlyViolation("idle"); }
}
