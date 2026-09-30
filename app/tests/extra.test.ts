import { describe, expect, it } from "vitest";
import { canMoveToJunk, classify } from "../src/gate/gate";
import { containsCode, redactText, buildSnippet } from "../src/gate/redact";
import { FakeJev, FakeScript } from "../src/jev/fake";
import { DEFAULT_CATEGORIES } from "../src/gate/categories";
import { answers, ctx, msg, NEUTRAL, PROMO } from "./fixtures";

const Y = true, N = false;

describe("taxonomy", () => {
  it("has 36 defaults, Other last", () => {
    expect(DEFAULT_CATEGORIES.length).toBe(36);
    expect(DEFAULT_CATEGORIES[35].name).toBe("Other");
    expect(DEFAULT_CATEGORIES[0].id).toBe("cat_001");
  });
});

describe("redaction", () => {
  it("replaces 4-8 digit codes in all common shapes", () => {
    for (const t of ["123456", "123 456", "12-34-56", "1234", "12345678", "1234567890", "code: 998877."]) {
      expect(containsCode(redactText(t)), t).toBe(false);
    }
  });
  it("replaces reset/verify links and opaque tokens", () => {
    const out = redactText("Reset: https://x.example/reset?token=abcdEFGH12345678xyz and https://x.example/about");
    expect(out).toContain("[LINK]");
    expect(out).not.toContain("abcdEFGH12345678xyz");
    expect(out).toContain("https://x.example/about");
  });
  it("redacts before truncating (no code leak at the 500 char boundary)", () => {
    const body = "a".repeat(497) + " 123456";
    expect(containsCode(buildSnippet(body))).toBe(false);
  });
  it("snippet is at most 500 chars", () => {
    expect(buildSnippet("x ".repeat(1000)).length).toBeLessThanOrEqual(500);
  });
});

describe("provider failures never Junk", () => {
  const junkAnswers = answers({ sys_auth: [N, 99], sys_junk: [Y, 99] });
  const bad: [string, FakeScript][] = [
    ["timeout", { kind: "timeout" }],
    ["error", { kind: "error" }],
    ["partial", { kind: "answers", answers: { sys_junk: [Y, 99] }, status: "partial" }],
    ["error status", { kind: "answers", answers: {}, status: "error" }],
    ["garbage", { kind: "raw", response: "nope" }],
    ["null", { kind: "raw", response: null }],
    ["missing answers", { kind: "raw", response: { message_id: "x", status: "success", answers: [{ question_id: "sys_junk", answer: true, confidence: 99 }] } }],
    ["bad confidence", { kind: "raw", response: { message_id: "x", status: "success", answers: [{ question_id: "sys_junk", answer: true, confidence: 101 }] } }],
  ];
  for (const [name, s] of bad) {
    it(name, async () => {
      const res = await classify(PROMO, ctx({ markedJunk: ["deals@shop.example"] }), new FakeJev([s]));
      expect(res.bucket).toBe("needs_review");
    });
  }
  it("duplicate question ids are invalid", async () => {
    const good = new FakeJev([junkAnswers]);
    const ok = await classify(PROMO, ctx(), good);
    expect(ok.bucket).toBe("junk"); // sanity: fully legit jev junk passes
    const dup: FakeScript = { kind: "raw", response: { message_id: "x", status: "success", answers: [
      ...good.calls[0].questions.map((q) => ({ question_id: q.question_id, answer: false, confidence: 99 })),
      { question_id: "sys_junk", answer: true, confidence: 99 } ] } };
    const res = await classify(PROMO, ctx(), new FakeJev([dup]));
    expect(res.bucket).toBe("needs_review");
  });
  it("timeout then success uses the success", async () => {
    const jev = new FakeJev([{ kind: "timeout" }, answers({ sys_auth: [Y, 95] })]);
    const res = await classify(NEUTRAL, ctx(), jev);
    expect(res.bucket).toBe("auth");
    expect(jev.calls.length).toBe(2);
  });
  it("throwing user-context callback => gate_error, Needs review", async () => {
    const res = await classify(PROMO, ctx({ hasRepliedTo: () => { throw new Error("db down"); } }), new FakeJev([answers({ sys_auth: [N, 99], sys_junk: [Y, 99] })]));
    expect(res.bucket).toBe("needs_review");
    expect(res.reason).toBe("gate_error");
  });
});

describe("category filing", () => {
  it("most confident wins, ties by catalogue order", async () => {
    const a = answers({ sys_auth: [N, 95], sys_junk: [N, 95], cat_020: [Y, 90], cat_007: [Y, 90], cat_008: [Y, 70] });
    const res = await classify(PROMO, ctx(), new FakeJev([a]));
    expect(res.categoryId).toBe("cat_007");
    const b = answers({ sys_auth: [N, 95], sys_junk: [N, 95], cat_020: [Y, 91], cat_007: [Y, 90] });
    expect((await classify(PROMO, ctx(), new FakeJev([b]))).categoryId).toBe("cat_020");
  });
  it("promotion from a normal sender is a category, not junk", async () => {
    const a = answers({ sys_auth: [N, 95], sys_junk: [N, 80], cat_020: [Y, 90] });
    const res = await classify(PROMO, ctx(), new FakeJev([a]));
    expect(res.bucket).toBe("category");
  });
  it("no category yes => Needs review", async () => {
    const res = await classify(PROMO, ctx(), new FakeJev([answers({ sys_auth: [N, 95], sys_junk: [N, 95] })]));
    expect(res.bucket).toBe("needs_review");
  });
  it("allowlisted sender is never Junk even with junk 99", async () => {
    const res = await classify(PROMO, ctx({ allowlist: ["@shop.example"] }), new FakeJev([answers({ sys_auth: [N, 99], sys_junk: [Y, 99] })]));
    expect(res.bucket).not.toBe("junk");
  });
  it("allowlist beats user mark", async () => {
    const res = await classify(PROMO, ctx({ allowlist: ["deals@shop.example"], markedJunk: ["deals@shop.example"] }), new FakeJev([answers({ sys_auth: [N, 99], sys_junk: [N, 99], cat_020: [Y, 90] })]));
    expect(res.bucket).toBe("category");
  });
});

describe("moves", () => {
  it("Auth and security-shaped mail cannot be moved to Junk", () => {
    expect(canMoveToJunk(PROMO, "auth").ok).toBe(false);
    expect(canMoveToJunk(msg("o", "a@b.example", "Your verification code", "1"), "category").ok).toBe(false);
    expect(canMoveToJunk(msg("o", "a@b.example", "Hi", "Enter 739201"), "needs_review").ok).toBe(false);
    expect(canMoveToJunk(PROMO, "category").ok).toBe(true);
  });
});

// Exhaustive sweep: for every combination of jev answers, mail that carries an Auth signal or
// security shape can never end in Junk, for any user context.
describe("never-junk invariant sweep", () => {
  const confs = [0, 59, 60, 79, 80, 89, 90, 95, 100];
  const authMsgs = [
    msg("s1", "x@y.example", "Your verification code", "482913"),
    msg("s2", "x@y.example", "Password reset requested", "hi"),
    msg("s3", "x@y.example", "Hello", "Enter 739201 to continue."), // shape only
    msg("s4", "x@y.example", "Help", "please verify"), // shape only
  ];
  it("no combination yields Junk", async () => {
    let n = 0;
    for (const m of authMsgs)
      for (const aY of [Y, N]) for (const aC of confs)
        for (const jY of [Y, N]) for (const jC of confs)
          for (const marked of [true, false]) for (const allow of [true, false])
            for (const replied of [true, false]) for (const hist of [true, false]) {
              const jev = new FakeJev([answers({ sys_auth: [aY, aC], sys_junk: [jY, jC] })]);
              const res = await classify(m, ctx({
                markedJunk: marked ? ["x@y.example"] : [], allowlist: allow ? ["x@y.example"] : [],
                hasRepliedTo: () => replied, hasAuthHistory: () => hist }), jev);
              n++;
              if (res.bucket === "junk") throw new Error(`JUNK for ${m.id} ${aY}@${aC} ${jY}@${jC} ${marked}`);
            }
    expect(n).toBe(4 * 2 * 9 * 2 * 9 * 16);
  });
  it("jev Auth yes >= 80 is Auth for every junk answer", async () => {
    for (const c of [80, 90, 100]) for (const jY of [Y, N]) for (const jC of confs) {
      const res = await classify(PROMO, ctx({ markedJunk: ["deals@shop.example"] }), new FakeJev([answers({ sys_auth: [Y, c], sys_junk: [jY, jC] })]));
      expect(res.bucket).toBe("auth");
    }
  });
});
