// Access tokens live in memory only and are refreshed automatically. The refresh token lives in the
// SecretStore (Keychain / encrypted file). Tokens are never logged, and never put in an error message.
import { OAuthClient, ProviderOAuth } from "./config";
import { SecretStore } from "../secrets/store";

export class ReconnectRequiredError extends Error {
  constructor(public readonly provider: string) {
    super(`Reconnect required: ${provider} access was revoked or expired. Connect the account again in Settings.`);
    this.name = "ReconnectRequiredError";
  }
}

export interface TokenSource {
  getAccessToken(): Promise<string>;
  /** Called after a 401: drop the cached token and fetch a fresh one. */
  refresh(): Promise<string>;
}

export type FetchFn = typeof fetch;

const SKEW_MS = 60_000;

export class TokenManager implements TokenSource {
  private access: { token: string; expires: number } | null = null;
  constructor(private readonly o: {
    cfg: ProviderOAuth; client: OAuthClient; secrets: SecretStore; secretName: string;
    fetchFn: FetchFn; now?: () => number;
  }) {}

  private now() { return (this.o.now ?? Date.now)(); }

  async getAccessToken(): Promise<string> {
    if (this.access && this.access.expires - SKEW_MS > this.now()) return this.access.token;
    return this.refresh();
  }

  async refresh(): Promise<string> {
    this.access = null;
    const raw = await this.o.secrets.get(this.o.secretName);
    const refreshToken = raw ? (JSON.parse(raw) as { refreshToken?: string }).refreshToken : undefined;
    if (!refreshToken) throw new ReconnectRequiredError(this.o.cfg.label);
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.o.client.clientId });
    if (this.o.client.clientSecret) body.set("client_secret", this.o.client.clientSecret);
    if (this.o.cfg.provider === "outlook") body.set("scope", this.o.cfg.scope);
    let res: Response;
    try {
      res = await this.o.fetchFn(this.o.cfg.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    } catch {
      throw new Error(`Could not reach ${this.o.cfg.label} to refresh access (network error)`);
    }
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
    if (!res.ok) {
      if (json.error === "invalid_grant" || json.error === "interaction_required" || json.error === "unauthorized_client") throw new ReconnectRequiredError(this.o.cfg.label);
      throw new Error(`${this.o.cfg.label} token refresh failed (${res.status}${json.error ? ` ${json.error}` : ""})`);
    }
    if (!json.access_token) throw new Error(`${this.o.cfg.label} token refresh returned no access token`);
    this.access = { token: json.access_token, expires: this.now() + (json.expires_in ?? 3600) * 1000 };
    // Providers may rotate the refresh token (Microsoft does): keep the newest one.
    if (json.refresh_token && json.refresh_token !== refreshToken) {
      await this.o.secrets.set(this.o.secretName, JSON.stringify({ refreshToken: json.refresh_token }));
    }
    return this.access.token;
  }
}
