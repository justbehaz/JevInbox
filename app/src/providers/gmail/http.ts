// Gmail REST over fetch. Every request passes the guard first. 401 triggers one token refresh.
import { TokenSource, FetchFn } from "../../oauth/tokens";
import { checkGmailRequest, GMAIL_BASE, GuardContext } from "./guard";

export class GmailApiError extends Error {
  constructor(public readonly status: number, public readonly reason: string) {
    super(`Gmail API error ${status}${reason ? ` (${reason})` : ""}`);
    this.name = "GmailApiError";
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface GmailTransportLike {
  get<T = any>(path: string, query?: Query): Promise<T>;
  post<T = any>(path: string, body: unknown, query?: Query): Promise<T>;
}

export class GmailHttp implements GmailTransportLike {
  constructor(private readonly o: { tokens: TokenSource; fetchFn: FetchFn; ctx: GuardContext }) {}

  get<T = any>(path: string, query: Query = {}): Promise<T> { return this.request<T>("GET", path, query); }
  post<T = any>(path: string, body: unknown, query: Query = {}): Promise<T> { return this.request<T>("POST", path, query, body); }

  private async request<T>(method: string, path: string, query: Query, body?: unknown): Promise<T> {
    checkGmailRequest(method, path, query, body, this.o.ctx); // throws before any network call
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const url = `${GMAIL_BASE}${path}${qs.size ? `?${qs.toString()}` : ""}`;
    let token = await this.o.tokens.getAccessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await this.o.fetchFn(url, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch {
        throw new Error("Could not reach Gmail (network error)");
      }
      if (res.status === 401 && attempt === 0) { token = await this.o.tokens.refresh(); continue; }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { errors?: Array<{ reason?: string }>; status?: string } };
        throw new GmailApiError(res.status, j.error?.errors?.[0]?.reason ?? j.error?.status ?? "");
      }
      return (await res.json().catch(() => ({}))) as T;
    }
    throw new GmailApiError(401, "unauthorized");
  }
}
