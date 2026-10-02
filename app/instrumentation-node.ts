// Node-only startup work (kept separate so the edge runtime never loads it).
import { getRuntime } from "./src/runtime/runtime";
import { assertSecretsConfigured } from "./src/secrets";
import { startBackgroundSync } from "./src/ui/accountActions";

export async function startup(): Promise<void> {
  // Refuse to start if the encrypted-file fallback would be used without its key.
  assertSecretsConfigured(process.platform, process.env);
  // Poll every 5 minutes while the app runs (a no-op until an account is saved).
  startBackgroundSync(await getRuntime());
}
