// Connect Gmail / Outlook accounts. The sign-in redirects back to this app's own loopback callback.
// New accounts are saved in PREVIEW mode. Nothing is created in the mailbox here: labels/folders are
// created only when the user applies filing. The refresh token goes to the SecretStore only.
import { AccountProvider, AccountStore, accountIdFor } from "../accounts/accountStore";
import { GmailHttp } from "../providers/gmail/http";
import { SecretStore } from "../secrets/store";
import { missingConfigMessage, OAuthProvider, oauthClient, PROVIDERS } from "./config";
import { emailFromIdToken, OAuthFlow } from "./flow";
import { FetchFn } from "./tokens";

export interface OAuthServiceDeps {
  accounts: AccountStore;
  secrets: SecretStore;
  fetchFn: FetchFn;
  env: Record<string, string | undefined>;
  onChange?: () => void;
  flow?: OAuthFlow;
}

export type Outcome = { ok: boolean; text: string };

const HOSTS: Record<OAuthProvider, string> = { gmail: "gmail.googleapis.com", outlook: "graph.microsoft.com" };

export class OAuthService {
  readonly flow: OAuthFlow;
  constructor(private readonly d: OAuthServiceDeps) {
    this.flow = d.flow ?? new OAuthFlow(d.fetchFn);
  }

  /** Is the client id (and secret, where required) configured? */
  configured(provider: OAuthProvider): { ok: true } | { ok: false; message: string } {
    return oauthClient(provider, this.d.env) ? { ok: true } : { ok: false, message: missingConfigMessage(provider) };
  }

  /** Returns the provider's sign-in URL. Throws a user-readable error if not configured or not on loopback. */
  begin(provider: OAuthProvider, host: string, reconnectEmail?: string): string {
    const client = oauthClient(provider, this.d.env);
    if (!client) throw new Error(missingConfigMessage(provider));
    return this.flow.start(provider, client, OAuthFlow.redirectUri(host, provider), reconnectEmail);
  }

  async complete(provider: OAuthProvider, p: { state?: string | null; code?: string | null; error?: string | null }): Promise<Outcome> {
    const label = PROVIDERS[provider].label;
    if (p.error) return { ok: false, text: `${label} sign-in was cancelled or refused (${p.error.slice(0, 60)}).` };
    const client = oauthClient(provider, this.d.env);
    if (!client) return { ok: false, text: missingConfigMessage(provider) };
    if (!p.state || !p.code) return { ok: false, text: "That sign-in link is incomplete. Start again from Settings." };
    try {
      const { tokens, reconnectEmail } = await this.flow.complete(provider, client, p.state, p.code);
      const email = reconnectEmail ?? (await this.discoverEmail(provider, tokens.accessToken, tokens.idToken));
      if (!email) return { ok: false, text: `Could not tell which ${label} mailbox this is. Check the app's permissions (verify the openid/email scopes) and try again.` };
      const id = accountIdFor(provider, email);
      const existing = this.d.accounts.get(id);
      let refreshToken = tokens.refreshToken;
      if (!refreshToken && existing) {
        const raw = await this.d.secrets.get(id);
        refreshToken = raw ? (JSON.parse(raw) as { refreshToken?: string }).refreshToken : undefined;
      }
      if (!refreshToken) return { ok: false, text: `${label} did not return long-lived access. Remove Jev Inbox from your ${label} account permissions and connect again.` };
      await this.d.secrets.set(id, JSON.stringify({ refreshToken }));
      if (existing) {
        this.d.accounts.recordSync(id, "ok", "Reconnected");
        this.d.onChange?.();
        return { ok: true, text: `${email} reconnected.` };
      }
      this.d.accounts.add({ id, provider: provider as AccountProvider, email, host: HOSTS[provider], port: 443, tls: "implicit" });
      this.d.onChange?.();
      return { ok: true, text: `${email} added in Preview mode. Nothing has been created or moved in your mailbox. Press Sync now to see where each message would go.` };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message.slice(0, 200) : "Sign-in failed." };
    }
  }

  private async discoverEmail(provider: OAuthProvider, accessToken: string, idToken?: string): Promise<string | null> {
    if (provider === "outlook") return emailFromIdToken(idToken);
    // Gmail: the profile endpoint, read-only through the same guarded client the adapter uses.
    const http = new GmailHttp({
      tokens: { getAccessToken: async () => accessToken, refresh: async () => { throw new Error("sign-in token rejected"); } },
      fetchFn: this.d.fetchFn, ctx: { readOnly: true, allowedLabelIds: () => new Set() },
    });
    const p = await http.get<{ emailAddress?: string }>("profile");
    return p.emailAddress?.toLowerCase() ?? null;
  }
}
