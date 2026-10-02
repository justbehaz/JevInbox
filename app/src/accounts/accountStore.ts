// Account METADATA only (provider, address, server, sync status). Passwords and tokens are never
// stored here; they live in the SecretStore under entryName(provider, email).
import type Database from "better-sqlite3";
import { TlsMode } from "../providers/imap/presets";
import { entryName } from "../secrets/store";

export type AccountProvider = "icloud" | "imap";

export interface AccountRow {
  id: string; // = entry name, e.g. jev-inbox-icloud-user@example.com
  provider: AccountProvider;
  email: string;
  host: string;
  port: number;
  tls: TlsMode;
  createdAt: string;
  cursor: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: "ok" | "error" | null;
  lastSyncNote: string | null;
}

export function accountIdFor(provider: AccountProvider, email: string): string {
  return entryName(provider, email);
}

export class AccountStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, email TEXT NOT NULL,
        host TEXT NOT NULL, port INTEGER NOT NULL, tls TEXT NOT NULL, created_at TEXT NOT NULL,
        cursor TEXT, last_sync_at TEXT, last_sync_status TEXT, last_sync_note TEXT
      );
    `);
  }

  private static COLS = `id, provider, email, host, port, tls, created_at AS createdAt, cursor, last_sync_at AS lastSyncAt,
    last_sync_status AS lastSyncStatus, last_sync_note AS lastSyncNote`;

  add(a: Omit<AccountRow, "createdAt" | "cursor" | "lastSyncAt" | "lastSyncStatus" | "lastSyncNote">): AccountRow {
    this.db
      .prepare(`INSERT INTO accounts (id, provider, email, host, port, tls, created_at) VALUES (@id, @provider, @email, @host, @port, @tls, @now)`)
      .run({ ...a, now: new Date().toISOString() });
    return this.get(a.id)!;
  }
  get(id: string): AccountRow | null {
    return (this.db.prepare(`SELECT ${AccountStore.COLS} FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined) ?? null;
  }
  list(): AccountRow[] {
    return this.db.prepare(`SELECT ${AccountStore.COLS} FROM accounts ORDER BY created_at`).all() as AccountRow[];
  }
  setCursor(id: string, cursor: string): void {
    this.db.prepare(`UPDATE accounts SET cursor = ? WHERE id = ?`).run(cursor, id);
  }
  recordSync(id: string, status: "ok" | "error", note: string): void {
    this.db.prepare(`UPDATE accounts SET last_sync_at = ?, last_sync_status = ?, last_sync_note = ? WHERE id = ?`).run(new Date().toISOString(), status, note, id);
  }
  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id).changes > 0;
  }
}
