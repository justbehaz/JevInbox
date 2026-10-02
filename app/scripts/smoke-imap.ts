// npm run smoke:imap   (reads app/.env.local; see .env.example). READ-ONLY.
import { EnvCredentialsProvider, ImapFlowTransport, presetFromEnv } from "../src/providers/imap";
import { runSmoke } from "../src/smoke/smoke";

async function main() {
  const preset = presetFromEnv(process.env);
  const transport = new ImapFlowTransport({ accountId: "smoke", preset, credentials: new EnvCredentialsProvider(process.env) });
  await runSmoke({ transport, out: (l) => console.log(l) });
}

main().catch((e) => {
  // Error messages from the transport are already scrubbed of credentials.
  console.error(`smoke failed: ${e instanceof Error ? e.message : "unknown error"}`);
  process.exit(1);
});
