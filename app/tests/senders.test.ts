import { describe, expect, it } from "vitest";
import { classify } from "../src/gate/gate";
import { runPipeline } from "../src/pipeline/run";
import { ImapAdapter } from "../src/providers/imap/adapter";
import { FakeImapTransport } from "../src/providers/imap/testing/fakeTransport";
import { normalizeSender, rootDomain } from "../src/senders/normalize";
import { JunkMover, RecordInput, SenderStore } from "../src/senders/store";
import { adapterMover, recordOutcome } from "../src/senders/wiring";
import { JevClient, JevRequest, JevResponse } from "../src/jev/types";

const D = (n: number) => new Date(Date.UTC(2026, 8, n));
let seq = 0;
const rec = (store: SenderStore, over: Partial<RecordInput> & { from: string; bucket: RecordInput["bucket"] }) =>
  store.recordMessage({ messageId: `m${++seq}`, folder: "INBOX", subject: "s", snippet: "", date: D(1), unread: true, bodySample: "plain text", ...over });

const okMover = (log: string[] = []): JunkMover => async (m) => { log.push(m.messageId); return { success: true, bucketUsed: "junk" }; };

describe("normalisation", () => {
  it("groups by lowercased address and merges display-name variants", () => {
    const a = normalizeSender('"Apple Support" <Apple-Support@Apple.COM>');
    const b = normalizeSender("apple-support@apple.com");
    expect(a.key).toBe("apple-support@apple.com");
    expect(b.key).toBe(a.key);
    expect(a.displayName).toBe("Apple Support");
  });
  it("plus-tag stripping is optional and off by default", () => {
    expect(normalizeSender("john+promo@x.example").key).toBe("john+promo@x.example");
    expect(normalizeSender("john+promo@x.example", { stripPlusTag: true }).key).toBe("john@x.example");
  });
  it("root domain handles subdomains and two-label suffixes", () => {
    expect(rootDomain("mail.shop.example")).toBe("shop.example");
    expect(rootDomain("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(rootDomain("x.example")).toBe("x.example");
  });
});

describe("queries", () => {
  const seed = () => {
    const s = SenderStore.open();
    rec(s, { from: "Shop <deals@shop.example>", bucket: "category", categoryId: "cat_020", date: D(3), subject: "Sale" });
    rec(s, { from: "deals@shop.example", bucket: "auth", date: D(5), subject: "Your verification code", bodySample: "code 482913", unread: false });
    rec(s, { from: "deals@shop.example", bucket: "needs_review", date: D(4) });
    rec(s, { from: "news@mail.shop.example", bucket: "category", categoryId: "cat_019", date: D(2) });
    rec(s, { from: "friend@other.example", bucket: "category", categoryId: "cat_001", date: D(6) });
    return s;
  };
  it("all mail from a sender, across every bucket, newest first", () => {
    const s = seed();
    const rows = s.messagesFromSender("Deals@Shop.example");
    expect(rows.map((r) => r.bucket)).toEqual(["auth", "needs_review", "category"]);
    expect(s.messagesFromSender("deals@shop.example", { bucket: "auth" }).length).toBe(1);
  });
  it("count and last-seen per sender", () => {
    const s = seed();
    const deals = s.senderSummary().find((x) => x.senderKey === "deals@shop.example")!;
    expect(deals).toMatchObject({ messageCount: 3, unreadCount: 2, auth: 1, needsReview: 1, category: 1, displayName: "Shop" });
    expect(deals.lastSeen).toBe(D(5).toISOString());
    expect(s.senderSummary().map((x) => x.senderKey)).toEqual(["friend@other.example", "deals@shop.example", "news@mail.shop.example"]);
  });
  it("per-sender bucket breakdown", () => {
    const s = seed();
    expect(s.bucketBreakdown("deals@shop.example").map((r) => [r.label, r.count]).sort()).toEqual([["auth", 1], ["cat_020", 1], ["needs_review", 1]]);
  });
  it("domain rollup groups senders under one root domain", () => {
    const s = seed();
    const shop = s.domainRollup().find((d) => d.rootDomain === "shop.example")!;
    expect(shop).toMatchObject({ senderCount: 2, messageCount: 4 });
  });
  it("re-recording a message updates it instead of duplicating", () => {
    const s = SenderStore.open();
    rec(s, { messageId: "same", from: "a@b.example", bucket: "inbox" });
    rec(s, { messageId: "same", from: "a@b.example", bucket: "auth" });
    expect(s.messagesFromSender("a@b.example").length).toBe(1);
    expect(s.messagesFromSender("a@b.example")[0].bucket).toBe("auth");
  });
  it("never stores the original body", () => {
    const s = SenderStore.open();
    rec(s, { from: "a@b.example", bucket: "inbox", bodySample: "TOP-SECRET-BODY 482913", snippet: "[CODE]" });
    const dump = JSON.stringify((s as any).db.prepare("SELECT * FROM messages").all());
    expect(dump).not.toContain("TOP-SECRET-BODY");
    expect(dump).not.toContain("482913");
  });
});

describe("sender actions", () => {
  it("allow and mark-junk are mutually exclusive", async () => {
    const s = SenderStore.open();
    rec(s, { from: "a@b.example", bucket: "category" });
    s.allow("a@b.example");
    expect(s.sender("a@b.example")).toMatchObject({ allowlisted: true, markedJunk: false });
    await s.markJunk("a@b.example", okMover());
    expect(s.sender("a@b.example")).toMatchObject({ allowlisted: false, markedJunk: true });
    s.allow("a@b.example");
    expect(s.sender("a@b.example")).toMatchObject({ allowlisted: true, markedJunk: false });
  });
  it("unknown senders are rejected", async () => {
    const s = SenderStore.open();
    expect(() => s.allow("nobody@x.example")).toThrow();
    await expect(s.markJunk("nobody@x.example", okMover())).rejects.toThrow();
  });
  it("mark-junk moves only non-Auth, non-security-shaped mail, one message at a time", async () => {
    const s = SenderStore.open();
    rec(s, { from: "deals@shop.example", bucket: "auth", subject: "Your verification code", bodySample: "482913" });
    rec(s, { from: "deals@shop.example", bucket: "category", subject: "Sale", categoryId: "cat_020" });
    rec(s, { from: "deals@shop.example", bucket: "needs_review", subject: "More sale" });
    rec(s, { from: "deals@shop.example", bucket: "needs_review", subject: "Odd note", bodySample: "Enter 739201 to continue." }); // security shape
    rec(s, { from: "deals@shop.example", bucket: "category", subject: "Misfiled OTP", bodySample: "Your code is 551029" }); // det auth, wrongly in a category
    rec(s, { from: "deals@shop.example", bucket: "junk", subject: "Old junk" });
    const moved: string[] = [];
    const r = await s.markJunk("deals@shop.example", okMover(moved));
    expect(r).toEqual({ moved: 2, skippedAuth: 2, skippedSecurityShape: 1, failed: 0, alreadyJunk: 1 });
    expect(moved.length).toBe(2);
    const by = Object.fromEntries(s.messagesFromSender("deals@shop.example").map((m) => [m.subject, m.bucket]));
    expect(by).toMatchObject({
      "Your verification code": "auth",
      "Sale": "junk",
      "More sale": "junk",
      "Odd note": "needs_review",
      "Misfiled OTP": "category",
      "Old junk": "junk",
    });
  });
  it("a failed or throwing move leaves the message where it is", async () => {
    const s = SenderStore.open();
    rec(s, { from: "a@b.example", bucket: "category", subject: "one" });
    rec(s, { from: "a@b.example", bucket: "category", subject: "two" });
    let n = 0;
    const r = await s.markJunk("a@b.example", async () => { if (n++ === 0) throw new Error("boom"); return { success: false }; });
    expect(r).toMatchObject({ moved: 0, failed: 2 });
    expect(s.messagesFromSender("a@b.example").map((m) => m.bucket)).toEqual(["category", "category"]);
  });
  it("mover that falls back to Needs review is recorded as such", async () => {
    const s = SenderStore.open();
    rec(s, { from: "a@b.example", bucket: "category" });
    await s.markJunk("a@b.example", async () => ({ success: true, bucketUsed: "needs_review" }));
    expect(s.messagesFromSender("a@b.example")[0].bucket).toBe("needs_review");
  });
  it("unmark leaves existing Junk where it is", async () => {
    const s = SenderStore.open();
    rec(s, { from: "a@b.example", bucket: "category" });
    await s.markJunk("a@b.example", okMover());
    s.unmarkJunk("a@b.example");
    expect(s.sender("a@b.example")!.markedJunk).toBe(false);
    expect(s.messagesFromSender("a@b.example")[0].bucket).toBe("junk");
  });
  it("mute only hides: nothing moves, nothing changes, Auth is never hidden", async () => {
    const s = SenderStore.open();
    rec(s, { from: "deals@shop.example", bucket: "auth", subject: "Your verification code", bodySample: "482913" });
    rec(s, { from: "deals@shop.example", bucket: "category", subject: "Sale" });
    rec(s, { from: "quiet@only.example", bucket: "category", subject: "Hello" });
    const snapshot = () => JSON.stringify((s as any).db.prepare("SELECT message_id, folder, bucket, category_id, prev_bucket, unread FROM messages ORDER BY message_id").all());
    const before = snapshot();
    s.mute("deals@shop.example");
    s.mute("quiet@only.example");
    expect(snapshot()).toBe(before); // no message touched
    // hidden from default lists, except Auth mail
    expect(s.visibleMessages().map((m) => m.subject)).toEqual(["Your verification code"]);
    // muted senders vanish from the default summary unless they have Auth mail
    expect(s.senderSummary().map((x) => x.senderKey)).toEqual(["deals@shop.example"]);
    expect(s.senderSummary({ includeMuted: true }).length).toBe(2);
    // the sender view is the single source of truth: still shows everything
    expect(s.messagesFromSender("deals@shop.example").length).toBe(2);
    s.unmute("deals@shop.example");
    expect(s.visibleMessages().length).toBe(2);
  });
  it("gate inputs reflect the actions, and Auth history covers the root domain", () => {
    const s = SenderStore.open();
    rec(s, { from: "a@shop.example", bucket: "category" });
    rec(s, { from: "b@mail.shop.example", bucket: "auth", subject: "Your verification code", bodySample: "482913" });
    s.allow("a@shop.example");
    const ctx = s.userContext();
    expect(ctx.allowlist).toEqual(["a@shop.example"]);
    expect(ctx.hasAuthHistory("a@shop.example", "shop.example")).toBe(true);
    expect(ctx.hasAuthHistory("x@other.example", "other.example")).toBe(false);
  });
});

// ---- end to end: a sender who sends BOTH Auth and promo mail, marked junk ----
type Script = Record<string, [boolean, number]>;
class SubjectJev implements JevClient {
  constructor(private bySubject: Record<string, Script>) {}
  async classify(req: JevRequest): Promise<JevResponse> {
    const s = this.bySubject[req.fields.subject] ?? {};
    return {
      message_id: req.message_id, status: "success",
      answers: req.questions.map((q) => { const [answer, confidence] = s[q.question_id] ?? [false, 99]; return { question_id: q.question_id, answer, confidence }; }),
    };
  }
}

describe("end to end: sender with Auth and promo mail, then mark-junk", () => {
  it("Auth stays in Auth, promo goes to Junk, future mail follows the same rules", async () => {
    const t = new FakeImapTransport();
    const adapter = new ImapAdapter({ transport: t });
    const store = SenderStore.open();
    const jev = new SubjectJev({
      "Summer sale": { cat_020: [true, 90] },
      "Autumn sale": { cat_020: [true, 90] },
      "Winter sale": { sys_junk: [true, 50], cat_020: [true, 90] },
    });
    const run = async (cursor?: string) =>
      runPipeline({ adapter, folder: "INBOX", jev, user: store.userContext(), cursor, onClassified: (d, o) => recordOutcome(store, d, o) });

    t.deliver("INBOX", { from: "Shop <deals@shop.example>", subject: "Your verification code", body: "Your code is 482913" });
    t.deliver("INBOX", { from: "Shop <deals@shop.example>", subject: "Summer sale", body: "Shoes 30% off" });
    t.deliver("INBOX", { from: "Shop <deals@shop.example>", subject: "Autumn sale", body: "Coats 20% off" });
    const first = await run();
    expect(store.bucketBreakdown("deals@shop.example").map((r) => r.label).sort()).toEqual(["auth", "cat_020"]);
    expect(t.messages("INBOX").map((m) => m.subject).sort()).toEqual(["Autumn sale", "Summer sale"]); // promos stay (category)

    const result = await store.markJunk("deals@shop.example", adapterMover(adapter));
    expect(result).toMatchObject({ moved: 2, skippedAuth: 1, failed: 0 });
    expect(t.messages("Jev Junk").map((m) => m.subject).sort()).toEqual(["Autumn sale", "Summer sale"]);
    expect(t.messages("Jev Auth").map((m) => m.subject)).toEqual(["Your verification code"]);
    expect(t.messages("Junk").length).toBe(0); // server Junk untouched

    // future mail from the marked sender
    t.deliver("INBOX", { from: "Shop <deals@shop.example>", subject: "Your one-time password", body: "Use 551029" });
    t.deliver("INBOX", { from: "Shop <deals@shop.example>", subject: "Winter sale", body: "Boots" });
    const second = await run(first.cursor);
    expect(second.outcomes.length).toBe(2);
    expect(t.messages("Jev Auth").map((m) => m.subject).sort()).toEqual(["Your one-time password", "Your verification code"]);
    expect(t.messages("Jev Junk").map((m) => m.subject).sort()).toEqual(["Autumn sale", "Summer sale", "Winter sale"]);
    expect(t.messages("Jev Junk").some((m) => /code|password/i.test(m.subject))).toBe(false);

    // the sender view still shows everything in one place
    const all = store.messagesFromSender("deals@shop.example");
    expect(all.length).toBe(5);
    expect(all.filter((m) => m.bucket === "auth").length).toBe(2);
    expect(all.filter((m) => m.bucket === "junk").length).toBe(3);
    // nothing deleted anywhere
    expect(t.totalMessages()).toBe(5);
    expect(t.ops.some((o) => /delet|expunge/i.test(o.op))).toBe(false);
  });

  it("mute on the mailbox side: no provider operation happens at all", async () => {
    const t = new FakeImapTransport();
    const adapter = new ImapAdapter({ transport: t });
    const store = SenderStore.open();
    t.deliver("INBOX", { from: "news@letters.example", subject: "Weekly", body: "stories" });
    await runPipeline({ adapter, folder: "INBOX", jev: new SubjectJev({ Weekly: { cat_019: [true, 90] } }), user: store.userContext(), onClassified: (d, o) => recordOutcome(store, d, o) });
    const opsBefore = t.ops.length;
    store.mute("news@letters.example");
    expect(t.ops.length).toBe(opsBefore);
    expect(t.messages("INBOX").length).toBe(1);
  });

  it("classify still gives Auth for a marked sender after the store feeds the gate", async () => {
    const store = SenderStore.open();
    rec(store, { from: "deals@shop.example", bucket: "category" });
    await store.markJunk("deals@shop.example", okMover());
    const res = await classify({ id: "x", from: "deals@shop.example", subject: "Your verification code", body: "482913" }, store.userContext(), { classify: async () => { throw new Error("must not be called"); } });
    expect(res.bucket).toBe("auth");
  });
});

describe("security flags are sticky", () => {
  it("re-recording a message with an empty body cannot clear its Auth or security-shape flags", async () => {
    const s = SenderStore.open();
    rec(s, { messageId: "keep1", from: "a@b.example", bucket: "category", subject: "Odd", bodySample: "Enter 739201 to continue." });
    rec(s, { messageId: "keep2", from: "a@b.example", bucket: "category", subject: "Your verification code", bodySample: "482913" });
    // same messages seen again, but the body fetch failed (empty sample)
    rec(s, { messageId: "keep1", from: "a@b.example", bucket: "category", subject: "Odd", bodySample: "" });
    rec(s, { messageId: "keep2", from: "a@b.example", bucket: "category", subject: "x", bodySample: "" });
    const moved: string[] = [];
    const r = await s.markJunk("a@b.example", okMover(moved));
    expect(moved).toEqual([]);
    expect(r).toMatchObject({ moved: 0, skippedSecurityShape: 1, skippedAuth: 1 });
  });
});
