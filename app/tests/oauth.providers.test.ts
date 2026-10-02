import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySecretStore } from "../src/secrets";
import { openDb } from "../src/storage/db";
import { Runtime } from "../src/runtime/runtime";
import { FakeGmail } from "../src/providers/gmail/testing/fakeGmail";
import { FakeGraph } from "../src/providers/outlook/testing/fakeGraph";
import { applyFiling, syncNow } from "../src/ui/accountActions";
import { listView, moveMessages, senderMarkJunk } from "../src/ui/actions";
import { challengeS256 } from "../src/oauth/pkce";
import { missingConfigMessage, oauthClient } from "../src/oauth/config";
import { OAuthFlow } from "../src/oauth/flow";
import { checkGmailRequest, GmailGuardError, GmailReadOnlyViolation } from "../src/providers/gmail/guard";
import { checkGraphRequest, GraphGuardError, GraphReadOnlyViolation } from "../src/providers/outlook/guard";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "jev-oauth-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); vi.restoreAllMocks(); });

const ENV = { GOOGLE_CLIENT_ID: "client-id-g", GOOGLE_CLIENT_SECRET: "client-secret-g", MS_CLIENT_ID: "client-id-m" };

interface Harness {
  name: "gmail" | "outlook";
  fake: FakeGmail | FakeGraph;
  rt: Runtime;
  dataDir: string;
}

function make(name: "gmail" | "outlook"): Harness {
  const fake = name === "gmail" ? new FakeGmail() : new FakeGraph();
  const dataDir = tmp();
  const rt = new Runtime({ dataDir, secrets: new MemorySecretStore(), db: openDb(join(dataDir, "jev.sqlite")), fetchFn: fake.fetch, env: ENV });
  return { name, fake, rt, dataDir };
}

const seed = (h: Harness) => {
  const f = h.fake as any;
  f.deliver({ from: "no-reply@accounts.example", subject: "Your verification code", body: "Your code is 482913" });
  f.deliver({ from: "deals@shop.example", subject: "Summer sale", body: "Shoes 30% off." });
  f.deliver({ from: "friend@mail.example", subject: "Lunch?", body: "Fancy lunch on Friday?" });
  f.deliver({ from: "team@profile.example", subject: "Note about your profile", body: "Enter 739201 to continue." });
};

async function connect(h: Harness, reconnectEmail?: string) {
  const url = h.rt.oauth.begin(h.name, "localhost:3000", reconnectEmail);
  const state = new URL(url).searchParams.get("state")!;
  return h.rt.oauth.complete(h.name, { state, code: "good-code" });
}

/** Subjects in a mailbox place, for either provider. */
function subjects(h: Harness, where: "inbox" | "auth" | "needs_review" | "junk" | "spam"): string[] {
  if (h.name === "gmail") {
    const f = h.fake as FakeGmail;
    const id = where === "inbox" ? "INBOX" : where === "spam" ? "SPAM" : f.labelNamed({ auth: "Jev/Auth", needs_review: "Jev/Needs review", junk: "Jev/Junk" }[where])?.id;
    return id ? f.inLabel(id).map((m) => m.subject).sort() : [];
  }
  const f = h.fake as FakeGraph;
  const id = where === "inbox" ? "ID_INBOX" : where === "spam" ? "ID_JUNK" : f.folderNamed({ auth: "Jev Auth", needs_review: "Jev Needs review", junk: "Jev Junk" }[where]);
  return id ? f.inFolder(id).map((m) => m.subject).sort() : [];
}
const writes = (h: Harness) => (h.fake as FakeGmail).apiWrites();
const FORBIDDEN: Record<string, RegExp> = { gmail: /SPAM|TRASH|trash|untrash|delete/i, outlook: /junkemail|deleteditems|ID_JUNK|ID_DELETED|Junk Email|Deleted Items/i };
const OUR_NAMES: Record<string, string[]> = { gmail: ["Jev/Auth", "Jev/Needs review", "Jev/Junk"], outlook: ["Jev Auth", "Jev Needs review", "Jev Junk"] };
const AUTH_NAME: Record<string, string> = { gmail: "Jev/Auth", outlook: "Jev Auth" };

describe.each(["gmail", "outlook"] as const)("%s adapter (mocked HTTP, no network)", (name) => {
  it("connects through the OAuth flow, saves the refresh token only in the secret store, in Preview mode, with no mailbox writes", async () => {
    const h = make(name);
    const o = await connect(h);
    expect(o).toMatchObject({ ok: true });
    expect(o.text).toMatch(/Preview mode/);
    const acct = h.rt.accounts.list()[0];
    expect(acct).toMatchObject({ provider: name, email: "user@example.test", preview: true });
    expect(await h.rt.secrets.get(acct.id)).toBe(JSON.stringify({ refreshToken: "rt-initial" }));
    expect(JSON.stringify(acct)).not.toContain("rt-initial");
    expect(writes(h)).toEqual([]);
  });

  it("a preview sync makes ZERO write calls to the mailbox API", async () => {
    const h = make(name);
    seed(h);
    await connect(h);
    const [s] = await h.rt.sync.syncAll();
    expect(s).toMatchObject({ processed: 4, auth: 1, preview: true });
    expect(s.error).toBeUndefined();
    expect(writes(h)).toEqual([]);                       // no POST, no DELETE, nothing
    expect((h.fake as any).apiRequests().every((r: any) => r.method === "GET")).toBe(true);
    expect(subjects(h, "inbox").length).toBe(4);         // the mailbox is untouched
    const rows = listView(await h.rt.state, { kind: "auth" });
    expect(rows.map((r) => r.subject)).toEqual(["Your verification code"]);
    expect(rows[0].previewNote).toBe("Preview: would move to Jev Auth");
    expect(listView(await h.rt.state, { kind: "junk" })).toEqual([]);
    expect((await syncNow(h.rt)).text).toMatch(/Preview mode: nothing was moved/);
  });

  it("filing actions in the app while in Preview never contact the mailbox", async () => {
    const h = make(name);
    seed(h);
    await connect(h);
    await h.rt.sync.syncAll();
    const st = await h.rt.state;
    const before = (h.fake as any).requests.length;
    const nr = listView(st, { kind: "needs_review" });
    await moveMessages(st, [nr.find((r) => r.subject === "Lunch?")!.token], "archive");
    await moveMessages(st, [nr.find((r) => r.subject === "Summer sale")!.token], "junk");
    await senderMarkJunk(st, "friend@mail.example");
    expect((h.fake as any).requests.length).toBe(before);
  });

  it("Preview is enforced at the HTTP layer: even a direct adapter call cannot write", async () => {
    const h = make(name);
    seed(h);
    await connect(h);
    await h.rt.sync.syncAll();
    const adapter = await h.rt.adapterFor(h.rt.accounts.list()[0].id); // preview => read-only HTTP guard
    const before = (h.fake as any).requests.length;
    const [m] = (await adapter.listMessages("INBOX")).messages;
    for (const b of ["auth", "junk", "needs_review", "archive"] as const) {
      expect((await adapter.ensureBucket(b)).path === null || b === "archive", b).toBe(true);
      expect((await adapter.moveToBucket("INBOX", m.id, b)).moved, b).toBe(false);
    }
    expect((await adapter.moveToInbox("INBOX", m.id)).moved).toBe(false);
    expect(writes(h)).toEqual([]);
    expect((h.fake as any).requests.slice(before).every((r: any) => r.method === "GET")).toBe(true);
  });

  it("Apply creates ONLY our labels/folders, then moves the recorded Auth mail", async () => {
    const h = make(name);
    seed(h);
    await connect(h);
    await h.rt.sync.syncAll();
    expect(writes(h)).toEqual([]);
    const r = await applyFiling(h.rt, h.rt.accounts.list()[0].id);
    expect(r.kind).toBe("ok");
    const creates = writes(h).filter((w) => w.method === "POST" && /^(labels|me\/mailFolders)$/.test(w.path));
    expect(creates.map((w) => w.body.name ?? w.body.displayName).sort()).toEqual([...OUR_NAMES[name]].sort());
    // every write is either one of those creations or a move/modify of a message
    for (const w of writes(h)) expect(/^(labels|me\/mailFolders)$|\/modify$|\/move$/.test(w.path), w.path).toBe(true);
    expect(subjects(h, "auth")).toEqual(["Your verification code"]);
    expect(subjects(h, "inbox")).toEqual(["Lunch?", "Note about your profile", "Summer sale"]);
    expect(h.rt.accounts.list()[0].preview).toBe(false);
  });

  it("after Apply, the next sync moves Auth and still junks nothing (jev.ai disconnected), even for a marked sender", async () => {
    const h = make(name);
    seed(h);
    await connect(h);
    await h.rt.sync.syncAll();
    await applyFiling(h.rt, h.rt.accounts.list()[0].id);
    await h.rt.liveStore.markJunk("deals@shop.example", async () => ({ success: false }));
    const f = h.fake as any;
    f.deliver({ from: "deals@shop.example", subject: "Your one-time password", body: "Use 551029 to sign in." });
    f.deliver({ from: "deals@shop.example", subject: "Autumn sale", body: "Coats 20% off." });
    const [s] = await h.rt.sync.syncAll();
    expect(s).toMatchObject({ processed: 2, auth: 1, preview: false });
    expect(subjects(h, "auth")).toEqual(["Your one-time password", "Your verification code"]);
    expect(subjects(h, "inbox")).toContain("Autumn sale");
    expect(subjects(h, "junk")).toEqual([]);
  });

  it("Auth never goes to Junk: direct adapter call, UI move and mark-junk", async () => {
    const h = make(name);
    seed(h);
    await connect(h);
    await h.rt.sync.syncAll();
    await applyFiling(h.rt, h.rt.accounts.list()[0].id);
    const st = await h.rt.state;
    // a direct call on a security-shaped (not yet Auth) message is redirected, never junked
    const adapter = await h.rt.adapterFor(h.rt.accounts.list()[0].id);
    const shaped = listView(st, { kind: "needs_review" }).find((r) => r.subject === "Note about your profile")!;
    const res = await adapter.moveToBucket(shaped.folder, shaped.messageId, "junk");
    expect(res.bucketUsed).not.toBe("junk");
    expect(subjects(h, "junk")).toEqual([]);
    // the UI refuses Auth and security-shaped mail
    const auth = listView(st, { kind: "auth" })[0];
    expect((await moveMessages(st, [auth.token], "junk")).moved).toBe(0);
    expect((await moveMessages(st, [shaped.token], "junk")).moved).toBe(0);
    // mark sender junk leaves their Auth mail alone
    await senderMarkJunk(st, "no-reply@accounts.example");
    expect(subjects(h, "auth")).toEqual(["Your verification code"]);
    expect(subjects(h, "junk")).toEqual([]);
  });

  it("spam/trash (Gmail) and junkemail/deleteditems (Outlook) are never referenced in a write, and mail there is never touched", async () => {
    const h = make(name);
    seed(h);
    const f = h.fake as any;
    if (name === "gmail") f.deliver({ from: "spammer@bad.example", subject: "Win a prize", body: "click", labels: ["SPAM"] });
    else f.deliver({ from: "spammer@bad.example", subject: "Win a prize", body: "click", folder: "ID_JUNK" });
    await connect(h);
    await h.rt.sync.syncAll();
    const id = h.rt.accounts.list()[0].id;
    await applyFiling(h.rt, id);
    const st = await h.rt.state;
    // everyday operations
    for (const r of listView(st, { kind: "needs_review" })) await moveMessages(st, [r.token], "archive");
    f.deliver({ from: "deals@shop.example", subject: "Autumn sale", body: "Coats 20% off." });
    await h.rt.sync.syncAll();
    // the spam message was never listed, read for filing or moved
    expect(subjects(h, "spam")).toEqual(["Win a prize"]);
    const adapter = await h.rt.adapterFor(id);
    const spamId = name === "gmail" ? [...f.messages.values()].find((m: any) => m.subject === "Win a prize").id : [...f.messages.values()].find((m: any) => m.subject === "Win a prize").id;
    const refused = await adapter.moveToBucket("INBOX", spamId, "needs_review");
    expect(refused.moved).toBe(false);
    expect(refused.success).toBe(false);
    for (const w of writes(h)) {
      expect(w.method).not.toBe("DELETE");
      expect(JSON.stringify([w.path, w.query, w.body]), `${w.method} ${w.path}`).not.toMatch(FORBIDDEN[name]);
    }
  });

  it("refreshes the access token automatically (expiry, a 401 mid-session, and rotated refresh tokens)", async () => {
    const h = make(name);
    seed(h);
    await connect(h);
    const f = h.fake as any;
    const tokenCalls = () => f.requests.filter((r: any) => r.body?.grant_type === "refresh_token").length;
    f.rotateRefresh = true;
    await h.rt.sync.syncAll();
    expect(tokenCalls()).toBe(1);                          // first use: refresh
    await h.rt.sync.syncAll();
    expect(tokenCalls()).toBe(1);                          // cached access token reused
    f.validAccess.clear();                                 // the access token stops working (401)
    const [s] = await h.rt.sync.syncAll();
    expect(s.error).toBeUndefined();
    expect(tokenCalls()).toBe(2);                          // refreshed once, call retried and succeeded
    // a rotated refresh token is saved and used next time
    const saved = JSON.parse((await h.rt.secrets.get(h.rt.accounts.list()[0].id))!).refreshToken;
    expect(saved).toBe(f.refreshToken);
    f.validAccess.clear();
    expect((await h.rt.sync.syncAll())[0].error).toBeUndefined();
  });

  it("an invalid grant becomes a 'reconnect' state, and reconnecting clears it", async () => {
    const h = make(name);
    seed(h);
    await connect(h);
    const f = h.fake as any;
    f.revoked = true;
    const [s] = await h.rt.sync.syncAll();
    expect(s.error).toMatch(/Reconnect required/);
    const a = h.rt.accounts.list()[0];
    expect(a.lastSyncStatus).toBe("reconnect");
    expect(a.lastSyncNote).toMatch(/Reconnect required/);
    expect(writes(h)).toEqual([]);
    // reconnect through the same flow
    f.revoked = false; f.refreshToken = "rt-new"; f.validAccess.clear();
    expect((await connect(h, a.email)).text).toMatch(/reconnected/);
    expect(h.rt.accounts.list().length).toBe(1);
    expect(h.rt.accounts.list()[0].lastSyncStatus).toBe("ok");
    expect((await h.rt.sync.syncAll())[0].error).toBeUndefined();
  });

  it("tokens never appear in logs, the database, error text or the data directory", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const h = make(name);
    seed(h);
    await connect(h);
    await h.rt.sync.syncAll();
    await applyFiling(h.rt, h.rt.accounts.list()[0].id);
    const f = h.fake as any;
    f.revoked = true; f.validAccess.clear();
    const [bad] = await h.rt.sync.syncAll();
    expect(bad.error).not.toMatch(/rt-|at-/);
    h.rt.db.pragma("wal_checkpoint(TRUNCATE)");
    for (const file of readdirSync(h.dataDir)) {
      const bytes = readFileSync(join(h.dataDir, file));
      for (const t of ["rt-initial", "rt-rotated", "at-1", "at-2", "client-secret-g"]) expect(bytes.includes(t), `${file} contains ${t}`).toBe(false);
    }
    expect(JSON.stringify(h.rt.accounts.list())).not.toMatch(/rt-|at-\d/);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("Remove account makes no network call and leaves the mailbox as it is", async () => {
    const h = make(name);
    seed(h);
    await connect(h);
    await h.rt.sync.syncAll();
    const before = (h.fake as any).requests.length;
    expect((await h.rt.service.remove(h.rt.accounts.list()[0].id)).ok).toBe(true);
    expect((h.fake as any).requests.length).toBe(before);
    expect(h.rt.accounts.list()).toEqual([]);
  });
});

describe("Gmail specifics", () => {
  it("uses history.list after the first sync and falls back to a full resync on 404", async () => {
    const h = make("gmail");
    const f = h.fake as FakeGmail;
    seed(h);
    await connect(h);
    await h.rt.sync.syncAll();
    f.deliver({ from: "new@one.example", subject: "second", body: "hi" });
    f.requests.length = 0;
    expect((await h.rt.sync.syncAll())[0].processed).toBe(1);
    expect(f.requests.some((r) => r.path === "history")).toBe(true);
    // history too old
    f.deliver({ from: "new@two.example", subject: "third", body: "hi" });
    f.minHistory = 1e9;
    f.requests.length = 0;
    const [s] = await h.rt.sync.syncAll();
    expect(f.requests.some((r) => r.path === "history")).toBe(true);
    expect(f.requests.some((r) => r.path === "messages")).toBe(true); // full resync listing
    expect(s.error).toBeUndefined();
    expect(h.rt.liveStore.query({}).map((m) => m.subject)).toContain("third");
  });
});

describe("Outlook specifics", () => {
  it("uses delta queries after the first sync and falls back to a full resync on 410", async () => {
    const h = make("outlook");
    const f = h.fake as FakeGraph;
    seed(h);
    await connect(h);
    await h.rt.sync.syncAll();
    f.deliver({ from: "new@one.example", subject: "second", body: "hi" });
    f.requests.length = 0;
    expect((await h.rt.sync.syncAll())[0].processed).toBe(1);
    expect(f.requests.some((r) => r.path.endsWith("messages/delta"))).toBe(true);
    f.deliver({ from: "new@two.example", subject: "third", body: "hi" });
    f.expireDeltaToken = true;
    const [s] = await h.rt.sync.syncAll();
    expect(s.error).toBeUndefined();
    expect(h.rt.liveStore.query({}).map((m) => m.subject)).toContain("third");
  });
  it("only discovers the Junk Email and Deleted Items ids by read-only GET with $select=id", async () => {
    const h = make("outlook");
    const f = h.fake as FakeGraph;
    seed(h);
    await connect(h);
    await h.rt.sync.syncAll();
    const touching = f.apiRequests().filter((r) => /junkemail|deleteditems/i.test(r.path));
    expect(touching.length).toBe(2);
    for (const r of touching) { expect(r.method).toBe("GET"); expect(r.query.$select).toBe("id"); }
  });
});

describe("Outlook fails closed when it cannot learn the Junk / Deleted Items ids", () => {
  it("a failed discovery stops the connection instead of continuing with an empty forbidden set", async () => {
    const h = make("outlook");
    const f = h.fake as FakeGraph;
    seed(h);
    await connect(h);
    const real = f.fetch;
    (h.rt as any).fetchFn = undefined;
    f.fetch = (async (input: any, init: any) => {
      const u = String(input);
      if (/mailFolders\/junkemail/.test(u)) return new Response("{}", { status: 500 });
      return real(input, init);
    }) as typeof fetch;
    // rebuild a runtime that uses the failing fetch
    const rt2 = new Runtime({ dataDir: tmp(), secrets: h.rt.secrets, db: openDb(":memory:"), fetchFn: f.fetch, env: ENV });
    const h2: Harness = { name: "outlook", fake: f, rt: rt2, dataDir: "" };
    f.revoked = false;
    const o = await connect(h2);
    expect(o.ok).toBe(true);
    const [s] = await rt2.sync.syncAll();
    expect(s.error).toMatch(/Microsoft Graph error 500/);
    expect(f.apiWrites()).toEqual([]);
  });
});

describe("request guards", () => {
  const ctx = (readOnly = false) => ({ readOnly, allowedLabelIds: () => new Set(["Label_9"]) });
  it("Gmail: allows our reads and our label changes", () => {
    expect(() => checkGmailRequest("GET", "messages", { labelIds: "INBOX" }, undefined, ctx())).not.toThrow();
    expect(() => checkGmailRequest("POST", "labels", {}, { name: "Jev/Auth" }, ctx())).not.toThrow();
    expect(() => checkGmailRequest("POST", "messages/abc/modify", {}, { addLabelIds: ["Label_9"], removeLabelIds: ["INBOX"] }, ctx())).not.toThrow();
  });
  it("Gmail: refuses DELETE, trash, untrash, send, SPAM/TRASH labels, foreign labels and other label creation", () => {
    const bad: Array<[string, string, any, any]> = [
      ["DELETE", "messages/abc", {}, undefined],
      ["POST", "messages/abc/trash", {}, {}],
      ["POST", "messages/abc/untrash", {}, {}],
      ["POST", "messages/batchDelete", {}, { ids: ["a"] }],
      ["POST", "messages/send", {}, {}],
      ["GET", "messages", { labelIds: "SPAM" }, undefined],
      ["GET", "messages", { includeSpamTrash: "true" }, undefined],
      ["POST", "messages/abc/modify", {}, { addLabelIds: ["SPAM"] }],
      ["POST", "messages/abc/modify", {}, { removeLabelIds: ["TRASH"] }],
      ["POST", "messages/abc/modify", {}, { addLabelIds: ["Label_1"] }],
      ["POST", "messages/batchModify", {}, { ids: ["a"], addLabelIds: ["trash"] }],
      ["POST", "labels", {}, { name: "Work" }],
      ["GET", "/messages", {}, undefined],
      ["GET", "../settings", {}, undefined],
    ];
    for (const [m, p, q, b] of bad) expect(() => checkGmailRequest(m, p, q, b, ctx()), `${m} ${p}`).toThrow(GmailGuardError);
  });
  it("Gmail: read-only (Preview) refuses every POST", () => {
    expect(() => checkGmailRequest("POST", "labels", {}, { name: "Jev/Auth" }, ctx(true))).toThrow(GmailReadOnlyViolation);
    expect(() => checkGmailRequest("POST", "messages/abc/modify", {}, { addLabelIds: ["Label_9"] }, ctx(true))).toThrow(GmailReadOnlyViolation);
    expect(() => checkGmailRequest("POST", "messages/batchModify", {}, { ids: ["a"], addLabelIds: ["Label_9"] }, ctx(true))).toThrow(GmailReadOnlyViolation);
    expect(() => checkGmailRequest("GET", "profile", {}, undefined, ctx(true))).not.toThrow();
  });
  const gctx = (readOnly = false) => ({ readOnly, ourFolderIds: () => new Set(["ID_OURS"]), forbiddenFolderIds: () => new Set(["ID_JUNK", "ID_DELETED"]) });
  it("Graph: allows our reads, our folder creation and moves to our folders, inbox and archive", () => {
    expect(() => checkGraphRequest("GET", "me/mailFolders/inbox/messages", { $top: 5 }, undefined, gctx())).not.toThrow();
    expect(() => checkGraphRequest("POST", "me/mailFolders", {}, { displayName: "Jev Auth" }, gctx())).not.toThrow();
    for (const d of ["ID_OURS", "inbox", "archive"]) expect(() => checkGraphRequest("POST", "me/messages/m1/move", {}, { destinationId: d }, gctx())).not.toThrow();
    expect(() => checkGraphRequest("GET", "me/mailFolders/junkemail", { $select: "id" }, undefined, gctx())).not.toThrow(); // discovery only
  });
  it("Graph: refuses DELETE, junkemail/deleteditems (alias or id), foreign destinations and other folder creation", () => {
    const bad: Array<[string, string, any, any]> = [
      ["DELETE", "me/messages/m1", {}, undefined],
      ["DELETE", "me/mailFolders/ID_OURS", {}, undefined],
      ["GET", "me/mailFolders/junkemail/messages", {}, undefined],
      ["GET", "me/mailFolders/junkemail", {}, undefined],                  // discovery needs $select=id
      ["GET", "me/mailFolders/deleteditems/messages", {}, undefined],
      ["GET", "me/mailFolders/ID_JUNK/messages", {}, undefined],
      ["POST", "me/messages/m1/move", {}, { destinationId: "junkemail" }],
      ["POST", "me/messages/m1/move", {}, { destinationId: "deleteditems" }],
      ["POST", "me/messages/m1/move", {}, { destinationId: "ID_JUNK" }],
      ["POST", "me/messages/m1/move", {}, { destinationId: "ID_SOMEWHERE" }],
      ["POST", "me/mailFolders", {}, { displayName: "Work" }],
      ["POST", "me/messages/m1/copy", {}, { destinationId: "inbox" }],
      ["POST", "me/sendMail", {}, {}],
      ["PATCH", "me/messages/m1", {}, { isRead: true }],
    ];
    for (const [m, p, q, b] of bad) expect(() => checkGraphRequest(m, p, q, b, gctx()), `${m} ${p}`).toThrow(GraphGuardError);
  });
  it("Graph: read-only (Preview) refuses every POST", () => {
    expect(() => checkGraphRequest("POST", "me/mailFolders", {}, { displayName: "Jev Auth" }, gctx(true))).toThrow(GraphReadOnlyViolation);
    expect(() => checkGraphRequest("POST", "me/messages/m1/move", {}, { destinationId: "ID_OURS" }, gctx(true))).toThrow(GraphReadOnlyViolation);
    expect(() => checkGraphRequest("GET", "me/messages/m1", { $select: "id" }, undefined, gctx(true))).not.toThrow();
  });
});

describe("OAuth (PKCE, loopback)", () => {
  it("builds a PKCE S256 URL with state and the right scopes, and sends the matching verifier", async () => {
    const h = make("gmail");
    const url = new URL(h.rt.oauth.begin("gmail", "localhost:3200"));
    const q = url.searchParams;
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(q.get("redirect_uri")).toBe("http://localhost:3200/api/oauth/callback/gmail");
    expect(q.get("client_id")).toBe("client-id-g");
    expect(q.get("access_type")).toBe("offline");
    await h.rt.oauth.complete("gmail", { state: q.get("state")!, code: "good-code" });
    const exchange = (h.fake as FakeGmail).requests.find((r) => r.body?.grant_type === "authorization_code")!;
    expect(challengeS256(exchange.body.code_verifier)).toBe(q.get("code_challenge"));
    expect(exchange.body.redirect_uri).toBe("http://localhost:3200/api/oauth/callback/gmail");
    expect(exchange.body.client_secret).toBe("client-secret-g");
  });
  it("Outlook asks for Mail.ReadWrite and offline_access and works without a client secret", async () => {
    const h = make("outlook");
    const url = new URL(h.rt.oauth.begin("outlook", "127.0.0.1:3000"));
    expect(url.searchParams.get("scope")).toMatch(/Mail\.ReadWrite/);
    expect(url.searchParams.get("scope")).toMatch(/offline_access/);
    await h.rt.oauth.complete("outlook", { state: url.searchParams.get("state")!, code: "good-code" });
    const exchange = (h.fake as FakeGraph).requests.find((r) => r.body?.grant_type === "authorization_code")!;
    expect(exchange.body.client_secret).toBeUndefined();
    expect(exchange.body.code_verifier).toBeTruthy();
  });
  it("state is single-use and bad states are refused", async () => {
    const h = make("gmail");
    const state = new URL(h.rt.oauth.begin("gmail", "localhost:3000")).searchParams.get("state")!;
    expect((await h.rt.oauth.complete("gmail", { state, code: "good-code" })).ok).toBe(true);
    expect((await h.rt.oauth.complete("gmail", { state, code: "good-code" })).ok).toBe(false); // replay
    expect((await h.rt.oauth.complete("gmail", { state: "forged", code: "good-code" })).ok).toBe(false);
    expect((await h.rt.oauth.complete("gmail", { error: "access_denied" })).text).toMatch(/cancelled or refused/);
  });
  it("only loopback hosts may receive the redirect", () => {
    const h = make("gmail");
    expect(() => h.rt.oauth.begin("gmail", "evil.example.com")).toThrow(/localhost/);
    expect(() => OAuthFlow.redirectUri("localhost.evil.com:3000", "gmail")).toThrow();
    expect(OAuthFlow.redirectUri("[::1]:3000", "gmail")).toBe("http://[::1]:3000/api/oauth/callback/gmail");
  });
  it("missing client ids give the clear message instead of a button", () => {
    expect(missingConfigMessage("gmail")).toBe("Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to app/.env.local — see README");
    expect(missingConfigMessage("outlook")).toBe("Add MS_CLIENT_ID to app/.env.local — see README");
    expect(oauthClient("gmail", {})).toBeNull();
    expect(oauthClient("gmail", { GOOGLE_CLIENT_ID: "x" })).toBeNull(); // Google needs the secret too
    expect(oauthClient("outlook", { MS_CLIENT_ID: "x" })).toEqual({ clientId: "x", clientSecret: undefined });
    expect(oauthClient("outlook", { MS_CLIENT_ID: "x", MS_CLIENT_SECRET: "s" })?.clientSecret).toBe("s");
    const dataDir = tmp();
    const rt = new Runtime({ dataDir, secrets: new MemorySecretStore(), db: openDb(":memory:"), fetchFn: new FakeGmail().fetch, env: {} });
    expect(() => rt.oauth.begin("gmail", "localhost:3000")).toThrow(/GOOGLE_CLIENT_ID/);
    expect(rt.oauth.configured("outlook")).toEqual({ ok: false, message: "Add MS_CLIENT_ID to app/.env.local — see README" });
  });
});
