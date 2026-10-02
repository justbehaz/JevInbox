import type Database from "better-sqlite3";
import { CategorySnapshot, ManagedCategory } from "../categories/manager";

/** Persists the category list (names and flags only). */
export class CategoryRepo {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, question TEXT NOT NULL,
        custom INTEGER NOT NULL, enabled INTEGER NOT NULL, pos INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  load(): CategorySnapshot | null {
    const rows = this.db.prepare(`SELECT id, name, question, custom, enabled FROM categories ORDER BY pos`).all() as Array<Omit<ManagedCategory, "custom" | "enabled"> & { custom: number; enabled: number }>;
    if (!rows.length) return null;
    const next = this.db.prepare(`SELECT value FROM meta WHERE key = 'next_custom'`).get() as { value: string } | undefined;
    return {
      cats: rows.map((r) => ({ id: r.id, name: r.name, question: r.question, custom: !!r.custom, enabled: !!r.enabled })),
      nextCustom: next ? Number(next.value) : rows.length + 1,
    };
  }

  save(s: CategorySnapshot): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM categories`).run(); // category definitions only; no mail is touched
      const ins = this.db.prepare(`INSERT INTO categories (id, name, question, custom, enabled, pos) VALUES (?, ?, ?, ?, ?, ?)`);
      s.cats.forEach((c, i) => ins.run(c.id, c.name, c.question, c.custom ? 1 : 0, c.enabled ? 1 : 0, i));
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('next_custom', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(s.nextCustom));
    });
    tx();
  }
}
