import { describe, expect, it } from "vitest";
import { runPipeline } from "../src/pipeline/run";
import { ImapAdapter } from "../src/providers/imap/adapter";
import { FakeImapTransport } from "../src/providers/imap/testing/fakeTransport";
import { JevClient, JevRequest, JevResponse, JevTimeoutError } from "../src/jev/types";
import { ctx } from "./fixtures";

// Routes by subject so each mailbox message gets its own scripted jev.ai behaviour.
type Script = { answers: Record<string, [boolean, number]> } | "timeout";
class RoutingJev implements JevClient {
  calls: JevRequest[] = [];
  constructor(private bySubject: Record<string, Script>) {}
  async classify(req: JevRequest): Promise<JevResponse> {
    this.calls.push(req);
    const s = this.bySubject[req.fields.subject] ?? { answers: {} };
    if (s === "timeout") throw new JevTimeoutError();
    return {
      message_id: req.message_id,
      status: "success",
      answers: req.questions.map((q) => {
        const [answer, confidence] = s.answers[q.question_id] ?? [false, 99];
        return { question_id: q.question_id, answer, confidence };
      }),
    };
  }
}

const Y = true, N = false;

function seed(t: FakeImapTransport) {
  // 1 deterministic Auth (OTP)
  t.deliver("INBOX", { from: "no-reply@accounts.example", subject: "Your verification code", body: "Your code is 482913" });
  // 2 Auth from a sender the user marked junk: must still be Auth
  t.deliver("INBOX", { from: "deals@shop.example", subject: "Your one-time password", body: "Use 551029 to sign in" });
  // 3 promo from the same marked sender: Junk
  t.deliver("INBOX", { from: "deals@shop.example", subject: "Big summer sale", body: "Save on shoes." });
  // 4 jev.ai times out: Needs review
  t.deliver("INBOX", { from: "help@service.example", subject: "Finish signing up", body: "Tap the button to finish." });
  // 5 ordinary mail filed to a category: stays in INBOX
  t.deliver("INBOX", { from: "friend@mail.example", subject: "Weekend plans", body: "See you Saturday" });
  // 6 security-shaped, no Auth flag, high junk confidence: Needs review, never Junk
  t.deliver("INBOX", { from: "team@profile.example", subject: "Note about your profile", body: "Enter 739201 to continue." });
}

const jevScripts: Record<string, Script> = {
  "Big summer sale": { answers: { sys_auth: [N, 95], sys_junk: [Y, 92] } },
  "Finish signing up": "timeout",
  "Weekend plans": { answers: { sys_auth: [N, 95], sys_junk: [N, 95], cat_001: [Y, 85] } },
  "Note about your profile": { answers: { sys_auth: [N, 95], sys_junk: [Y, 99] } },
};

const user = () => ctx({ markedJunk: ["deals@shop.example"] });
const subjectsIn = (t: FakeImapTransport, path: string) => t.messages(path).map((m) => m.subject).sort();

describe("fake mailbox -> fetch -> redact -> gate -> move", () => {
  it("files every message to the right folder with MOVE, never Junk for Auth, never deletes", async () => {
    const t = new FakeImapTransport({ move: true });
    seed(t);
    const before = t.totalMessages();
    const adapter = new ImapAdapter({ transport: t });
    const jev = new RoutingJev(jevScripts);
    const authSeen: string[] = [];

    const res = await runPipeline({ adapter, folder: "INBOX", jev, user: user(), recordAuth: (a) => authSeen.push(a) });

    expect(subjectsIn(t, "Jev Auth")).toEqual(["Your one-time password", "Your verification code"]);
    expect(subjectsIn(t, "Jev Junk")).toEqual(["Big summer sale"]);
    expect(subjectsIn(t, "Jev Needs review")).toEqual(["Finish signing up", "Note about your profile"]);
    expect(subjectsIn(t, "INBOX")).toEqual(["Weekend plans"]);

    // Auth never in Junk, and the provider's own Junk/Trash were never written
    expect(subjectsIn(t, "Jev Junk").some((s) => /code|password/i.test(s))).toBe(false);
    expect(t.messages("Junk").length).toBe(0);
    expect(t.messages("Trash").length).toBe(0);

    // nothing deleted: same message count, no delete/expunge operation exists in the log
    expect(t.totalMessages()).toBe(before);
    expect(t.ops.some((o) => /delet|expunge/i.test(o.op))).toBe(false);
    expect(t.ops.filter((o) => o.dest === "Junk" || o.dest === "Trash").length).toBe(0);

    // timeout -> Needs review (not Junk), after bounded retries
    const timeout = res.outcomes.find((o) => o.gate.reason === "provider_error")!;
    expect(timeout.target).toBe("needs_review");
    expect(jev.calls.filter((c) => c.fields.subject === "Finish signing up").length).toBe(3);

    // one-time codes never left the device
    const payloads = JSON.stringify(jev.calls);
    for (const code of ["482913", "551029", "739201"]) expect(payloads).not.toContain(code);
    expect(authSeen.length).toBe(2);
    expect(res.outcomes.every((o) => !o.error)).toBe(true);
  });

  it("a second run with the returned cursor sees nothing new", async () => {
    const t = new FakeImapTransport();
    seed(t);
    const adapter = new ImapAdapter({ transport: t });
    const jev = new RoutingJev(jevScripts);
    const first = await runPipeline({ adapter, folder: "INBOX", jev, user: user() });
    const second = await runPipeline({ adapter, folder: "INBOX", jev, user: user(), cursor: first.cursor });
    expect(second.outcomes).toEqual([]);
  });

  it("without the MOVE extension: copies and flags, originals stay, still nothing deleted", async () => {
    const t = new FakeImapTransport({ move: false });
    seed(t);
    const before = t.totalMessages();
    const adapter = new ImapAdapter({ transport: t });
    await runPipeline({ adapter, folder: "INBOX", jev: new RoutingJev(jevScripts), user: user() });
    expect(t.totalMessages()).toBeGreaterThanOrEqual(before);
    expect(t.messages("INBOX").length).toBe(6); // all originals kept
    expect(t.messages("INBOX").filter((m) => m.keywords.has("$JevMoved")).length).toBe(5);
    expect(subjectsIn(t, "Jev Auth")).toEqual(["Your one-time password", "Your verification code"]);
    expect(t.messages("Junk").length).toBe(0);
    expect(t.ops.some((o) => /delet|expunge/i.test(o.op))).toBe(false);
  });

  it("folder creation failures: Auth stays in place, Junk falls back to Needs review, provider Junk untouched", async () => {
    const t = new FakeImapTransport({ failCreate: (p) => p === "Jev Auth" || p === "Jev Junk" });
    seed(t);
    const adapter = new ImapAdapter({ transport: t });
    await runPipeline({ adapter, folder: "INBOX", jev: new RoutingJev(jevScripts), user: user() });
    expect(subjectsIn(t, "INBOX")).toEqual(expect.arrayContaining(["Your verification code", "Your one-time password"]));
    expect(subjectsIn(t, "Jev Needs review")).toContain("Big summer sale"); // Junk fell back
    expect(t.messages("Junk").length).toBe(0);
  });

  it("jev.ai down for everything: nothing goes to Junk, deterministic Auth still works", async () => {
    const t = new FakeImapTransport();
    seed(t);
    const adapter = new ImapAdapter({ transport: t });
    const down: JevClient = { classify: async () => { throw new JevTimeoutError(); } };
    await runPipeline({ adapter, folder: "INBOX", jev: down, user: user() });
    expect(t.folderPaths().includes("Jev Junk") ? t.messages("Jev Junk").length : 0).toBe(0);
    expect(subjectsIn(t, "Jev Auth")).toEqual(["Your one-time password", "Your verification code"]);
    expect(t.messages("Junk").length).toBe(0);
  });

  it("a failed move holds the cursor back so the message is retried", async () => {
    const t = new FakeImapTransport();
    seed(t);
    const adapter = new ImapAdapter({ transport: t });
    const origMove = adapter.moveToBucket.bind(adapter);
    let failed = false;
    adapter.moveToBucket = async (f, id, b) => {
      if (!failed && b === "junk") { failed = true; return { success: false, moved: false, messageId: id, originalLocation: f, destination: null, bucketUsed: null, method: "none", error: "transient" }; }
      return origMove(f, id, b);
    };
    const jev = new RoutingJev(jevScripts);
    const r1 = await runPipeline({ adapter, folder: "INBOX", jev, user: user() });
    expect(r1.outcomes.some((o) => o.error)).toBe(true);
    expect(r1.cursor).toBe("1000:2"); // stops before message 3
    const r2 = await runPipeline({ adapter, folder: "INBOX", jev, user: user(), cursor: r1.cursor });
    expect(r2.outcomes.length).toBeGreaterThan(0);
  });
});
