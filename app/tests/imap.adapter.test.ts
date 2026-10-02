import { describe, expect, it } from "vitest";
import { ImapAdapter, MOVED_KEYWORD, Scheduler } from "../src/providers/imap/adapter";
import { ICLOUD_PRESET, genericPreset } from "../src/providers/imap/presets";
import { FakeImapTransport } from "../src/providers/imap/testing/fakeTransport";
import { MailEvent } from "../src/providers/types";

const mk = (opts = {}, adapterOpts = {}) => {
  const t = new FakeImapTransport(opts);
  const a = new ImapAdapter({ transport: t, ...adapterOpts });
  return { t, a };
};
const mail = (n: number) => ({ from: `s${n}@x.example`, subject: `m${n}`, body: `hello ${n}` });

class ManualScheduler implements Scheduler {
  fns: Array<() => void> = [];
  cleared = 0;
  setInterval(fn: () => void) { this.fns.push(fn); return this.fns.length; }
  clearInterval() { this.cleared++; }
  tick() { this.fns.forEach((f) => f()); }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("presets", () => {
  it("iCloud preset", () => {
    expect(ICLOUD_PRESET).toMatchObject({ host: "imap.mail.me.com", port: 993, tls: "implicit", authHint: "app_password" });
  });
  it("generic preset validates and refuses plaintext", () => {
    expect(genericPreset({ host: "mail.example.org", port: 143, tls: "starttls" }).tls).toBe("starttls");
    expect(() => genericPreset({ host: "", port: 993, tls: "implicit" })).toThrow();
    expect(() => genericPreset({ host: "a b", port: 993, tls: "implicit" })).toThrow();
    expect(() => genericPreset({ host: "h.example", port: 0, tls: "implicit" })).toThrow();
    expect(() => genericPreset({ host: "h.example", port: 70000, tls: "implicit" })).toThrow();
    expect(() => genericPreset({ host: "h.example", port: 143, tls: "none" as never })).toThrow();
  });
});

describe("sync with UIDVALIDITY and UID cursors", () => {
  it("returns only new mail after the cursor", async () => {
    const { t, a } = mk();
    [1, 2, 3].forEach((n) => t.deliver("INBOX", mail(n)));
    const first = await a.listMessages("INBOX");
    expect(first.messages.map((m) => m.subject)).toEqual(["m1", "m2", "m3"]);
    t.deliver("INBOX", mail(4));
    const second = await a.listMessages("INBOX", { cursor: first.cursor });
    expect(second.messages.map((m) => m.subject)).toEqual(["m4"]);
    const third = await a.listMessages("INBOX", { cursor: second.cursor });
    expect(third.messages).toEqual([]);
    expect(third.cursor).toBe(second.cursor);
  });
  it("UIDVALIDITY change forces a full resync and flags it", async () => {
    const { t, a } = mk();
    [1, 2].forEach((n) => t.deliver("INBOX", mail(n)));
    const first = await a.listMessages("INBOX");
    t.bumpUidValidity("INBOX");
    const again = await a.listMessages("INBOX", { cursor: first.cursor });
    expect(again.resync).toBe(true);
    expect(again.messages.length).toBe(2);
  });
  it("stale ids are rejected after UIDVALIDITY change; nothing moves", async () => {
    const { t, a } = mk();
    t.deliver("INBOX", mail(1));
    const [m] = (await a.listMessages("INBOX")).messages;
    t.bumpUidValidity("INBOX");
    const r = await a.moveToBucket("INBOX", m.id, "needs_review");
    expect(r.success).toBe(false);
    expect(t.messages("INBOX").length).toBe(1);
    await expect(a.fetchHeadersAndSnippet("INBOX", m.id)).rejects.toThrow(/stale/);
  });
});

describe("fetch", () => {
  it("snippet is redacted and short; bodySample keeps the original for local checks", async () => {
    const { t, a } = mk();
    t.deliver("INBOX", { from: "a@b.example", subject: "s", body: "Your code is 482913. " + "x".repeat(900) });
    const [m] = (await a.listMessages("INBOX")).messages;
    const d = await a.fetchHeadersAndSnippet("INBOX", m.id);
    expect(d.snippet).not.toContain("482913");
    expect(d.snippet).toContain("[CODE]");
    expect(d.snippet.length).toBeLessThanOrEqual(500);
    expect(d.bodySample).toContain("482913");
  });
});

describe("buckets and folder safety", () => {
  it("creates our own folders and never touches the server Junk or Trash", async () => {
    const { t, a } = mk();
    for (const b of ["auth", "junk", "needs_review"] as const) await a.ensureBucket(b);
    expect(t.folderPaths()).toEqual(expect.arrayContaining(["Jev Auth", "Jev Junk", "Jev Needs review"]));
    expect(t.ops.filter((o) => o.op === "create").map((o) => o.path).sort()).toEqual(["Jev Auth", "Jev Junk", "Jev Needs review"]);
  });
  it("refuses bucket names that are the provider spam/trash folder", () => {
    for (const name of ["Junk", "Spam", "Junk E-mail", "Trash", "[Gmail]/Spam", "Deleted Items"]) {
      expect(() => mk({}, { bucketFolders: { junk: name } }), name).toThrow();
    }
  });
  it("existing bucket folder is reused, not recreated", async () => {
    const { t, a } = mk({ folders: [{ path: "Jev Auth" }] });
    const info = await a.ensureBucket("auth");
    expect(info.created).toBe(false);
    expect(t.ops.some((o) => o.op === "create")).toBe(false);
  });
  it("refuses to read or move out of the provider spam folder by default", async () => {
    const { t, a } = mk();
    t.deliver("Junk", mail(1));
    await expect(a.listMessages("Junk")).rejects.toThrow(/disabled/);
    const r = await a.moveToBucket("Junk", `1000:1`, "needs_review");
    expect(r.success).toBe(false);
    expect(t.messages("Junk").length).toBe(1);
  });
  it("Junk bucket creation failure falls back to Needs review", async () => {
    const { t, a } = mk({ failCreate: (p: string) => p === "Jev Junk" });
    t.deliver("INBOX", mail(1));
    const [m] = (await a.listMessages("INBOX")).messages;
    const r = await a.moveToBucket("INBOX", m.id, "junk");
    expect(r.success).toBe(true);
    expect(r.destination).toBe("Jev Needs review");
    expect(r.bucketUsed).toBe("needs_review");
    expect(t.messages("Junk").length).toBe(0);
  });
  it("if Needs review also fails the mail stays in place (and never goes to provider Junk)", async () => {
    const { t, a } = mk({ failCreate: () => true });
    t.deliver("INBOX", mail(1));
    const [m] = (await a.listMessages("INBOX")).messages;
    for (const b of ["junk", "needs_review", "auth"] as const) {
      const r = await a.moveToBucket("INBOX", m.id, b);
      expect(r).toMatchObject({ success: true, moved: false, method: "none" });
    }
    expect(t.messages("INBOX").length).toBe(1);
    expect(t.messages("Junk").length).toBe(0);
  });
});

describe("moving: never delete, never expunge", () => {
  it("uses MOVE when advertised, is reversible", async () => {
    const { t, a } = mk({ move: true });
    t.deliver("INBOX", mail(1));
    const [m] = (await a.listMessages("INBOX")).messages;
    const r = await a.moveToBucket("INBOX", m.id, "needs_review");
    expect(r).toMatchObject({ success: true, moved: true, method: "move", originalLocation: "INBOX" });
    expect(t.messages("INBOX").length).toBe(0);
    expect(t.messages("Jev Needs review").length).toBe(1);
    await a.undoMove(r);
    expect(t.messages("INBOX").length).toBe(1);
    expect(t.totalMessages()).toBe(1);
  });
  it("without MOVE: COPY plus keyword flag, original kept, no delete flag", async () => {
    const { t, a } = mk({ move: false });
    t.deliver("INBOX", mail(1));
    const [m] = (await a.listMessages("INBOX")).messages;
    const r = await a.moveToBucket("INBOX", m.id, "auth");
    expect(r).toMatchObject({ success: true, moved: true, method: "copy_flag" });
    expect(t.messages("INBOX").length).toBe(1); // original still there
    expect(t.messages("Jev Auth").length).toBe(1);
    expect(t.messages("INBOX")[0].keywords.has(MOVED_KEYWORD)).toBe(true);
    expect(t.ops.some((o) => o.op === "move")).toBe(false);
    await a.undoMove(r);
    expect(t.messages("INBOX")[0].keywords.has(MOVED_KEYWORD)).toBe(false);
    expect(t.totalMessages()).toBe(2); // nothing deleted
  });
  it("the transport rejects the \\Deleted flag outright", async () => {
    const { t } = mk();
    t.deliver("INBOX", mail(1));
    await expect(t.setKeyword("INBOX", 1, "\\Deleted", true)).rejects.toThrow();
    await expect(t.setKeyword("INBOX", 1, "Deleted", true)).rejects.toThrow();
  });
  it("across many operations the op log has no delete/expunge and server Junk stays empty", async () => {
    const { t, a } = mk({ move: false });
    for (let i = 1; i <= 5; i++) t.deliver("INBOX", mail(i));
    const list = await a.listMessages("INBOX");
    for (const m of list.messages) for (const b of ["junk", "needs_review", "auth"] as const) await a.moveToBucket("INBOX", m.id, b);
    expect(t.ops.map((o) => o.op).filter((o) => /delet|expunge/i.test(o))).toEqual([]);
    expect(t.ops.filter((o) => o.dest === "Junk" || o.dest === "Trash" || o.path === "Junk").length).toBe(0);
    expect(t.messages("Junk").length).toBe(0);
  });
});

describe("watch: IDLE with polling fallback", () => {
  it("uses IDLE when advertised and emits new-mail events", async () => {
    const { t, a } = mk({ idle: true });
    t.deliver("INBOX", mail(1));
    const events: MailEvent[] = [];
    const w = await a.watch("INBOX", (e) => events.push(e));
    await w.start();
    expect(w.mode()).toBe("idle");
    t.deliver("INBOX", mail(2));
    await flush();
    expect(events.map((e) => e.messageId)).toEqual(["1000:2"]); // m1 predates the watch
    await w.stop();
    expect(w.isActive()).toBe(false);
    expect(t.idleHandlerCount()).toBe(0);
  });
  it("falls back to polling when IDLE is not advertised", async () => {
    const s = new ManualScheduler();
    const { t, a } = mk({ idle: false }, { scheduler: s, pollIntervalMs: 10 });
    const events: MailEvent[] = [];
    const w = await a.watch("INBOX", (e) => events.push(e));
    await w.start();
    expect(w.mode()).toBe("poll");
    t.deliver("INBOX", mail(1));
    s.tick();
    await flush();
    expect(events.length).toBe(1);
    s.tick();
    await flush();
    expect(events.length).toBe(1); // no duplicates
    await w.stop();
    expect(s.cleared).toBe(1);
  });
  it("falls back to polling when IDLE fails at start", async () => {
    const s = new ManualScheduler();
    const { a } = mk({ idle: true, failIdle: true }, { scheduler: s });
    const w = await a.watch("INBOX", () => {});
    await w.start();
    expect(w.mode()).toBe("poll");
    await w.stop();
  });
});

describe("capabilities", () => {
  it("reports idle, move and auth methods", async () => {
    const { a } = mk({ move: false, idle: true, xoauth2: true });
    expect(await a.capabilities()).toMatchObject({ idleSupport: true, moveSupport: false, authMethods: ["app_password", "xoauth2"] });
  });
});

describe("defence in depth", () => {
  it("a direct moveToBucket(junk) on Auth or security-shaped mail is redirected to Needs review", async () => {
    const { t, a } = mk();
    t.deliver("INBOX", { from: "no-reply@acct.example", subject: "Your verification code", body: "482913" });
    t.deliver("INBOX", { from: "x@y.example", subject: "Note", body: "Enter 739201 to continue." });
    t.deliver("INBOX", { from: "deals@shop.example", subject: "Big sale", body: "shoes" });
    const ms = (await a.listMessages("INBOX")).messages;
    const rs = [];
    for (const m of ms) rs.push(await a.moveToBucket("INBOX", m.id, "junk"));
    expect(rs.map((r) => r.bucketUsed)).toEqual(["needs_review", "needs_review", "junk"]);
    expect(t.messages("Jev Junk").map((m) => m.subject)).toEqual(["Big sale"]);
  });
  it("nested provider spam paths are refused", async () => {
    expect(() => mk({}, { bucketFolders: { junk: "Junk/Jev Junk" } })).toThrow();
    expect(() => mk({}, { bucketFolders: { junk: "INBOX.Spam" } })).toThrow();
  });
});
