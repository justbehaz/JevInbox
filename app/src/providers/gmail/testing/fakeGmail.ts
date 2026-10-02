// In-memory Gmail + Google token endpoint behind a fetch-compatible function. Records every request
// so tests can assert exactly what was (and was not) called. No network.
export interface FakeReq { method: string; url: string; path: string; query: Record<string, string>; body: any; host: string }

interface Msg { id: string; labelIds: string[]; from: string; subject: string; body: string; internalDate: number }

export class FakeGmail {
  requests: FakeReq[] = [];
  email = "user@example.test";
  validAccess = new Set<string>();
  refreshToken = "rt-initial";
  revoked = false; // refresh fails with invalid_grant
  rotateRefresh = false;
  expireAccessAfterUse = false; // next API call returns 401 once
  minHistory = 0;
  historyId = 1000;
  private n = 0;
  private labels = new Map<string, { id: string; name: string }>();
  messages = new Map<string, Msg>();
  private history: Array<{ id: number; msg: string }> = [];
  private tokenN = 0;

  constructor() {
    for (const [id, name] of [["INBOX", "INBOX"], ["SPAM", "SPAM"], ["TRASH", "TRASH"], ["UNREAD", "UNREAD"], ["SENT", "SENT"]]) this.labels.set(id, { id, name });
  }

  deliver(m: { from: string; subject: string; body: string; labels?: string[] }): string {
    const id = `m${++this.n}`.padStart(6, "0");
    const labelIds = m.labels ?? ["INBOX", "UNREAD"];
    this.messages.set(id, { id, labelIds, from: m.from, subject: m.subject, body: m.body, internalDate: 1_700_000_000_000 + this.n * 1000 });
    this.historyId++;
    this.history.push({ id: this.historyId, msg: id });
    return id;
  }
  labelNamed(name: string) { return [...this.labels.values()].find((l) => l.name === name); }
  inLabel(labelId: string) { return [...this.messages.values()].filter((m) => m.labelIds.includes(labelId)); }

  /** Calls to the mailbox API (not the token endpoint). */
  apiRequests() { return this.requests.filter((r) => r.host === "gmail.googleapis.com"); }
  apiWrites() { return this.apiRequests().filter((r) => r.method !== "GET"); }

  private json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const ctype = (init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "";
    let body: any = undefined;
    if (init?.body) body = ctype.includes("json") ? JSON.parse(String(init.body)) : Object.fromEntries(new URLSearchParams(init.body as URLSearchParams));
    const path = url.pathname.replace(/^\/gmail\/v1\/users\/me\//, "");
    const query = Object.fromEntries(url.searchParams);
    this.requests.push({ method, url: url.toString(), path, query, body, host: url.host });

    if (url.host === "oauth2.googleapis.com") return this.token(body);
    if (url.host !== "gmail.googleapis.com") return this.json(404, {});
    const auth = (init?.headers as Record<string, string>)?.authorization ?? "";
    if (this.expireAccessAfterUse) { this.expireAccessAfterUse = false; this.validAccess.clear(); }
    if (!this.validAccess.has(auth.replace(/^Bearer /, ""))) return this.json(401, { error: { status: "UNAUTHENTICATED" } });

    if (method === "GET" && path === "profile") return this.json(200, { emailAddress: this.email, historyId: String(this.historyId) });
    if (method === "GET" && path === "labels") return this.json(200, { labels: [...this.labels.values()] });
    if (method === "POST" && path === "labels") {
      if (this.labelNamed(body.name)) return this.json(409, { error: { status: "ALREADY_EXISTS" } });
      const id = `Label_${this.labels.size + 1}`;
      this.labels.set(id, { id, name: body.name });
      return this.json(200, { id, name: body.name });
    }
    if (method === "GET" && path === "messages") {
      const want = query.labelIds ?? "INBOX";
      const list = [...this.messages.values()].filter((m) => m.labelIds.includes(want)).sort((a, b) => b.internalDate - a.internalDate).slice(0, Number(query.maxResults ?? 100));
      return this.json(200, { messages: list.map((m) => ({ id: m.id })) });
    }
    const one = /^messages\/([^/]+)$/.exec(path);
    if (method === "GET" && one) {
      const m = this.messages.get(one[1]);
      if (!m) return this.json(404, { error: { status: "NOT_FOUND" } });
      const headers = [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "Date", value: new Date(m.internalDate).toUTCString() }];
      const payload = query.format === "full" ? { headers, mimeType: "text/plain", body: { data: Buffer.from(m.body).toString("base64url") } } : { headers };
      return this.json(200, { id: m.id, labelIds: m.labelIds, internalDate: String(m.internalDate), snippet: m.body.slice(0, 60), payload });
    }
    const mod = /^messages\/([^/]+)\/modify$/.exec(path);
    if (method === "POST" && mod) {
      const m = this.messages.get(mod[1]);
      if (!m) return this.json(404, {});
      const add: string[] = body.addLabelIds ?? [];
      const rem: string[] = body.removeLabelIds ?? [];
      m.labelIds = m.labelIds.filter((l) => !rem.includes(l)).concat(add.filter((l) => !m.labelIds.includes(l)));
      return this.json(200, { id: m.id, labelIds: m.labelIds });
    }
    if (method === "GET" && path === "history") {
      if (Number(query.startHistoryId) < this.minHistory) return this.json(404, { error: { status: "NOT_FOUND" } });
      const items = this.history.filter((h) => h.id > Number(query.startHistoryId));
      return this.json(200, {
        history: items.map((h) => ({ id: String(h.id), messagesAdded: [{ message: { id: h.msg, labelIds: this.messages.get(h.msg)?.labelIds ?? [] } }] })),
        historyId: String(this.historyId),
      });
    }
    return this.json(200, {}); // anything else would be a bug: it is recorded, tests assert it never happens
  };

  private token(body: Record<string, string>): Response {
    if (body.grant_type === "refresh_token") {
      if (this.revoked || body.refresh_token !== this.refreshToken) return this.json(400, { error: "invalid_grant" });
      const at = `at-${++this.tokenN}`;
      this.validAccess.add(at);
      const out: Record<string, unknown> = { access_token: at, expires_in: 3600 };
      if (this.rotateRefresh) { this.refreshToken = `rt-rotated-${this.tokenN}`; out.refresh_token = this.refreshToken; }
      return this.json(200, out);
    }
    if (body.grant_type === "authorization_code") {
      if (body.code !== "good-code") return this.json(400, { error: "invalid_grant" });
      const at = `at-${++this.tokenN}`;
      this.validAccess.add(at);
      return this.json(200, { access_token: at, refresh_token: this.refreshToken, expires_in: 3600 });
    }
    return this.json(400, { error: "unsupported_grant_type" });
  }
}
