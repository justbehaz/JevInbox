import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CategoryManager } from "../src/categories/manager";
import { assertSecretsConfigured, createSecretStore, EncryptedFileSecretStore, entryName, KeychainSecretStore, MemorySecretStore, MissingEncryptionKeyError } from "../src/secrets";
import { CategoryRepo } from "../src/storage/categoryRepo";
import { openDb } from "../src/storage/db";
import { resolveDataDir } from "../src/storage/dataDir";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "jev-test-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const KEY = "unit-test-key-0123456789abcdef-not-real";

describe("entry names follow 06-mail-sources.md", () => {
  it("jev-inbox-{provider}-{user-id}, lowercased", () => {
    expect(entryName("iCloud", " User@Example.COM ")).toBe("jev-inbox-icloud-user@example.com");
  });
});

describe("MemorySecretStore (used by tests)", () => {
  it("get, set, delete", async () => {
    const s = new MemorySecretStore();
    expect(await s.get("a")).toBeNull();
    await s.set("a", "1");
    expect(await s.get("a")).toBe("1");
    expect(await s.delete("a")).toBe(true);
    expect(await s.delete("a")).toBe(false);
  });
});

describe("KeychainSecretStore (fake keyring, never the real Keychain)", () => {
  const fakeKeyring = () => {
    const mem = new Map<string, string>();
    const calls: string[] = [];
    const factory = (service: string, account: string) => ({
      setPassword: (p: string) => { calls.push(`set:${service}`); mem.set(`${service}|${account}`, p); },
      getPassword: () => mem.get(`${service}|${account}`) ?? null,
      deletePassword: () => mem.delete(`${service}|${account}`),
    });
    return { mem, calls, factory };
  };
  it("stores under the 06 entry name and round-trips", async () => {
    const k = fakeKeyring();
    const s = new KeychainSecretStore(k.factory);
    const name = entryName("icloud", "user@example.com");
    await s.set(name, '{"password":"pw"}');
    expect(k.calls).toEqual([`set:${name}`]);
    expect(await s.get(name)).toBe('{"password":"pw"}');
    expect(await s.delete(name)).toBe(true);
    expect(await s.get(name)).toBeNull();
  });
  it("delete never throws when the entry is missing", async () => {
    const s = new KeychainSecretStore(() => ({ setPassword() {}, getPassword: () => null, deletePassword: () => { throw new Error("NoEntry"); } }));
    expect(await s.delete("x")).toBe(false);
  });
});

describe("EncryptedFileSecretStore (AES-256-GCM)", () => {
  it("round-trips, and the file never contains the plaintext", async () => {
    const f = join(tmp(), "secrets.enc.json");
    const s = new EncryptedFileSecretStore(f, KEY);
    await s.set("jev-inbox-imap-a@example.com", "super-secret-password-123");
    expect(await s.get("jev-inbox-imap-a@example.com")).toBe("super-secret-password-123");
    const raw = readFileSync(f, "utf8");
    expect(raw).not.toContain("super-secret-password-123");
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw).entries["jev-inbox-imap-a@example.com"]).toHaveProperty("tag");
  });
  it("file is private (0600) and survives a restart with the same key", async () => {
    const f = join(tmp(), "secrets.enc.json");
    await new EncryptedFileSecretStore(f, KEY).set("n", "v");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(await new EncryptedFileSecretStore(f, KEY).get("n")).toBe("v");
  });
  it("a wrong key cannot decrypt", async () => {
    const f = join(tmp(), "secrets.enc.json");
    await new EncryptedFileSecretStore(f, KEY).set("n", "v");
    await expect(new EncryptedFileSecretStore(f, KEY + "x").get("n")).rejects.toThrow(/could not decrypt/);
  });
  it("tampering and swapping values between names are detected", async () => {
    const f = join(tmp(), "secrets.enc.json");
    const s = new EncryptedFileSecretStore(f, KEY);
    await s.set("a", "AAA");
    await s.set("b", "BBB");
    const data = JSON.parse(readFileSync(f, "utf8"));
    [data.entries.a, data.entries.b] = [data.entries.b, data.entries.a];
    writeFileSync(f, JSON.stringify(data));
    await expect(s.get("a")).rejects.toThrow();
    await expect(s.get("b")).rejects.toThrow();
  });
  it("each value uses a fresh IV", async () => {
    const f = join(tmp(), "secrets.enc.json");
    const s = new EncryptedFileSecretStore(f, KEY);
    await s.set("a", "same"); await s.set("b", "same");
    const e = JSON.parse(readFileSync(f, "utf8")).entries;
    expect(e.a.iv).not.toBe(e.b.iv);
    expect(e.a.ct).not.toBe(e.b.ct);
  });
  it("delete removes the entry", async () => {
    const f = join(tmp(), "secrets.enc.json");
    const s = new EncryptedFileSecretStore(f, KEY);
    await s.set("a", "1");
    expect(await s.delete("a")).toBe(true);
    expect(await s.get("a")).toBeNull();
  });
  it("refuses a missing or short key", () => {
    for (const k of [undefined, "", "short"]) expect(() => new EncryptedFileSecretStore(join(tmp(), "x"), k)).toThrow(MissingEncryptionKeyError);
  });
});

describe("secret store selection and startup check", () => {
  it("macOS uses the Keychain, others the encrypted file", () => {
    const dataDir = tmp();
    expect(createSecretStore({ platform: "darwin", env: {}, dataDir }).kind).toBe("keychain");
    expect(createSecretStore({ platform: "linux", env: { TOKEN_ENCRYPTION_KEY: KEY }, dataDir }).kind).toBe("encrypted-file");
  });
  it("non-macOS without TOKEN_ENCRYPTION_KEY refuses to start", () => {
    expect(() => assertSecretsConfigured("linux", {})).toThrow(MissingEncryptionKeyError);
    expect(() => assertSecretsConfigured("win32", { TOKEN_ENCRYPTION_KEY: "short" })).toThrow();
    expect(() => createSecretStore({ platform: "linux", env: {}, dataDir: tmp() })).toThrow(MissingEncryptionKeyError);
  });
  it("macOS needs no key; Linux with a key is fine", () => {
    expect(() => assertSecretsConfigured("darwin", {})).not.toThrow();
    expect(() => assertSecretsConfigured("linux", { TOKEN_ENCRYPTION_KEY: KEY })).not.toThrow();
  });
});

describe("data directory", () => {
  const base = { home: "/Users/someone", cwd: "/work/project/app" };
  it("defaults to Application Support on macOS", () => {
    expect(resolveDataDir({ ...base, env: {}, platform: "darwin" })).toBe("/Users/someone/Library/Application Support/JevInbox");
  });
  it("other platforms", () => {
    expect(resolveDataDir({ ...base, env: { XDG_DATA_HOME: "/xdg" }, platform: "linux" })).toBe("/xdg/jev-inbox");
    expect(resolveDataDir({ ...base, env: {}, platform: "linux" })).toBe("/Users/someone/.local/share/jev-inbox");
    expect(resolveDataDir({ ...base, env: { APPDATA: "/appdata" }, platform: "win32" })).toBe("/appdata/JevInbox");
  });
  it("JEV_DATA_DIR overrides", () => {
    expect(resolveDataDir({ ...base, env: { JEV_DATA_DIR: "/var/jev" }, platform: "darwin" })).toBe("/var/jev");
    expect(resolveDataDir({ ...base, env: { JEV_DATA_DIR: "data/jev" }, platform: "darwin" })).toBe("/Users/someone/data/jev");
  });
  it("refuses a directory inside the project", () => {
    expect(() => resolveDataDir({ ...base, env: { JEV_DATA_DIR: "/work/project/app/data" }, platform: "darwin" })).toThrow(/outside the project/);
    expect(() => resolveDataDir({ ...base, env: { JEV_DATA_DIR: "/work/project/app" }, platform: "darwin" })).toThrow();
  });
});

describe("on-disk database and category persistence", () => {
  it("creates a private database file and category changes survive a reopen", () => {
    const f = join(tmp(), "nested", "jev.sqlite");
    const db = openDb(f);
    const repo = new CategoryRepo(db);
    const m = new CategoryManager(undefined, repo.load() ?? undefined, (s) => repo.save(s));
    m.add("Side projects");
    m.setEnabled("cat_020", false);
    db.close();
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const db2 = openDb(f);
    const repo2 = new CategoryRepo(db2);
    const m2 = new CategoryManager(undefined, repo2.load() ?? undefined, (s) => repo2.save(s));
    expect(m2.count()).toBe(37);
    expect(m2.get("cat_020")!.enabled).toBe(false);
    expect(m2.list().some((c) => c.name === "Side projects")).toBe(true);
    // the id counter survives, so a deleted id is never reused
    m2.setEnabled("cat_037", false); m2.remove("cat_037");
    const added = m2.add("Another");
    expect(added.ok && added.category!.id).toBe("cat_038");
    db2.close();
  });
});
