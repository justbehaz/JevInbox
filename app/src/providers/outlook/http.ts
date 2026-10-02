import { FetchFn, TokenSource } from "../../oauth/tokens";
import { checkGraphRequest, GRAPH_BASE, GQuery, GraphGuardContext } from "./guard";

export class GraphApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(`Microsoft Graph error ${status}${code ? ` (${code})` : ""}`);
    this.name = "GraphApiError";
  }
}

export interface GraphTransportLike {
  get<T = any>(pathOrLink: string, query?: GQuery, headers?: Record<string, string>): Promise<T>;
  post<T = any>(path: string, body: unknown): Promise<T>;
}

export class GraphHttp implements GraphTransportLike {
  constructor(private readonly o: { tokens: TokenSource; fetchFn: FetchFn; ctx: GraphGuardContext }) {}

  /** `pathOrLink` may be an @odata nextLink / deltaLink (absolute URL on the Graph host). */
  get<T = any>(pathOrLink: string, query: GQuery = {}, headers: Record<string, string> = {}): Promise<T> {
    let path = pathOrLink;
    let q = query;
    if (/^https?:/i.test(pathOrLink)) {
      if (!pathOrLink.startsWith(GRAPH_BASE)) throw new Error("refusing a link outside Microsoft Graph");
      const u = new URL(pathOrLink);
      path = decodeURIComponent(u.pathname.replace(/^\/v1\.0\//, ""));
      q = {}; u.searchParams.forEach((v, k) => { q[k] = v; });
    }
    return this.request<T>("GET", path, q, undefined, headers, /^https?:/i.test(pathOrLink) ? pathOrLink : undefined);
  }
  post<T = any>(path: string, body: unknown): Promise<T> { return this.request<T>("POST", path, {}, body, {}); }

  private async request<T>(method: string, path: string, query: GQuery, body: unknown, headers: Record<string, string>, absolute?: string): Promise<T> {
    checkGraphRequest(method, path, query, body, this.o.ctx); // throws before any network call
    let url = absolute;
    if (!url) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
      url = `${GRAPH_BASE}${path}${qs.size ? `?${qs.toString()}` : ""}`;
    }
    let token = await this.o.tokens.getAccessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await this.o.fetchFn(url, {
          method,
          headers: { authorization: `Bearer ${token}`, ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch {
        throw new Error("Could not reach Microsoft Graph (network error)");
      }
      if (res.status === 401 && attempt === 0) { token = await this.o.tokens.refresh(); continue; }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        throw new GraphApiError(res.status, j.error?.code ?? "");
      }
      return (await res.json().catch(() => ({}))) as T;
    }
    throw new GraphApiError(401, "unauthorized");
  }
}
