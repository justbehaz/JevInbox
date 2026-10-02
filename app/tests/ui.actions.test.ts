import { describe, expect, it } from "vitest";
import { CATEGORY_CAP, CategoryManager } from "../src/categories/manager";
import {
  AUTH_IMMUTABLE_COPY, SECURITY_SHAPE_COPY, JUNK_BANNER, addAccountStub, addCategory, deleteCategory, fileFromReview,
  junkQueueAction, listView, moveMessages, navData, preview, senderAllow, senderMarkJunk, senderMute, setCategoryEnabled, Row,
} from "../src/ui/actions";
import { AppState, createDemoState } from "../src/ui/state";
import { decodeToken, encodeToken } from "../src/ui/tokens";

const subjects = (rows: Row[]) => rows.map((r) => r.subject).sort();
const find = (rows: Row[], subject: string) => rows.find((r) => r.subject === subject)!;
const fresh = () => createDemoState();
const WRITES = ["create", "move", "copy", "keyword+", "keyword-"];

describe("demo mailbox", () => {
  it("loads through the real pipeline: Auth, Needs review, Junk and categories", async () => {
    const st = await fresh();
    expect(subjects(listView(st, { kind: "auth" }))).toEqual([
      "Confirm your email", "Finish signing up", "Login alert on your account", "Password reset requested",
      "Your one-time password", "Your verification code",
    ]);
    expect(subjects(listView(st, { kind: "junk" }))).toEqual(["Urgent business proposal", "You have won a prize"]);
    expect(subjects(listView(st, { kind: "needs_review" }))).toEqual(["Complete your setup", "Note about your profile", "Quick question"]);
    // no Auth-looking mail in Junk
    expect(listView(st, { kind: "junk" }).some((r) => r.protectedMail)).toBe(false);
    // categories filled by the gate
    expect(subjects(listView(st, { kind: "category", id: "cat_020" }))).toEqual(["Autumn sale", "Summer sale"]);
    expect(subjects(listView(st, { kind: "category", id: "cat_011" }))).toEqual(["Weekend flights from 39 pounds"]);
    expect(st.transport.messages("Junk").length).toBe(0);
  });
  it("nav counts match the lists", async () => {
    const st = await fresh();
    const nav = navData(st);
    expect(nav.buckets.auth.count).toBe(6);
    expect(nav.buckets.junk.count).toBe(2);
    expect(nav.buckets.needsReview.count).toBe(3);
    expect(nav.categories.length).toBe(36);
    expect(nav.categories.find((c) => c.id === "cat_019")!.count).toBe(2);
    expect(nav.buckets.inbox.count).toBe(listView(st, { kind: "inbox" }).length);
  });
  it("preview shows headers, a redacted snippet and why it was filed", async () => {
    const st = await fresh();
    const row = find(listView(st, { kind: "auth" }), "Your verification code");
    const p = (await preview(st, row.token))!;
    expect(p.from).toContain("no-reply@accounts.example");
    expect(p.snippet).not.toContain("482913");
    expect(p.snippet).toContain("[CODE]");
    expect(p.whyFiled).toMatch(/authentication|security/i);
    expect(await preview(st, "garbage")).toBeNull();
  });
  it("tokens round-trip and reject junk input", () => {
    expect(decodeToken(encodeToken("Jev Auth", "1000:7"))).toEqual({ folder: "Jev Auth", id: "1000:7" });
    expect(decodeToken("!!!")).toBeNull();
    expect(decodeToken(Buffer.from("[1,2]").toString("base64url"))).toBeNull();
  });
});

describe("Auth mail can never be moved to Junk from the UI", () => {
  it("manual move of an Auth message is blocked with the 05 copy and nothing moves", async () => {
    const st = await fresh();
    const auth = find(listView(st, { kind: "auth" }), "Your verification code");
    const opsBefore = st.transport.ops.length;
    const r = await moveMessages(st, [auth.token], "junk");
    expect(r).toMatchObject({ moved: 0, kind: "error" });
    expect(r.text).toBe(AUTH_IMMUTABLE_COPY);
    expect(r.blocked).toEqual([{ token: auth.token, reason: AUTH_IMMUTABLE_COPY }]);
    expect(st.transport.ops.slice(opsBefore).filter((o) => WRITES.includes(o.op))).toEqual([]);
    expect(subjects(listView(st, { kind: "auth" }))).toContain("Your verification code");
  });
  it("every Auth message in the demo is blocked, one by one and in one bulk move", async () => {
    const st = await fresh();
    const auth = listView(st, { kind: "auth" });
    for (const a of auth) expect((await moveMessages(st, [a.token], "junk")).moved).toBe(0);
    const bulk = await moveMessages(st, auth.map((a) => a.token), "junk");
    expect(bulk.moved).toBe(0);
    expect(bulk.blocked.length).toBe(auth.length);
    expect(listView(st, { kind: "auth" }).length).toBe(auth.length);
    expect(listView(st, { kind: "junk" }).some((r) => auth.some((a) => a.subject === r.subject))).toBe(false);
  });
  it("bulk move of a mixed selection skips Auth, moves the rest, and says so", async () => {
    const st = await fresh();
    const auth = find(listView(st, { kind: "auth" }), "Your one-time password");
    const a = find(listView(st, { kind: "category", id: "cat_020" }), "Summer sale");
    const b = find(listView(st, { kind: "category", id: "cat_019" }), "Weekly digest");
    const r = await moveMessages(st, [auth.token, a.token, b.token], "junk");
    expect(r.moved).toBe(2);
    expect(r.blocked.length).toBe(1);
    expect(r.text).toBe("Moved 2 messages. 1 Auth message stays in Auth.");
    expect(subjects(listView(st, { kind: "junk" }))).toEqual(["Summer sale", "Urgent business proposal", "Weekly digest", "You have won a prize"]);
    expect(subjects(listView(st, { kind: "auth" }))).toContain("Your one-time password");
    expect(st.transport.messages("Junk").length).toBe(0); // provider spam untouched
  });
  it("security-shaped mail (not yet Auth) cannot go to Junk either", async () => {
    const st = await fresh();
    const shaped = find(listView(st, { kind: "needs_review" }), "Note about your profile");
    const r = await moveMessages(st, [shaped.token], "junk");
    expect(r).toMatchObject({ moved: 0, kind: "error", text: SECURITY_SHAPE_COPY });
    expect(subjects(listView(st, { kind: "needs_review" }))).toContain("Note about your profile");
  });
  it("Auth is immutable: it cannot be moved to Needs review or a category either", async () => {
    const st = await fresh();
    const auth = find(listView(st, { kind: "auth" }), "Confirm your email");
    expect((await moveMessages(st, [auth.token], "needs_review")).text).toBe(AUTH_IMMUTABLE_COPY);
    expect((await moveMessages(st, [auth.token], { category: "cat_020" })).text).toBe(AUTH_IMMUTABLE_COPY);
    expect(subjects(listView(st, { kind: "auth" }))).toContain("Confirm your email");
  });
  it("Archive is allowed for Auth (it is not Junk and not a delete) and is reversible-by-location", async () => {
    const st = await fresh();
    const total = st.transport.totalMessages();
    const auth = find(listView(st, { kind: "auth" }), "Confirm your email");
    const r = await moveMessages(st, [auth.token], "archive");
    expect(r.moved).toBe(1);
    expect(st.transport.totalMessages()).toBe(total);
    expect(st.transport.messages("Archive").map((m) => m.subject)).toEqual(["Confirm your email"]);
    expect(subjects(listView(st, { kind: "archived" }))).toEqual(["Confirm your email"]);
  });
  it("a normal message can still be moved to Junk manually", async () => {
    const st = await fresh();
    const m = find(listView(st, { kind: "category", id: "cat_002" }), "Lunch tomorrow?");
    expect((await moveMessages(st, [m.token], "junk")).moved).toBe(1);
    expect(subjects(listView(st, { kind: "junk" }))).toContain("Lunch tomorrow?");
  });
  it("nothing is ever deleted by any move", async () => {
    const st = await fresh();
    const total = st.transport.totalMessages();
    const all = listView(st, { kind: "inbox" });
    await moveMessages(st, all.map((r) => r.token), "junk");
    await moveMessages(st, listView(st, { kind: "junk" }).map((r) => r.token), "archive");
    expect(st.transport.totalMessages()).toBe(total);
    expect(st.transport.ops.some((o) => /delet|expunge/i.test(o.op))).toBe(false);
  });
});

describe("Junk queue", () => {
  it("banner copy is the one from 05", () => {
    expect(JUNK_BANNER).toBe("Security mail (Auth) is never in this folder. Jev Inbox never deletes mail. You can mark a message Not junk, keep it here, or archive it.");
  });
  it("Not junk restores the message and only allowlists the sender when asked", async () => {
    const st = await fresh();
    const m = find(listView(st, { kind: "junk" }), "You have won a prize");
    const r = await junkQueueAction(st, m.token, "not_junk");
    expect(r.kind).toBe("ok");
    expect(subjects(listView(st, { kind: "junk" }))).not.toContain("You have won a prize");
    expect(subjects(listView(st, { kind: "needs_review" }))).toContain("You have won a prize");
    expect(st.store.sender("spam@lottery.example")!.allowlisted).toBe(false);

    const m2 = find(listView(st, { kind: "junk" }), "Urgent business proposal");
    await junkQueueAction(st, m2.token, "not_junk", { allowSender: true });
    expect(st.store.sender("prince@scam.example")!.allowlisted).toBe(true);
  });
  it("Keep in Junk changes nothing", async () => {
    const st = await fresh();
    const m = find(listView(st, { kind: "junk" }), "You have won a prize");
    const ops = st.transport.ops.length;
    expect((await junkQueueAction(st, m.token, "keep")).kind).toBe("info");
    expect(st.transport.ops.length).toBe(ops);
    expect(subjects(listView(st, { kind: "junk" }))).toContain("You have won a prize");
  });
  it("Archive moves to the provider Archive folder without deleting", async () => {
    const st = await fresh();
    const total = st.transport.totalMessages();
    const m = find(listView(st, { kind: "junk" }), "You have won a prize");
    const r = await junkQueueAction(st, m.token, "archive");
    expect(r.text).toMatch(/not deleting/i);
    expect(st.transport.messages("Archive").map((x) => x.subject)).toEqual(["You have won a prize"]);
    expect(st.transport.totalMessages()).toBe(total);
  });
  it("rejects messages that are not in Junk, and unknown tokens", async () => {
    const st = await fresh();
    const auth = find(listView(st, { kind: "auth" }), "Your verification code");
    expect((await junkQueueAction(st, auth.token, "archive")).kind).toBe("error");
    expect((await junkQueueAction(st, "nope", "keep")).kind).toBe("error");
  });
  it("a restored message keeps working for later actions (location tracking)", async () => {
    const st = await fresh();
    const m = find(listView(st, { kind: "junk" }), "You have won a prize");
    await junkQueueAction(st, m.token, "not_junk");
    const moved = find(listView(st, { kind: "needs_review" }), "You have won a prize");
    expect((await fileFromReview(st, moved.token, { category: "cat_020" })).kind).toBe("ok");
    const again = find(listView(st, { kind: "category", id: "cat_020" }), "You have won a prize");
    expect((await moveMessages(st, [again.token], "archive")).moved).toBe(1);
  });
});

describe("Needs review queue: file with one click", () => {
  it("into a category", async () => {
    const st = await fresh();
    const m = find(listView(st, { kind: "needs_review" }), "Quick question");
    expect((await fileFromReview(st, m.token, { category: "cat_002" })).text).toBe("Filed under Work.");
    expect(subjects(listView(st, { kind: "category", id: "cat_002" }))).toContain("Quick question");
    expect(subjects(listView(st, { kind: "needs_review" }))).not.toContain("Quick question");
  });
  it("as Auth, and the sender is remembered as an Auth sender", async () => {
    const st = await fresh();
    const m = find(listView(st, { kind: "needs_review" }), "Complete your setup");
    expect((await fileFromReview(st, m.token, "auth")).text).toBe("Filed as Auth.");
    expect(subjects(listView(st, { kind: "auth" }))).toContain("Complete your setup");
    expect(st.store.userContext().hasAuthHistory("help@service.example", "service.example")).toBe(true);
  });
  it("refuses disabled categories and messages that are not in Needs review", async () => {
    const st = await fresh();
    setCategoryEnabled(st, "cat_002", false);
    const m = find(listView(st, { kind: "needs_review" }), "Quick question");
    expect((await fileFromReview(st, m.token, { category: "cat_002" })).kind).toBe("error");
    const auth = find(listView(st, { kind: "auth" }), "Confirm your email");
    expect((await fileFromReview(st, auth.token, "auth")).kind).toBe("error");
  });
});

describe("sender actions", () => {
  it("mark junk: Auth from a sender who also sends promos stays in Auth, promos go to Junk", async () => {
    const st = await fresh();
    const r = await senderMarkJunk(st, "deals@shop.example");
    expect(r.text).toMatch(/marked junk/);
    expect(r.text).toMatch(/Auth is never moved to Junk/);
    const sender = listView(st, { kind: "sender", key: "deals@shop.example" });
    expect(sender.find((x) => x.subject === "Your one-time password")!.bucket).toBe("auth");
    expect(sender.filter((x) => /sale/i.test(x.subject)).map((x) => x.bucket)).toEqual(["junk", "junk"]);
    expect(st.transport.messages("Junk").length).toBe(0);
  });
  it("allow and mute", async () => {
    const st = await fresh();
    expect(senderAllow(st, "mum@family.example").kind).toBe("ok");
    expect(st.store.sender("mum@family.example")!.allowlisted).toBe(true);
    expect(senderAllow(st, "nobody@x.example").kind).toBe("error");
  });
  it("mute hides the sender's mail from lists but moves nothing and never hides Auth", async () => {
    const st = await fresh();
    const before = st.transport.ops.length;
    senderMute(st, "deals@shop.example", true);
    expect(st.transport.ops.length).toBe(before);
    expect(subjects(listView(st, { kind: "inbox" }))).not.toContain("Summer sale");
    expect(subjects(listView(st, { kind: "inbox" }))).toContain("Your one-time password"); // Auth stays visible
    expect(subjects(listView(st, { kind: "sender", key: "deals@shop.example" })).length).toBe(3); // sender view shows everything
    senderMute(st, "deals@shop.example", false);
    expect(subjects(listView(st, { kind: "inbox" }))).toContain("Summer sale");
  });
});

describe("category manager cap", () => {
  const addUntil = (st: AppState, n: number) => {
    for (let i = st.categories.count(); i < n; i++) expect(addCategory(st, `Custom ${i}`).kind).toBe("ok");
  };
  it("ships 36 defaults and 12 free slots", async () => {
    const st = await fresh();
    expect(st.categories.count()).toBe(36);
    expect(CATEGORY_CAP - st.categories.count()).toBe(12);
  });
  it("allows adds up to 48 and blocks the 49th", async () => {
    const st = await fresh();
    addUntil(st, 48);
    expect(st.categories.count()).toBe(48);
    const r = addCategory(st, "One too many");
    expect(r.kind).toBe("error");
    expect(r.text).toMatch(/48-category limit/);
    expect(st.categories.count()).toBe(48);
    expect(st.categories.list().some((c) => c.name === "One too many")).toBe(false);
  });
  it("disabled categories still count toward the cap", async () => {
    const st = await fresh();
    addUntil(st, 48);
    setCategoryEnabled(st, "cat_020", false);
    expect(st.categories.count()).toBe(48);
    expect(addCategory(st, "Still blocked").kind).toBe("error");
  });
  it("deleting a disabled category frees one slot; enabled ones cannot be deleted", async () => {
    const st = await fresh();
    addUntil(st, 48);
    expect((await deleteCategory(st, "cat_021")).kind).toBe("error"); // enabled
    setCategoryEnabled(st, "cat_021", false);
    expect((await deleteCategory(st, "cat_021")).kind).toBe("ok");
    expect(st.categories.count()).toBe(47);
    expect(addCategory(st, "Fits now").kind).toBe("ok");
    expect(addCategory(st, "Not this one").kind).toBe("error");
  });
  it("deleting a category sends its messages to Needs review and deletes nothing", async () => {
    const st = await fresh();
    const total = st.transport.totalMessages();
    setCategoryEnabled(st, "cat_019", false);
    const r = await deleteCategory(st, "cat_019");
    expect(r.text).toMatch(/2 messages moved to Needs review; none were deleted/);
    expect(subjects(listView(st, { kind: "needs_review" }))).toEqual(expect.arrayContaining(["Weekly digest", "The Friday read"]));
    expect(st.transport.totalMessages()).toBe(total);
  });
  it("validates names: empty, too long, duplicate", async () => {
    const st = await fresh();
    expect(addCategory(st, "   ").kind).toBe("error");
    expect(addCategory(st, "x".repeat(41)).kind).toBe("error");
    expect(addCategory(st, "work").kind).toBe("error"); // duplicate of Work, case-insensitive
    expect(addCategory(st, "Side projects").kind).toBe("ok");
  });
  it("cap logic holds on a standalone manager too", () => {
    const m = new CategoryManager();
    for (let i = 0; i < 12; i++) expect(m.add(`C${i}`).ok).toBe(true);
    expect(m.add("C-extra").ok).toBe(false);
    expect(m.count()).toBe(48);
  });
  it("disabled categories are not offered to jev.ai", async () => {
    const st = await fresh();
    setCategoryEnabled(st, "cat_020", false);
    expect(st.categories.enabled().some((c) => c.id === "cat_020")).toBe(false);
    expect(st.categories.enabled().length).toBe(35);
  });
});

describe("accounts stub", () => {
  it("saves nothing and says so; Gmail and Outlook are coming soon", () => {
    expect(addAccountStub("gmail").text).toBe("Gmail is coming soon.");
    expect(addAccountStub("outlook").text).toBe("Outlook is coming soon.");
    expect(addAccountStub("icloud").text).toMatch(/nothing was saved/);
    expect(addAccountStub("imap").text).toMatch(/nothing was saved/);
  });
});

describe("archived Auth stays protected", () => {
  it("Auth that only jev.ai recognised, once archived, still cannot be moved to Junk", async () => {
    const st = await fresh();
    const a = find(listView(st, { kind: "auth" }), "Finish signing up"); // jev.ai Auth only, no deterministic flag
    expect((await moveMessages(st, [a.token], "archive")).moved).toBe(1);
    const archived = find(listView(st, { kind: "archived" }), "Finish signing up");
    expect(archived.protectedMail).toBe(true);
    const r = await moveMessages(st, [archived.token], "junk");
    expect(r.moved).toBe(0);
    expect(subjects(listView(st, { kind: "junk" }))).not.toContain("Finish signing up");
    expect(st.transport.messages("Jev Junk").map((m) => m.subject)).not.toContain("Finish signing up");
  });
  it("mark-junk on a sender skips their archived Auth mail too", async () => {
    const st = await fresh();
    const a = find(listView(st, { kind: "auth" }), "Finish signing up");
    await moveMessages(st, [a.token], "archive");
    await senderMarkJunk(st, "help@service.example");
    expect(subjects(listView(st, { kind: "junk" }))).not.toContain("Finish signing up");
    expect(subjects(listView(st, { kind: "archived" }))).toContain("Finish signing up");
  });
  it("mail the user filed as Auth is protected too", async () => {
    const st = await fresh();
    const m = find(listView(st, { kind: "needs_review" }), "Quick question");
    await fileFromReview(st, m.token, "auth");
    const filed = find(listView(st, { kind: "auth" }), "Quick question");
    await moveMessages(st, [filed.token], "archive");
    const archived = find(listView(st, { kind: "archived" }), "Quick question");
    expect((await moveMessages(st, [archived.token], "junk")).moved).toBe(0);
  });
});
