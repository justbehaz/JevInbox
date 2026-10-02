import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Open the on-disk database. File is private to the user (0600). It never holds secrets. */
export function openDb(file: string): Database.Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  if (file !== ":memory:") { try { chmodSync(file, 0o600); } catch { /* best effort */ } }
  return db;
}
