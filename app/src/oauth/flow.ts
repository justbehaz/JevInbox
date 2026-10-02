// Authorization-code flow with PKCE, using a loopback redirect to this app's own callback route.
// The code verifier and state wait in server memory (10 minutes, single use).
import { OAuthClient, OAuthProvider, PROVIDERS } from "./config";
import { challengeS256, createVerifier, randomState } from "./pkce";
import { FetchFn } from "./tokens";

const TTL_MS = 10 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface Pending { provider: OAuthProvider; verifier: string; redirectUri: string; reconnectEmail?: string; expires: number }

export interface Tokens { accessToken: string; refreshToken?: string; idToken?: string; expiresIn: number }

export class OAuthFlow {
  private pending = new Map<string, Pending>();
  constructor(private readonly fetchFn: FetchFn, private readonly now: () => number = Date.now) {}

  /** Only loopback hosts may receive the redirect. */
  static redirectUri(host: string, provider: OAuthProvider): string {
    const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
    if (!LOOPBACK_HOSTS.has(hostname)) throw new Error("Connect accounts from http://localhost or http://127.0.0.1 (the sign-in redirect only works on this computer).");
    return `http://${host}/api/oauth/callback/${provider}`;
  }

  start(provider: OAuthProvider, client: OAuthClient, redirectUri: string, reconnectEmail?: string): string {
    this.gc();
    const cfg = PROVIDERS[provider];
    const state = randomState();
    const verifier = createVerifier();
    this.pending.set(state, { provider, verifier, redirectUri, reconnectEmail, expires: this.now() + TTL_MS });
    const q = new URLSearchParams({
      client_id: client.clientId, redirect_uri: redirectUri, response_type: "code", scope: cfg.scope, state,
      code_challenge: challengeS256(verifier), code_challenge_method: "S256", ...cfg.extraAuthParams,
    });
    return `${cfg.authUrl}?${q.toString()}`;
  }

  /** Validates state (single use) and exchanges the code. Errors never contain the code or tokens. */
  async complete(provider: OAuthProvider, client: OAuthClient, state: string, code: string): Promise<{ tokens: Tokens; reconnectEmail?: string }> {
    this.gc();
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.provider !== provider) throw new Error("That sign-in link is invalid or expired. Start again from Settings.");
    const cfg = PROVIDERS[provider];
    const body = new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: p.redirectUri, client_id: client.clientId, code_verifier: p.verifier,
    });
    if (client.clientSecret) body.set("client_secret", client.clientSecret);
    let res: Response;
    try {
      res = await this.fetchFn(cfg.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    } catch {
      throw new Error(`Could not reach ${cfg.label} to finish sign-in (network error).`);
    }
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !j.access_token) throw new Error(`${cfg.label} sign-in failed (${res.status}${j.error ? ` ${j.error}` : ""}).`);
    return { tokens: { accessToken: j.access_token, refreshToken: j.refresh_token, idToken: j.id_token, expiresIn: j.expires_in ?? 3600 }, reconnectEmail: p.reconnectEmail };
  }

  private gc() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);
  }
}

/** Reads the mailbox address from an id_token. Not used for trust, only to label the account. */
export function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as { email?: string; preferred_username?: string };
    return (claims.email ?? claims.preferred_username ?? null)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
