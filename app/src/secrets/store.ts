// Where account secrets live. Secrets (passwords, tokens) are NEVER written to SQLite, logs or the
// repo: only to the macOS Keychain or to the AES-256-GCM encrypted file.

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  /** Returns true if something was deleted. */
  delete(name: string): Promise<boolean>;
  readonly kind: "memory" | "keychain" | "encrypted-file";
}

/** Entry names follow 06-mail-sources.md: jev-inbox-{provider}-{user-id}. */
export function entryName(provider: string, userId: string): string {
  return `jev-inbox-${provider.toLowerCase()}-${userId.trim().toLowerCase()}`;
}

/** In-memory store: used by tests, never by the app. */
export class MemorySecretStore implements SecretStore {
  readonly kind = "memory" as const;
  private m = new Map<string, string>();
  async get(name: string) { return this.m.get(name) ?? null; }
  async set(name: string, value: string) { this.m.set(name, value); }
  async delete(name: string) { return this.m.delete(name); }
  names(): string[] { return [...this.m.keys()]; }
}
