import { describe, expect, it } from "vitest";
import { classify } from "../src/gate/gate";
import { Bucket } from "../src/gate/types";
import { FakeJev, FakeScript } from "../src/jev/fake";
import { answers, ctx, msg, NEUTRAL, PROMO } from "./fixtures";

const Y = true, N = false;
const TIMEOUT: FakeScript = { kind: "timeout" };

interface Row {
  id: string;
  name: string;
  message: ReturnType<typeof msg>;
  user?: Parameters<typeof ctx>[0];
  jev: FakeScript;
  bucket: Bucket;
  categoryId?: string;
  jevCalled?: boolean;
}

const marked = (a: string) => ({ markedJunk: [a] });

const rows: Row[] = [
  { id: "T1", name: "OTP from Google", message: msg("t1", "no-reply@accounts.google.example", "Your verification code", "Your code is 482913"), jev: answers({}), bucket: "auth", jevCalled: false },
  { id: "T2", name: "Magic link, allowlisted, deterministic pass misses, jev Auth yes 92", message: msg("t2", "noreply@github.com", "Sign in to GitHub", "Use this link to continue."), user: { allowlist: ["@github.com"] }, jev: answers({ sys_auth: [Y, 92] }), bucket: "auth" },
  { id: "T3", name: "Login alert from bank, user marked bank junk", message: msg("t3", "alerts@bank.example", "Login alert on your account", "Was this you?"), user: marked("alerts@bank.example"), jev: answers({}), bucket: "auth", jevCalled: false },
  { id: "T4", name: "Verification, jev Auth yes 65", message: NEUTRAL, jev: answers({ sys_auth: [Y, 65] }), bucket: "needs_review" },
  { id: "T5", name: "Password reset wording, jev timeout", message: msg("t5", "help@service.example", "Trouble with your account?", "We noticed a request."), jev: TIMEOUT, bucket: "needs_review" },
  { id: "T6", name: "Password reset deterministic", message: msg("t6", "help@service.example", "Password reset requested", "Someone asked."), jev: answers({}), bucket: "auth", jevCalled: false },
  { id: "T7", name: "Promo, user marked, junk 92", message: PROMO, user: marked("deals@shop.example"), jev: answers({ sys_auth: [N, 95], sys_junk: [Y, 92] }), bucket: "junk" },
  { id: "T8", name: "Promo, replied before, junk 91", message: PROMO, user: { hasRepliedTo: () => true }, jev: answers({ sys_auth: [N, 91], sys_junk: [Y, 91] }), bucket: "needs_review" },
  { id: "T9", name: "Phishing-like, junk 55", message: msg("t9", "prize@win.example", "You won a prize", "Claim your reward now"), jev: answers({ sys_auth: [N, 88], sys_junk: [Y, 55] }), bucket: "needs_review" },
  { id: "T10", name: "Receipt, user marked, junk 15", message: msg("t10", "receipts@uber.example", "Your Uber receipt", "Total: 12.50"), user: marked("receipts@uber.example"), jev: answers({ sys_auth: [N, 92], sys_junk: [Y, 15] }), bucket: "junk" },
  { id: "T11", name: "Bill, replied before, junk 88", message: msg("t11", "bills@utility.example", "Your bill is ready", "Amount: 54.20"), user: { hasRepliedTo: () => true }, jev: answers({ sys_auth: [N, 90], sys_junk: [Y, 88] }), bucket: "needs_review" },
  { id: "T12", name: "Verification from new provider, jev Auth 85", message: NEUTRAL, jev: answers({ sys_auth: [Y, 85] }), bucket: "auth" },
  { id: "T13", name: "Newsletter, user marked, junk 88", message: msg("t13", "news@letters.example", "Weekly digest", "Stories this week."), user: marked("news@letters.example"), jev: answers({ sys_auth: [N, 92], sys_junk: [Y, 88] }), bucket: "junk" },
  { id: "T14", name: "Account confirmation deterministic", message: msg("t14", "team@app.example", "Confirm your email", "Welcome."), jev: answers({}), bucket: "auth", jevCalled: false },
  { id: "T15", name: "Shipping from Amazon, user marked, Auth no 87", message: msg("t15", "ship-updates@amazon.example", "Your package has shipped", "Order number: A-1. Track your delivery."), user: marked("ship-updates@amazon.example"), jev: answers({ sys_auth: [N, 87], sys_junk: [Y, 12] }), bucket: "junk" },
  { id: "T16", name: "Unusual wording, Auth no 85, junk 80", message: msg("t16", "team@profile.example", "Access to your profile", "Follow the steps to regain your profile."), jev: answers({ sys_auth: [N, 85], sys_junk: [Y, 80] }), bucket: "needs_review" },
  { id: "T17", name: "Auth no 95, junk 95, body has 6-digit code", message: msg("t17", "team@profile.example", "Note about your profile", "Enter 739201 to continue."), jev: answers({ sys_auth: [N, 95], sys_junk: [Y, 95] }), bucket: "needs_review" },
  { id: "T18", name: "Auth no 95, junk 95, sender has Auth history", message: msg("t18", "team@profile.example", "Update on your profile", "We updated something."), user: { hasAuthHistory: () => true }, jev: answers({ sys_auth: [N, 95], sys_junk: [Y, 95] }), bucket: "needs_review" },
  { id: "T19", name: "Pure promo, Auth no 97, junk 93", message: PROMO, jev: answers({ sys_auth: [N, 97], sys_junk: [Y, 93] }), bucket: "junk" },
  { id: "T20", name: "User-marked sender sends OTP", message: msg("t20", "deals@shop.example", "Your one-time password", "Use 551029."), user: marked("deals@shop.example"), jev: answers({}), bucket: "auth", jevCalled: false },
  { id: "T21", name: "User-marked sender sends promo", message: PROMO, user: marked("deals@shop.example"), jev: answers({ sys_auth: [N, 93], sys_junk: [Y, 91] }), bucket: "junk" },
  { id: "T22", name: "User-marked sender, security-like, no Auth flag", message: msg("t22", "deals@shop.example", "Note about your profile", "Enter 739201 to continue."), user: marked("deals@shop.example"), jev: answers({ sys_auth: [N, 92], sys_junk: [Y, 89] }), bucket: "needs_review" },
  { id: "T23", name: "Code redaction: deterministic Auth on original, jev not called", message: msg("t23", "no-reply@bank.example", "Your verification code", "482913"), jev: answers({}), bucket: "auth", jevCalled: false },
  { id: "T24", name: "Code redaction: deterministic misses, payload carries [CODE], category filing", message: msg("t24", "friend@mail.example", "Weekend plans", "Ref #55521 see you Saturday"), jev: answers({ sys_auth: [N, 92], sys_junk: [N, 88], cat_001: [Y, 80] }), bucket: "category", categoryId: "cat_001" },
  { id: "T25", name: "Jev timeout after retries", message: NEUTRAL, jev: TIMEOUT, bucket: "needs_review" },
  { id: "T26", name: "Jev error", message: NEUTRAL, jev: { kind: "error" }, bucket: "needs_review" },
];

describe("02-never-junk.md test table", () => {
  for (const r of rows) {
    it(`${r.id}: ${r.name} -> ${r.bucket}`, async () => {
      const jev = new FakeJev([r.jev]);
      const res = await classify(r.message, ctx(r.user), jev);
      expect(res.bucket, res.trace.join(" | ")).toBe(r.bucket);
      if (r.categoryId) expect(res.categoryId).toBe(r.categoryId);
      if (r.jevCalled === false) expect(jev.calls.length).toBe(0);
    });
  }

  it("T24 payload has [CODE] and never the digits", async () => {
    const r = rows.find((x) => x.id === "T24")!;
    const jev = new FakeJev([r.jev]);
    await classify(r.message, ctx(), jev);
    const payload = JSON.stringify(jev.calls[0]);
    expect(payload).toContain("[CODE]");
    expect(payload).not.toContain("55521");
  });

  it("T25 retries are bounded (1 + 2 retries) then Needs review", async () => {
    const jev = new FakeJev([TIMEOUT]);
    const res = await classify(NEUTRAL, ctx(), jev);
    expect(jev.calls.length).toBe(3);
    expect(res.reason).toBe("provider_error");
  });

  it("has exactly 26 table rows", () => {
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 26 }, (_, i) => `T${i + 1}`));
  });
});
