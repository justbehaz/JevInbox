// Local development helpers: read IMAP settings from environment variables (see .env.example).
// Values are never logged. Production credentials come from a keychain-backed CredentialsProvider.
import { CredentialsProvider, ImapCredentials } from "./credentials";
import { ICLOUD_PRESET, ImapPreset, TlsMode, genericPreset } from "./presets";

export type Env = Record<string, string | undefined>;

export function presetFromEnv(env: Env): ImapPreset {
  const which = (env.IMAP_PRESET ?? "").trim().toLowerCase();
  if (which === "icloud") return ICLOUD_PRESET;
  if (which === "generic") {
    return genericPreset({
      host: env.IMAP_HOST ?? "",
      port: Number(env.IMAP_PORT),
      tls: (env.IMAP_TLS ?? "") as TlsMode,
    });
  }
  throw new Error('IMAP_PRESET must be "icloud" or "generic"');
}

export class EnvCredentialsProvider implements CredentialsProvider {
  constructor(private readonly env: Env) {}
  async get(): Promise<ImapCredentials> {
    const user = this.env.IMAP_USER?.trim();
    const password = this.env.IMAP_PASSWORD || undefined;
    const accessToken = this.env.IMAP_ACCESS_TOKEN || undefined;
    if (!user || (!password && !accessToken)) throw new Error("IMAP_USER and IMAP_PASSWORD (or IMAP_ACCESS_TOKEN) are required");
    return { user, password, accessToken };
  }
}
