// macOS Keychain via @napi-rs/keyring (talks to the Security framework directly, so secrets never
// appear on a command line the way they would with the `security` CLI).
import { Entry } from "@napi-rs/keyring";
import { SecretStore } from "./store";

export interface KeyringEntry {
  setPassword(p: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
}
export type EntryFactory = (service: string, account: string) => KeyringEntry;

const defaultFactory: EntryFactory = (service, account) => new Entry(service, account);

export class KeychainSecretStore implements SecretStore {
  readonly kind = "keychain" as const;
  constructor(private readonly make: EntryFactory = defaultFactory) {}

  // Keychain service = the entry name from 06 (jev-inbox-{provider}-{user-id}); account = the same.
  private e(name: string): KeyringEntry { return this.make(name, name); }

  async get(name: string): Promise<string | null> { return this.e(name).getPassword(); }
  async set(name: string, value: string): Promise<void> { this.e(name).setPassword(value); }
  async delete(name: string): Promise<boolean> {
    try { return this.e(name).deletePassword(); } catch { return false; }
  }
}
