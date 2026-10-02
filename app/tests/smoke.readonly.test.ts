import { describe, expect, it } from "vitest";
import { ImapAdapter } from "../src/providers/imap/adapter";
import { ReadOnlyTransport, ReadOnlyViolation } from "../src/providers/imap/readonly";
import { FakeImapTransport } from "../src/providers/imap/testing/fakeTransport";
import { cut, runSmoke, SUBJECT_MAX } from "../src/smoke/smoke";

const INTERFACE_METHODS = ["connect", "close", "capabilities", "listFolders", "createFolder", "folderState", "fetchSince", "fetchLatest", "fetchOne", "move", "copy", "setKeyword", "idle"];
const WRITES = ["createFolder", "move", "copy", "setKeyword", "idle"];

const attempt = async (fn: () => unknown) => {
  try { await fn(); } catch (e) { return e; }
  return null;
};

describe("ReadOnlyTransport", () => {
  it("covers every transport method (new methods must be classified read or write)", () => {
    for (const m of INTERFACE_METHODS) expect(typeof (ReadOnlyTransport.prototype as any)[m], m).toBe("function");
  });
  it("every write throws ReadOnlyViolation and reaches nothing", async () => {
    const inner = new FakeImapTransport();
    inner.deliver("INBOX", { from: "a@b.example", subject: "s", body: "b" });
    const ro = new ReadOnlyTransport(inner);
    const before = JSON.stringify(inner.all());
    const calls: Array<() => unknown> = [
      () => ro.createFolder("Jev Auth"),
      () => ro.move("INBOX", 1, "Jev Auth"),
      () => ro.copy("INBOX", 1, "Jev Auth"),
      () => ro.setKeyword("INBOX", 1, "$X", true),
      () => ro.idle("INBOX", () => {}),
    ];
    for (const c of calls) expect(await attempt(c)).toBeInstanceOf(ReadOnlyViolation);
    expect(WRITES.length).toBe(calls.length);
    expect(inner.ops.map((o) => o.op).filter((o) => ["create", "move", "copy", "keyword+", "keyword-", "idle"].includes(o))).toEqual([]);
    expect(JSON.stringify(inner.all())).toBe(before);
    expect(inner.folderPaths()).not.toContain("Jev Auth");
  });
  it("reads pass through", async () => {
    const inner = new FakeImapTransport();
    inner.deliver("INBOX", { from: "a@b.example", subject: "s", body: "b" });
    const ro = new ReadOnlyTransport(inner);
    expect((await ro.listFolders()).length).toBeGreaterThan(0);
    expect((await ro.fetchLatest("INBOX", 5)).length).toBe(1);
    expect((await ro.fetchOne("INBOX", 1))?.subject).toBe("s");
    expect((await ro.capabilities()).move).toBe(true);
  });
  it("an adapter on a read-only transport cannot create folders or move anything", async () => {
    const inner = new FakeImapTransport();
    inner.deliver("INBOX", { from: "a@b.example", subject: "s", body: "b" });
    const adapter = new ImapAdapter({ transport: new ReadOnlyTransport(inner) });
    const [m] = (await adapter.listMessages("INBOX")).messages;
    const r = await adapter.moveToBucket("INBOX", m.id, "needs_review");
    expect(r.moved).toBe(false); // folder creation was refused, so the adapter leaves the mail in place
    expect(inner.messages("INBOX").length).toBe(1);
    expect(inner.folderPaths()).not.toContain("Jev Needs review");
  });
});

describe("runSmoke (dry run)", () => {
  const seed = () => {
    const t = new FakeImapTransport();
    for (let i = 1; i <= 24; i++) t.deliver("INBOX", { from: `Person ${i} <person${i}@mail${i % 3}.example>`, subject: `Hello number ${i}`, body: `private body text ${i}` });
    t.deliver("INBOX", { from: "no-reply@accounts.example", subject: "Your verification code", body: "Your code is 482913" });
    t.deliver("INBOX", { from: "Boss <boss@corp.example>", subject: "x".repeat(100), body: "secret contract details" });
    return t;
  };
  const run = async (t: FakeImapTransport, limit?: number) => {
    const lines: string[] = [];
    const res = await runSmoke({ transport: t, out: (l) => lines.push(l), limit });
    return { lines, res, text: lines.join("\n") };
  };

  it("checks only the 20 newest by default and never writes", async () => {
    const t = seed();
    const { res } = await run(t);
    expect(res.checked).toBe(20);
    expect(t.ops.filter((o) => ["create", "move", "copy", "keyword+", "keyword-", "idle"].includes(o.op))).toEqual([]);
    expect(t.folderPaths().filter((p) => p.startsWith("Jev"))).toEqual([]);
    expect(t.totalMessages()).toBe(26);
  });
  it("prints only From domain and a subject cut to 60 chars: no addresses, names or bodies", async () => {
    const t = seed();
    const { text } = await run(t);
    expect(text).not.toMatch(/person\d+@/);
    expect(text).not.toContain("@");
    expect(text).not.toContain("Boss");
    expect(text).not.toContain("private body text");
    expect(text).not.toContain("secret contract");
    expect(text).not.toContain("482913");
    expect(text).toContain("corp.example");
    expect(text).toContain(`"${"x".repeat(SUBJECT_MAX)}"`);
    expect(text).not.toContain("x".repeat(SUBJECT_MAX + 1));
  });
  it("shows what the gate would do: OTP -> auth, others -> needs_review with the fake jev", async () => {
    const t = seed();
    const { lines } = await run(t);
    expect(lines.find((l) => l.includes("accounts.example"))).toMatch(/auth/);
    expect(lines.find((l) => l.includes("corp.example"))).toMatch(/needs_review/);
    expect(lines.join("\n")).toMatch(/jev\.ai is a FAKE/);
  });
  it("cut() flattens whitespace and truncates", () => {
    expect(cut("a\n\n b")).toBe("a b");
    expect(cut("y".repeat(80)).length).toBe(60);
  });
  it("works on an empty mailbox", async () => {
    const { res } = await run(new FakeImapTransport());
    expect(res.checked).toBe(0);
  });
});
