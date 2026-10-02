// In-memory Microsoft Graph + Microsoft token endpoint behind a fetch-compatible function.
import type { FakeReq } from "../../gmail/testing/fakeGmail";

interface Msg { id: string; folder: string; from: string; subject: string; body: string; at: number; seq: number }
const ALIASES: Record<string, string> = { inbox: "ID_INBOX", archive: "ID_ARCHIVE", junkemail: "ID_JUNK", deleteditems: "ID_DELETED" };

export class FakeGraph {
  requests: FakeReq[] = [];
  email = "user@example.test";
  validAccess = new Set<string>();
  refreshToken = "rt-initial";
  revoked = false;
  rotateRefresh = true; // Microsoft rotates refresh tokens
  expireDeltaToken = false;
  hasArchive = true;
  private n = 0;
  private seq = 0;
  private tokenN = 0;
  private folders = new Map<string, string>([["ID_INBOX", "Inbox"], ["ID_ARCHIVE", "Archive"], ["ID_JUNK", "Junk Email"], ["ID_DELETED", "Deleted Items"], ["ID_SENT", "Sent Items"]]);
  messages = new Map<string, Msg>();

  deliver(m: { from: string; subject: string; body: string; folder?: string }): string {
    const id = `AAMk${String(++this.n).padStart(4, "0")}`;
    this.messages.set(id, { id, folder: m.folder ?? "ID_INBOX", from: m.from, subject: m.subject, body: m.body, at: 1_700_000_000_000 + this.n * 1000, seq: ++this.seq });
    return id;
  }
  folderNamed(name: string) { return [...this.folders.entries()].find(([, n]) => n === name)?.[0]; }
  inFolder(id: string) { return [...this.messages.values()].filter((m) => m.folder === id); }
  apiRequests() { return this.requests.filter((r) => r.host === "graph.microsoft.com"); }
  apiWrites() { return this.apiRequests().filter((r) => r.method !== "GET"); }

  private json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
  private err(status: number, code: string) { return this.json(status, { error: { code } }); }
  private resolve(idOrAlias: string): string | undefined {
    const id = ALIASES[idOrAlias.toLowerCase()] ?? idOrAlias;
    return this.folders.has(id) ? id : undefined;
  }
  private shape(m: Msg, full = false) {
    const base = {
      id: m.id, subject: m.subject, receivedDateTime: new Date(m.at).toISOString(), isRead: false, parentFolderId: m.folder,
      from: { emailAddress: { name: m.from.split("@")[0], address: m.from },
    } } as Record<string, unknown>;
    if (full) { base.body = { contentType: "text", content: m.body }; base.internetMessageHeaders = [{ name: "Authentication-Results", value: "spf=pass" }]; base.replyTo = []; }
    return base;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const ctype = (init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "";
    let body: any = undefined;
    if (init?.body) body = ctype.includes("json") ? JSON.parse(String(init.body)) : Object.fromEntries(new URLSearchParams(init.body as URLSearchParams));
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0\//, ""));
    const query = Object.fromEntries(url.searchParams);
    this.requests.push({ method, url: url.toString(), path, query, body, host: url.host });

    if (url.host === "login.microsoftonline.com") return this.token(body);
    if (url.host !== "graph.microsoft.com") return this.json(404, {});
    const auth = (init?.headers as Record<string, string>)?.authorization ?? "";
    if (!this.validAccess.has(auth.replace(/^Bearer /, ""))) return this.err(401, "InvalidAuthenticationToken");

    const seg = path.split("/");
    if (method === "GET" && seg[0] === "me" && seg[1] === "mailFolders" && seg.length === 2) {
      return this.json(200, { value: [...this.folders.entries()].map(([id, displayName]) => ({ id, displayName })) });
    }
    if (method === "GET" && seg[0] === "me" && seg[1] === "mailFolders" && seg.length === 3) {
      const id = this.resolve(seg[2]);
      if (!id || (seg[2] === "archive" && !this.hasArchive)) return this.err(404, "ErrorItemNotFound");
      return this.json(200, { id });
    }
    if (method === "POST" && path === "me/mailFolders") {
      if (this.folderNamed(body.displayName)) return this.err(409, "ErrorFolderExists");
      const id = `ID_${this.folders.size + 1}`;
      this.folders.set(id, body.displayName);
      return this.json(201, { id, displayName: body.displayName });
    }
    if (method === "GET" && seg[1] === "mailFolders" && seg[3] === "messages" && seg.length === 4) {
      const f = this.resolve(seg[2]);
      const list = this.inFolder(f ?? "").sort((a, b) => b.at - a.at).slice(0, Number(query.$top ?? 100));
      return this.json(200, { value: list.map((m) => this.shape(m)) });
    }
    if (method === "GET" && seg[1] === "mailFolders" && seg[3] === "messages" && seg[4] === "delta") {
      const tok = query.$deltatoken ?? "";
      if (this.expireDeltaToken && tok !== "latest") return this.err(410, "SyncStateNotFound");
      const link = (n: number) => `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D${n}&$select=${query.$select ?? ""}`;
      if (tok === "latest") return this.json(200, { value: [], "@odata.deltaLink": link(this.seq) });
      const since = Number(tok.replace(/^D/, ""));
      const items = this.inFolder("ID_INBOX").filter((m) => m.seq > since).map((m) => this.shape(m));
      return this.json(200, { value: items, "@odata.deltaLink": link(this.seq) });
    }
    const one = /^me\/messages\/([^/]+)$/.exec(path);
    if (method === "GET" && one) {
      const m = this.messages.get(one[1]);
      return m ? this.json(200, this.shape(m, true)) : this.err(404, "ErrorItemNotFound");
    }
    const mv = /^me\/messages\/([^/]+)\/move$/.exec(path);
    if (method === "POST" && mv) {
      const m = this.messages.get(mv[1]);
      const dest = this.resolve(body.destinationId);
      if (!m || !dest) return this.err(404, "ErrorItemNotFound");
      this.messages.delete(m.id);
      const nid = `AAMk${String(++this.n).padStart(4, "0")}`;
      this.messages.set(nid, { ...m, id: nid, folder: dest });
      return this.json(201, { id: nid });
    }
    return this.json(200, {});
  };

  private token(body: Record<string, string>): Response {
    const mk = (extra: Record<string, unknown> = {}) => {
      const at = `at-${++this.tokenN}`;
      this.validAccess.add(at);
      const idToken = `x.${Buffer.from(JSON.stringify({ email: this.email })).toString("base64url")}.y`;
      return this.json(200, { access_token: at, expires_in: 3600, id_token: idToken, ...extra });
    };
    if (body.grant_type === "refresh_token") {
      if (this.revoked || body.refresh_token !== this.refreshToken) return this.json(400, { error: "invalid_grant" });
      if (this.rotateRefresh) { this.refreshToken = `rt-rotated-${this.tokenN + 1}`; return mk({ refresh_token: this.refreshToken }); }
      return mk();
    }
    if (body.grant_type === "authorization_code") {
      if (body.code !== "good-code") return this.json(400, { error: "invalid_grant" });
      return mk({ refresh_token: this.refreshToken });
    }
    return this.json(400, { error: "unsupported_grant_type" });
  }
}
