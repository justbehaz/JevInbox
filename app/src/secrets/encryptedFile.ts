// AES-256-GCM encrypted file, for systems without the macOS Keychain.
// The key comes from TOKEN_ENCRYPTION_KEY (never stored). Each value gets a random IV, and the
// entry name is bound as additional authenticated data, so values cannot be swapped between names.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SecretStore } from "./store";

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super("TOKEN_ENCRYPTION_KEY is missing or too short (use at least 16 characters; 32+ random characters recommended). Set it in app/.env.local.");
    this.name = "MissingEncryptionKeyError";
  }
}

interface FileShape { v: 1; salt: string; entries: Record<string, { iv: string; tag: string; ct: string }> }

export class EncryptedFileSecretStore implements SecretStore {
  readonly kind = "encrypted-file" as const;
  private readonly masterKey: string;

  constructor(private readonly file: string, key: string | undefined) {
    if (!key || key.length < 16) throw new MissingEncryptionKeyError();
    this.masterKey = key;
  }

  private load(): FileShape {
    if (!existsSync(this.file)) return { v: 1, salt: randomBytes(16).toString("hex"), entries: {} };
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as FileShape;
    if (parsed.v !== 1 || !parsed.salt || typeof parsed.entries !== "object") throw new Error("unreadable secrets file");
    return parsed;
  }

  private save(data: FileShape): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  private derive(salt: string): Buffer {
    return scryptSync(this.masterKey, Buffer.from(salt, "hex"), 32);
  }

  async set(name: string, value: string): Promise<void> {
    const data = this.load();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.derive(data.salt), iv);
    c.setAAD(Buffer.from(name));
    const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
    data.entries[name] = { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") };
    this.save(data);
  }

  async get(name: string): Promise<string | null> {
    const data = this.load();
    const e = data.entries[name];
    if (!e) return null;
    try {
      const d = createDecipheriv("aes-256-gcm", this.derive(data.salt), Buffer.from(e.iv, "hex"));
      d.setAAD(Buffer.from(name));
      d.setAuthTag(Buffer.from(e.tag, "hex"));
      return Buffer.concat([d.update(Buffer.from(e.ct, "hex")), d.final()]).toString("utf8");
    } catch {
      throw new Error("could not decrypt the stored secret (wrong TOKEN_ENCRYPTION_KEY or corrupted file)");
    }
  }

  async delete(name: string): Promise<boolean> {
    const data = this.load();
    if (!(name in data.entries)) return false;
    delete data.entries[name];
    this.save(data);
    return true;
  }
}
