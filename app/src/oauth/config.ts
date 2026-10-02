// OAuth client settings come from the environment (app/.env.local), never from the repo.
export type OAuthProvider = "gmail" | "outlook";

export interface ProviderOAuth {
  provider: OAuthProvider;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scope: string;
  extraAuthParams: Record<string, string>;
  /** Google needs a client secret even for desktop apps; Microsoft public clients do not. */
  secretRequired: boolean;
  envClientId: string;
  envClientSecret: string;
}

export const PROVIDERS: Record<OAuthProvider, ProviderOAuth> = {
  gmail: {
    provider: "gmail",
    label: "Gmail",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/gmail.modify",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
    secretRequired: true,
    envClientId: "GOOGLE_CLIENT_ID",
    envClientSecret: "GOOGLE_CLIENT_SECRET",
  },
  outlook: {
    provider: "outlook",
    label: "Outlook",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // Mail.ReadWrite + offline_access as requested; openid/email only identify the mailbox (verify).
    scope: "Mail.ReadWrite offline_access openid email",
    extraAuthParams: { response_mode: "query", prompt: "select_account" },
    secretRequired: false,
    envClientId: "MS_CLIENT_ID",
    envClientSecret: "MS_CLIENT_SECRET",
  },
};

export interface OAuthClient { clientId: string; clientSecret?: string }

export function oauthClient(provider: OAuthProvider, env: Record<string, string | undefined>): OAuthClient | null {
  const p = PROVIDERS[provider];
  const clientId = env[p.envClientId]?.trim();
  const clientSecret = env[p.envClientSecret]?.trim() || undefined;
  if (!clientId) return null;
  if (p.secretRequired && !clientSecret) return null;
  return { clientId, clientSecret };
}

export function missingConfigMessage(provider: OAuthProvider): string {
  const p = PROVIDERS[provider];
  const names = p.secretRequired ? `${p.envClientId} and ${p.envClientSecret}` : `${p.envClientId}`;
  return `Add ${names} to app/.env.local — see README`;
}
