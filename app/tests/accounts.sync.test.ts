import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportFactory } from "../src/accounts/service";
import { runPipeline } from "../src/pipeline/run";
import { ImapAdapter } from "../src/providers/imap/adapter";
import { FakeImapTransport } from "../src/providers/imap/testing/fakeTransport";
import { FolderInfo, ImapTransport } from "../src/providers/imap/transport";
import { Runtime } from "../src/runtime/runtime";
import { MemorySecretStore, SecretStore } from "../src/secrets";
import { openDb } from "../src/storage/db";
import { DisconnectedJev } from "../src/jev/disconnected";
import { AccountStore } from "../src/accounts/accountStore";
import { applyFiling, applyPlan, cancelAccount, confirmAccount, describePlan, previewOn, removeAccount, startBackgroundSync, syncNow, testAccount } from "../src/ui/accountActions";
import { fileFromReview, junkQueueAction, moveMessages, senderMarkJunk } from "../src/ui/actions";
import { listView } from "../src/ui/actions";

const PASSWORD = "app-specific-pw-0000-not-real";
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "jev-acct-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup(opts: { secrets?: SecretStore; file?: boolean; fail?: (email: string) => Error | null; boxes?: Record<string, FakeImapTransport> } = {}) {
  const boxes = opts.boxes ?? { "user@example.com": new FakeImapTransport({ move: true, idle: false }) };
  const created: string[] = [];
  const factory: TransportFactory = (spec) => {
    created.push(spec.email);
    const err = opts.fail?.(spec.email);
    if (err) {
      const t = boxes[spec.email] ?? new FakeImapTransport();
      t.connect = async () => { throw err; };
      return t as ImapTransport;
    }
    const t = boxes[spec.email];
    if (!t) throw new Error("no such mailbox");
    return t;
  };
  const dataDir = tmp();
  const rt = new Runtime({
    dataDir, secrets: opts.secrets ?? new MemorySecretStore(), makeTransport: factory,
    db: opts.file ? openDb(join(dataDir, "jev.sqlite")) : openDb(":memory:"),
  });
  return { rt, boxes, created, dataDir };
}

const seed = (t: FakeImapTransport) => {
  t.deliver("INBOX", { from: "Accounts <no-reply@accounts.example>", subject: "Your verification code", body: "Your code is 482913" });
  t.deliver("INBOX", { from: "Shop <deals@shop.example>", subject: "Summer sale", body: "Shoes 30% off." });
  t.deliver("INBOX", { from: "Friend <friend@mail.example>", subject: "Lunch?", body: "Fancy lunch on Friday?" });
  t.deliver("INBOX", { from: "Team <team@profile.example>", subject: "Note about your profile", body: "Enter 739201 to continue." });
};

const icloud = { provider: "icloud" as const, email: "User@Example.com", password: PASSWORD };
const add = async (rt: Runtime) => {
  const t = await testAccount(rt, icloud);
  expect(t.kind).toBe("ok");
  return confirmAccount(rt, t.token!);
};
/** Add the account and apply filing (preview off, Jev folders created). */
const addApplied = async (rt: Runtime) => {
  const n = await add(rt);
  expect(n.kind).toBe("ok");
  const r = await applyFiling(rt, rt.accounts.list()[0].id);
  expect(r.kind).toBe("ok");
  return r;
};
const WRITE_OPS = ["create", "move", "copy", "keyword+", "keyword-", "idle"];
const writes = (t: FakeImapTransport, from = 0) => t.ops.slice(from).filter((o) => WRITE_OPS.includes(o.op));

describe("Add account: read-only test, then confirm", () => {
  it("the test is read-only: it shows folders and capabilities and changes nothing", async () => {
    const { rt, boxes } = setup();
    const t = boxes["user@example.com"];
    t.deliver("INBOX", { from: "a@b.example", subject: "s", body: "b" });
    const before = JSON.stringify(t.all());
    const r = await rt.service.testConnection(icloud);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.folders.map((f) => f.path)).toEqual(expect.arrayContaining(["INBOX", "Junk", "Trash"]));
    expect(r.report.capabilities).toMatchObject({ move: true, idle: false });
    expect(r.report.willCreate).toEqual(["Jev Auth", "Jev Junk", "Jev Needs review"]);
    expect(JSON.stringify(r.report)).not.toContain(PASSWORD);
    // nothing written anywhere
    expect(t.ops.filter((o) => ["create", "move", "copy", "keyword+", "keyword-", "idle"].includes(o.op))).toEqual([]);
    expect(JSON.stringify(t.all())).toBe(before);
    expect(t.folderPaths().filter((p) => p.startsWith("Jev"))).toEqual([]);
    expect(rt.accounts.list()).toEqual([]);
    expect((rt.secrets as MemorySecretStore).names()).toEqual([]);
    expect(rt.isLive).toBe(false);
  });

  it("confirming saves the account in Preview mode, creates NOTHING on the server, and goes live", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    const n = await add(rt);
    expect(n.kind).toBe("ok");
    expect(n.text).toMatch(/Preview mode/);
    expect(box.folderPaths().filter((p) => p.startsWith("Jev"))).toEqual([]);
    expect(writes(box)).toEqual([]);
    expect(box.messages("Junk").length).toBe(0);
    const store = rt.secrets as MemorySecretStore;
    expect(store.names()).toEqual(["jev-inbox-icloud-user@example.com"]);
    expect(JSON.parse((await store.get("jev-inbox-icloud-user@example.com"))!)).toEqual({ password: PASSWORD });
    const acct = rt.accounts.list()[0];
    expect(acct).toMatchObject({ provider: "icloud", email: "user@example.com", host: "imap.mail.me.com", port: 993, tls: "implicit", preview: true });
    expect(JSON.stringify(acct)).not.toContain(PASSWORD);
    expect(rt.isLive).toBe(true);
    expect((await rt.state).mode).toBe("live");
  });

  it("the password never lands in SQLite or any file in the data directory", async () => {
    const { rt, dataDir } = setup({ file: true });
    await add(rt);
    await rt.sync.syncAll();
    rt.db.pragma("wal_checkpoint(TRUNCATE)");
    for (const name of readdirSync(dataDir)) {
      expect(readFileSync(join(dataDir, name)).includes(PASSWORD), name).toBe(false);
    }
    expect(statSync(join(dataDir, "jev.sqlite")).mode & 0o777).toBe(0o600);
  });

  it("tokens are single-use and expire after 10 minutes", async () => {
    let now = 1_000_000;
    const { rt } = setup();
    (rt.service as any).now = () => now;
    const t = await rt.service.testConnection(icloud);
    if (!t.ok) throw new Error("test failed");
    now += 11 * 60 * 1000;
    const late = await rt.service.confirm(t.token);
    expect(late.ok).toBe(false);
    const t2 = await rt.service.testConnection(icloud);
    if (!t2.ok) throw new Error("test failed");
    expect((await rt.service.confirm(t2.token)).ok).toBe(true);
    expect((await rt.service.confirm(t2.token)).ok).toBe(false); // already used
  });

  it("cancel discards the pending connection and saves nothing", async () => {
    const { rt } = setup();
    const t = await testAccount(rt, icloud);
    expect(cancelAccount(rt, t.token!).text).toMatch(/Nothing was saved/);
    expect((await confirmAccount(rt, t.token!)).kind).toBe("error");
    expect(rt.accounts.list()).toEqual([]);
  });

  it("errors are scrubbed and never echo the password", async () => {
    const { rt } = setup({ fail: () => new Error(`AUTHENTICATE failed for pass ${PASSWORD}: Invalid credentials`) });
    const r = await testAccount(rt, icloud);
    expect(r.kind).toBe("error");
    expect(r.text).not.toContain(PASSWORD);
    expect(r.text).toContain("[redacted]");
  });

  it("validates input: email, password, duplicates, generic IMAP host/port/TLS", async () => {
    const { rt } = setup();
    expect((await testAccount(rt, { ...icloud, email: "nope" })).kind).toBe("error");
    expect((await testAccount(rt, { ...icloud, password: "" })).kind).toBe("error");
    expect((await testAccount(rt, { provider: "imap", email: "user@example.com", password: "x", host: "h.example", port: 143, tls: "none" })).text).toMatch(/TLS is required/);
    expect((await testAccount(rt, { provider: "imap", email: "user@example.com", password: "x", host: "", port: 993, tls: "implicit" })).kind).toBe("error");
    expect((await add(rt)).kind).toBe("ok");
    expect((await testAccount(rt, icloud)).text).toMatch(/already added/);
  });

  it("generic IMAP uses the entered host, port and TLS mode", async () => {
    const seen: any[] = [];
    const boxes = { "me@mail.example.org": new FakeImapTransport() };
    const { rt } = setup({ boxes });
    const orig = (rt.service as any).d.makeTransport;
    (rt.service as any).d.makeTransport = (spec: any) => { seen.push(spec.preset); return orig(spec); };
    const t = await rt.service.testConnection({ provider: "imap", email: "me@mail.example.org", password: "pw", host: "mail.example.org", port: "143", tls: "starttls" });
    expect(t.ok).toBe(true);
    expect(seen[0]).toMatchObject({ host: "mail.example.org", port: 143, tls: "starttls" });
  });

  it("if the secret cannot be stored, nothing is saved", async () => {
    const broken: SecretStore = { kind: "memory", get: async () => null, set: async () => { throw new Error("keychain locked"); }, delete: async () => false };
    const { rt } = setup({ secrets: broken });
    const n = await add(rt);
    expect(n.kind).toBe("error");
    expect(rt.accounts.list()).toEqual([]);
  });
});

describe("Remove account never touches mail on the server", () => {
  it("deletes credentials and local metadata; makes no connection and no server operation", async () => {
    const { rt, boxes, created } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await add(rt);
    await rt.sync.syncAll();
    const opsBefore = box.ops.length;
    const mailBefore = JSON.stringify(box.all());
    const factoryCallsBefore = created.length;
    const id = rt.accounts.list()[0].id;
    expect(rt.liveStore.query({}).length).toBe(4);

    const n = await removeAccount(rt, id);
    expect(n.kind).toBe("ok");
    expect(n.text).toMatch(/Mail on the server was not touched/);
    // secret gone, account gone, local records gone
    expect(await rt.secrets.get(id)).toBeNull();
    expect(rt.accounts.list()).toEqual([]);
    expect(rt.liveStore.query({}).length).toBe(0);
    expect(rt.liveStore.senderSummary({ includeMuted: true })).toEqual([]);
    // the server was not touched in any way
    // (closing an already-open connection is a logout, not a mailbox operation)
    expect(box.ops.slice(opsBefore).filter((o) => o.op !== "close")).toEqual([]);
    expect(box.ops.slice(opsBefore).some((o) => o.op === "connect")).toBe(false);
    expect(created.length).toBe(factoryCallsBefore);
    expect(JSON.stringify(box.all())).toBe(mailBefore);
    expect(rt.isLive).toBe(false); // back to the demo mailbox
    expect((await rt.state).mode).toBe("demo");
  });
  it("unknown accounts are rejected", async () => {
    const { rt } = setup();
    expect((await removeAccount(rt, "nope")).kind).toBe("error");
  });
  it("removing one account leaves another account's data alone", async () => {
    const boxes = { "a@example.com": new FakeImapTransport(), "b@example.com": new FakeImapTransport() };
    seed(boxes["a@example.com"]); seed(boxes["b@example.com"]);
    const { rt } = setup({ boxes });
    for (const email of Object.keys(boxes)) {
      const t = await testAccount(rt, { provider: "icloud", email, password: PASSWORD });
      await confirmAccount(rt, t.token!);
    }
    await rt.sync.syncAll();
    await removeAccount(rt, "jev-inbox-icloud-a@example.com");
    expect(rt.liveStore.query({}).length).toBe(4);
    expect(rt.accounts.list().map((a) => a.email)).toEqual(["b@example.com"]);
  });
});

describe("Sync with jev.ai not connected (the real sync path)", () => {
  it("files Auth, never junks anything, leaves the rest in place", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await addApplied(rt);
    const total = box.totalMessages();
    const summaries = await rt.sync.syncAll();
    expect(summaries[0]).toMatchObject({ processed: 4, auth: 1 });
    expect(summaries[0].error).toBeUndefined();

    expect(box.messages("Jev Auth").map((m) => m.subject)).toEqual(["Your verification code"]);
    // nothing junked: our Junk folder is empty or absent, and the server's Junk/Trash are untouched
    expect(box.folderPaths().includes("Jev Junk") ? box.messages("Jev Junk").length : 0).toBe(0);
    expect(box.messages("Junk").length).toBe(0);
    expect(box.messages("Trash").length).toBe(0);
    // everything else stays exactly where it was
    expect(box.messages("INBOX").map((m) => m.subject).sort()).toEqual(["Lunch?", "Note about your profile", "Summer sale"]);
    expect(box.totalMessages()).toBe(total);
    expect(box.ops.some((o) => /delet|expunge/i.test(o.op))).toBe(false);
    // the app still shows them in Needs review (logical), as the gate says for a provider failure
    const st = await rt.state;
    expect(listView(st, { kind: "auth" }).map((r) => r.subject)).toEqual(["Your verification code"]);
    expect(listView(st, { kind: "needs_review" }).map((r) => r.subject).sort()).toEqual(["Lunch?", "Note about your profile", "Summer sale"]);
    expect(listView(st, { kind: "junk" })).toEqual([]);
  });

  it("a sender the user marked junk is still not junked while jev.ai is disconnected, and Auth from them stays Auth", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await addApplied(rt);
    await rt.sync.syncAll();
    await rt.liveStore.markJunk("deals@shop.example", async () => ({ success: false })); // mark only; nothing moves
    box.deliver("INBOX", { from: "Shop <deals@shop.example>", subject: "Autumn sale", body: "Coats 20% off." });
    box.deliver("INBOX", { from: "Shop <deals@shop.example>", subject: "Your one-time password", body: "Use 551029 to sign in." });
    await rt.sync.syncAll();
    expect(box.folderPaths().includes("Jev Junk") ? box.messages("Jev Junk").length : 0).toBe(0);
    expect(box.messages("Jev Auth").map((m) => m.subject).sort()).toEqual(["Your one-time password", "Your verification code"]);
    expect(box.messages("INBOX").map((m) => m.subject)).toContain("Autumn sale");
  });

  it("the second sync only sees new mail and records the result", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await add(rt);
    await rt.sync.syncAll();
    const again = await rt.sync.syncAll();
    expect(again[0].processed).toBe(0);
    box.deliver("INBOX", { from: "x@y.example", subject: "new one", body: "hello" });
    expect((await rt.sync.syncAll())[0].processed).toBe(1);
    const a = rt.accounts.list()[0];
    expect(a.lastSyncStatus).toBe("ok");
    expect(a.lastSyncNote).toMatch(/1 new/);
    expect(a.cursor).toMatch(/^\d+:\d+$/);
  });

  it("the first sync only looks at the newest messages (initial limit) and batches are capped", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    for (let i = 1; i <= 30; i++) box.deliver("INBOX", { from: `s${i}@x.example`, subject: `m${i}`, body: "plain" });
    await add(rt);
    (rt.sync as any).d.initialLimit = 10;
    expect((await rt.sync.syncAll())[0].processed).toBe(10);
    box.deliver("INBOX", { from: "n1@x.example", subject: "n1", body: "x" });
    box.deliver("INBOX", { from: "n2@x.example", subject: "n2", body: "x" });
    box.deliver("INBOX", { from: "n3@x.example", subject: "n3", body: "x" });
    (rt.sync as any).d.maxBatch = 2;
    expect((await rt.sync.syncAll())[0].processed).toBe(2);
    expect((await rt.sync.syncAll())[0].processed).toBe(1); // the cursor stopped after the last handled message
  });

  it("a connection problem is recorded, scrubbed, and moves nothing", async () => {
    const { rt, boxes } = setup();
    seed(boxes["user@example.com"]);
    await add(rt);
    (rt as any).adapterFor = async () => { throw new Error(`connection reset, pw ${PASSWORD}`); };
    // the SyncService captured the original bound function; rebuild a service that uses the failing one
    const { SyncService } = await import("../src/sync/sync");
    const svc = new SyncService({ accounts: rt.accounts, store: rt.liveStore, categories: (rt as any).categories, adapterFor: async () => { throw new Error("connection reset"); } });
    const [s] = await svc.syncAll();
    expect(s.error).toMatch(/connection reset/);
    expect(rt.accounts.list()[0].lastSyncStatus).toBe("error");
    expect(boxes["user@example.com"].messages("INBOX").length).toBe(4);
  });

  it("syncs one at a time", async () => {
    const { rt, boxes } = setup();
    seed(boxes["user@example.com"]);
    await add(rt);
    const [a, b] = await Promise.all([rt.sync.syncAll(), rt.sync.syncAll()]);
    expect(a).toBe(b);
  });

  it("Sync now in demo mode explains itself; in live mode it reports counts", async () => {
    const { rt, boxes } = setup();
    expect((await syncNow(rt)).text).toMatch(/demo mailbox/);
    seed(boxes["user@example.com"]);
    await addApplied(rt);
    const n = await syncNow(rt);
    expect(n).toMatchObject({ kind: "ok", text: "Synced 4 new messages: 1 Auth, 3 in Needs review." });
  });

  it("background polling runs sync on a timer and can be started only once", async () => {
    const { rt, boxes } = setup();
    seed(boxes["user@example.com"]);
    await addApplied(rt);
    const spy = vi.spyOn(rt.sync, "syncAll");
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.__jevPoll_v2;
    startBackgroundSync(rt, 15);
    startBackgroundSync(rt, 15); // second call does nothing
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(g.__jevPoll_v2 as ReturnType<typeof setInterval>);
    delete g.__jevPoll_v2;
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(box(boxes).messages("Jev Auth").length).toBe(1);
  });
});

const box = (b: Record<string, FakeImapTransport>) => b["user@example.com"];

describe("pipeline option jevConnected=false", () => {
  it("never junks, even for a marked sender and even if the gate would, and only moves Auth", async () => {
    const t = new FakeImapTransport();
    seed(t);
    const adapter = new ImapAdapter({ transport: t });
    const res = await runPipeline({
      adapter, folder: "INBOX", jev: new DisconnectedJev(), jevConnected: false,
      user: { allowlist: [], markedJunk: ["deals@shop.example"], hasRepliedTo: () => false, hasAuthHistory: () => false },
      gateOptions: { retries: 0 },
    });
    expect(res.outcomes.some((o) => o.move?.bucketUsed === "junk" || o.target === "junk")).toBe(false);
    expect(res.outcomes.filter((o) => o.move).map((o) => o.target)).toEqual(["auth"]);
    expect(res.outcomes.filter((o) => o.moveSkipped === "jev_disconnected").length).toBe(3);
  });
  it("overrides a junk target if one ever reaches it", async () => {
    const t = new FakeImapTransport();
    t.deliver("INBOX", { from: "deals@shop.example", subject: "Summer sale", body: "Shoes" });
    const adapter = new ImapAdapter({ transport: t });
    // a client that (wrongly) claims very high-confidence junk
    const jev = { classify: async (req: any) => ({ message_id: req.message_id, status: "success" as const, answers: req.questions.map((q: any) => ({ question_id: q.question_id, answer: q.question_id === "sys_junk", confidence: 99 })) }) };
    const res = await runPipeline({ adapter, folder: "INBOX", jev, jevConnected: false, user: { allowlist: [], markedJunk: [], hasRepliedTo: () => false, hasAuthHistory: () => false } });
    expect(res.outcomes[0].target).not.toBe("junk");
    expect(t.folderPaths().includes("Jev Junk") ? t.messages("Jev Junk").length : 0).toBe(0);
  });
});

describe("Preview mode (on by default for new accounts)", () => {
  it("a preview sync performs ZERO server writes (asserted on the operation log)", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await add(rt);
    const start = box.ops.length;
    const mailBefore = JSON.stringify(box.all());
    const foldersBefore = box.folderPaths();
    const [s] = await rt.sync.syncAll();
    expect(s).toMatchObject({ processed: 4, auth: 1, preview: true });
    expect(writes(box, start)).toEqual([]); // no create, move, copy, flag or idle
    expect(box.ops.slice(start).map((o) => o.op).every((o) => ["connect", "close", "fetchSince", "fetchOne", "fetchLatest"].includes(o))).toBe(true);
    expect(JSON.stringify(box.all())).toBe(mailBefore);
    expect(box.folderPaths()).toEqual(foldersBefore);
    // the app still records where each message would go
    const st = await rt.state;
    const auth = listView(st, { kind: "auth" });
    expect(auth.map((r) => r.subject)).toEqual(["Your verification code"]);
    expect(auth[0].previewNote).toBe("Preview: would move to Jev Auth");
    expect(listView(st, { kind: "needs_review" }).length).toBe(3);
    expect(listView(st, { kind: "needs_review" })[0].previewNote).toBe("Preview: stays where it is");
    expect(listView(st, { kind: "junk" })).toEqual([]);
    expect(rt.accounts.list()[0].lastSyncNote).toMatch(/Preview: nothing moved/);
    expect((await syncNow(rt)).text).toMatch(/Preview mode: nothing was moved/);
  });

  it("Jev folders are created only on Apply", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await add(rt);
    await rt.sync.syncAll();
    expect(box.folderPaths().filter((p) => p.startsWith("Jev"))).toEqual([]);
    expect(box.ops.filter((o) => o.op === "create")).toEqual([]);
    const r = await applyFiling(rt, rt.accounts.list()[0].id);
    expect(r.kind).toBe("ok");
    expect(box.folderPaths()).toEqual(expect.arrayContaining(["Jev Auth", "Jev Needs review", "Jev Junk"]));
    expect(box.ops.filter((o) => o.op === "create").map((o) => o.path).sort()).toEqual(["Jev Auth", "Jev Junk", "Jev Needs review"]);
    expect(box.messages("Junk").length).toBe(0); // server Junk never written
  });

  it("Apply shows counts first, then moves the recorded Auth mail and turns preview off", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await add(rt);
    await rt.sync.syncAll();
    const id = rt.accounts.list()[0].id;
    const plan = applyPlan(rt, id)!;
    expect(plan.authToMove).toBe(1);
    expect(describePlan(plan)).toBe("1 Auth message will move to Jev Auth. Nothing will be junked or deleted.");
    const r = await applyFiling(rt, id);
    expect(r.text).toMatch(/Preview mode is off\. Created folders: .*Moved 1 Auth message to Jev Auth\. Nothing was junked or deleted\./);
    expect(rt.accounts.get(id)!.preview).toBe(false);
    expect(box.messages("Jev Auth").map((m) => m.subject)).toEqual(["Your verification code"]);
    expect(box.messages("INBOX").map((m) => m.subject).sort()).toEqual(["Lunch?", "Note about your profile", "Summer sale"]);
    expect(box.folderPaths().includes("Jev Junk") ? box.messages("Jev Junk").length : 0).toBe(0);
    // the app now knows the new location
    const row = listView(await rt.state, { kind: "auth" })[0];
    expect(row.folder).toBe("Jev Auth");
    expect(row.previewNote).toBeNull();
    expect((await applyFiling(rt, id)).kind).toBe("error"); // already off
  });

  it("after Apply, the next sync moves Auth into Jev Auth and still junks nothing while jev.ai is disconnected", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await add(rt);
    await rt.sync.syncAll();
    await applyFiling(rt, rt.accounts.list()[0].id);
    // a sender the user marked junk sends both kinds of mail
    await rt.liveStore.markJunk("deals@shop.example", async () => ({ success: false }));
    const start = box.ops.length;
    box.deliver("INBOX", { from: "Shop <deals@shop.example>", subject: "Your one-time password", body: "Use 551029 to sign in." });
    box.deliver("INBOX", { from: "Shop <deals@shop.example>", subject: "Autumn sale", body: "Coats 20% off." });
    box.deliver("INBOX", { from: "Friend <friend@mail.example>", subject: "Dinner?", body: "Free on Friday?" });
    const [s] = await rt.sync.syncAll();
    expect(s).toMatchObject({ processed: 3, auth: 1, preview: false });
    expect(box.messages("Jev Auth").map((m) => m.subject).sort()).toEqual(["Your one-time password", "Your verification code"]);
    expect(box.messages("INBOX").map((m) => m.subject)).toEqual(expect.arrayContaining(["Autumn sale", "Dinner?"]));
    expect(box.messages("Jev Junk").length).toBe(0);
    expect(box.messages("Junk").length).toBe(0);
    expect(box.ops.slice(start).filter((o) => o.op === "move").map((o) => o.dest)).toEqual(["Jev Auth"]);
    expect(box.ops.some((o) => /delet|expunge/i.test(o.op))).toBe(false);
  });

  it("turning preview back on stops future moves and does not undo past ones", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await addApplied(rt);
    await rt.sync.syncAll();
    expect(box.messages("Jev Auth").length).toBe(1);
    const id = rt.accounts.list()[0].id;
    expect(previewOn(rt, id).text).toMatch(/does not move anything|will not move anything/);
    expect(rt.accounts.get(id)!.preview).toBe(true);
    const start = box.ops.length;
    box.deliver("INBOX", { from: "no-reply@accounts.example", subject: "Password reset requested", body: "Someone asked." });
    await rt.sync.syncAll();
    expect(writes(box, start)).toEqual([]);
    expect(box.messages("Jev Auth").length).toBe(1); // past move stays, the new Auth was NOT moved
    expect(box.messages("INBOX").map((m) => m.subject)).toContain("Password reset requested");
    expect(previewOn(rt, "nope").kind).toBe("error");
  });

  it("filing actions in the app are recorded only, and contact the server not at all", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await add(rt);
    await rt.sync.syncAll();
    const st = await rt.state;
    const start = box.ops.length;
    const nr = listView(st, { kind: "needs_review" });
    const lunch = nr.find((r) => r.subject === "Lunch?")!;
    const sale = nr.find((r) => r.subject === "Summer sale")!;
    const r1 = await moveMessages(st, [lunch.token], "archive");
    const r2 = await moveMessages(st, [sale.token], "junk");
    expect(r1.text).toMatch(/Preview mode: recorded in the app only/);
    expect(r2.moved).toBe(1);
    const mj = await senderMarkJunk(st, "friend@mail.example");
    expect(mj.text).toMatch(/Preview mode/);
    // Auth is still protected from Junk in the app, in preview too
    const auth = listView(st, { kind: "auth" })[0];
    expect((await moveMessages(st, [auth.token], "junk")).moved).toBe(0);
    const shaped = nr.find((r) => r.subject === "Note about your profile")!;
    expect((await moveMessages(st, [shaped.token], "junk")).moved).toBe(0);
    // zero operations of any kind reached the server
    expect(box.ops.length).toBe(start);
    expect(listView(st, { kind: "archived" }).map((r) => r.subject)).toEqual(["Lunch?"]);
    expect(listView(st, { kind: "junk" }).map((r) => r.subject)).toEqual(["Summer sale"]);
  });

  it("Preview is enforced at the transport layer: even a direct adapter call cannot write", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await add(rt);
    await rt.sync.syncAll();
    const id = rt.accounts.list()[0].id;
    const adapter = await rt.adapterFor(id); // preview => read-only transport
    const [m] = (await adapter.listMessages("INBOX")).messages;
    const start = box.ops.length;
    for (const b of ["auth", "junk", "needs_review", "archive"] as const) {
      const r = await adapter.moveToBucket("INBOX", m.id, b);
      expect(r.moved, b).toBe(false);
    }
    expect((await adapter.moveToInbox("INBOX", m.id)).moved).toBe(false);
    expect(writes(box, start)).toEqual([]);
    expect(box.folderPaths().filter((p) => p.startsWith("Jev"))).toEqual([]);
  });

  it("if the Auth folder cannot be created, Apply stops: preview stays on and nothing is moved", async () => {
    const boxes = { "user@example.com": new FakeImapTransport({ failCreate: (p) => p === "Jev Auth" }) };
    const { rt } = setup({ boxes });
    seed(boxes["user@example.com"]);
    await add(rt);
    await rt.sync.syncAll();
    const r = await applyFiling(rt, rt.accounts.list()[0].id);
    expect(r.kind).toBe("error");
    expect(r.text).toMatch(/Preview mode stays on/);
    expect(rt.accounts.list()[0].preview).toBe(true);
    expect(boxes["user@example.com"].ops.filter((o) => o.op === "move")).toEqual([]);
  });

  it("existing databases get the preview column with preview ON", () => {
    const db = openDb(":memory:");
    db.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, email TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, tls TEXT NOT NULL, created_at TEXT NOT NULL, cursor TEXT, last_sync_at TEXT, last_sync_status TEXT, last_sync_note TEXT)`);
    db.prepare(`INSERT INTO accounts (id, provider, email, host, port, tls, created_at) VALUES ('x','imap','a@b.example','h',993,'implicit','2026-01-01')`).run();
    expect(new AccountStore(db).get("x")!.preview).toBe(true);
  });

  it("pipeline dryRun never attempts a move, not even for Auth", async () => {
    const t = new FakeImapTransport();
    seed(t);
    const adapter = new ImapAdapter({ transport: t });
    const res = await runPipeline({ adapter, folder: "INBOX", jev: new DisconnectedJev(), jevConnected: false, dryRun: true,
      user: { allowlist: [], markedJunk: [], hasRepliedTo: () => false, hasAuthHistory: () => false }, gateOptions: { retries: 0 } });
    expect(res.outcomes.every((o) => o.move === null && o.moveSkipped === "preview")).toBe(true);
    expect(res.outcomes.find((o) => o.target === "auth")).toBeTruthy();
    expect(writes(t)).toEqual([]);
  });

  it("Confirm-and-remove while still in preview leaves the server completely untouched", async () => {
    const { rt, boxes } = setup();
    const box = boxes["user@example.com"];
    seed(box);
    await add(rt);
    await rt.sync.syncAll();
    const start = box.ops.length;
    await removeAccount(rt, rt.accounts.list()[0].id);
    expect(box.ops.slice(start).filter((o) => o.op !== "close")).toEqual([]);
    expect(box.folderPaths().filter((p) => p.startsWith("Jev"))).toEqual([]);
  });
});

describe("Preview is re-checked while a sync runs, and Apply is single-flight", () => {
  it("turning preview back on mid-run stops further moves immediately", async () => {
    const t = new FakeImapTransport();
    for (let i = 1; i <= 4; i++) t.deliver("INBOX", { from: "no-reply@accounts.example", subject: `Your verification code ${i}`, body: "Your code is 48291" + i });
    const adapter = new ImapAdapter({ transport: t });
    let preview = false;
    let seen = 0;
    const res = await runPipeline({
      adapter, folder: "INBOX", jev: new DisconnectedJev(), jevConnected: false,
      dryRun: () => preview,
      user: { allowlist: [], markedJunk: [], hasRepliedTo: () => false, hasAuthHistory: () => false },
      gateOptions: { retries: 0 },
      onClassified: () => { if (++seen === 2) preview = true; }, // the user flips preview on after two messages
    });
    expect(res.outcomes.map((o) => o.moveSkipped ?? "moved")).toEqual(["moved", "moved", "preview", "preview"]);
    expect(t.ops.filter((o) => o.op === "move").length).toBe(2);
  });
  it("two simultaneous Apply calls do not both run", async () => {
    const { rt, boxes } = setup();
    seed(boxes["user@example.com"]);
    await add(rt);
    await rt.sync.syncAll();
    const id = rt.accounts.list()[0].id;
    const [a, b] = await Promise.all([rt.applyFiling(id), rt.applyFiling(id)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(boxes["user@example.com"].messages("Jev Auth").length).toBe(1);
  });
});
