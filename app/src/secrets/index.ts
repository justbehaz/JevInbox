import { join } from "node:path";
import { EncryptedFileSecretStore, MissingEncryptionKeyError } from "./encryptedFile";
import { KeychainSecretStore } from "./keychain";
import { SecretStore } from "./store";
import { SECRETS_FILE } from "../storage/dataDir";

export * from "./store";
export { EncryptedFileSecretStore, MissingEncryptionKeyError } from "./encryptedFile";
export { KeychainSecretStore } from "./keychain";

/** macOS: Keychain. Elsewhere: encrypted file; the key must be set or this throws. */
export function createSecretStore(o: { platform: NodeJS.Platform; env: Record<string, string | undefined>; dataDir: string }): SecretStore {
  if (o.platform === "darwin") return new KeychainSecretStore();
  return new EncryptedFileSecretStore(join(o.dataDir, SECRETS_FILE), o.env.TOKEN_ENCRYPTION_KEY);
}

/** Startup check: refuse to start when the fallback store would be used without its key. */
export function assertSecretsConfigured(platform: NodeJS.Platform, env: Record<string, string | undefined>): void {
  if (platform === "darwin") return;
  const k = env.TOKEN_ENCRYPTION_KEY;
  if (!k || k.length < 16) throw new MissingEncryptionKeyError();
}
