import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImapFlow } from "imapflow";
import { StaticCredentialsProvider } from "../src/providers/imap/credentials";
import { ImapFlowTransport } from "../src/providers/imap/imapflowTransport";
import { ICLOUD_PRESET, genericPreset } from "../src/providers/imap/presets";
import { scrub } from "../src/providers/imap/sanitize";

const PASSWORD = "app-pass-9f8e7d6c5b4a";
const TOKEN = "ya29.fakeAccessTokenValue1234567890";

const RFC822 = [
  "From: Alice <alice@x.example>",
  "Reply-To: reply@x.example",
  "Subject: hi",
  "List-Unsubscribe: <mailto:u@x.example>",
  "Authentication-Results: mx; spf=pass dkim=pass dmarc=pass",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Body text here",
  "",
].join("\r\n");

function mockClient(over: Record<string, unknown> = {}) {
  const fns = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    list: vi.fn(async () => [{ path: "INBOX", delimiter: "/" }, { path: "Junk", delimiter: "/", specialUse: "\\Junk" }]),
    mailboxCreate: vi.fn(async (p: string) => ({ path: p, created: true })),
    status: vi.fn(async () => ({ uidValidity: 77n, uidNext: 10 })),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    fetch: vi.fn(() => (async function* () {
      yield { uid: 5, flags: new Set(["\\Seen"]), envelope: { subject: "old", date: new Date(), from: [{ address: "o@x.example" }] }, source: Buffer.from(RFC822) };
      yield { uid: 7, flags: new Set<string>(), envelope: { subject: "hi", date: new Date(), from: [{ name: "Alice", address: "alice@x.example" }] }, source: Buffer.from(RFC822) };
    })()),
    fetchOne: vi.fn(async () => ({ uid: 7, flags: new Set<string>(), envelope: { subject: "hi", from: [{ address: "alice@x.example" }] }, source: Buffer.from(RFC822) })),
    messageMove: vi.fn(async () => ({ path: "INBOX", destination: "Jev Auth", uidMap: new Map([[7, 3]]) })),
    messageCopy: vi.fn(async () => ({ path: "INBOX", destination: "Jev Auth", uidMap: new Map([[7, 3]]) })),
    messageFlagsAdd: vi.fn(async () => true),
    messageFlagsRemove: vi.fn(async () => true),
    messageDelete: vi.fn(async () => true),
    mailboxDelete: vi.fn(async () => ({})),
    on: vi.fn(),
    off: vi.fn(),
    capabilities: new Map<string, boolean | number>([["IDLE", true], ["MOVE", true]]),
    ...over,
  };
  return fns;
}

afterEach(() => vi.restoreAllMocks());

const creds = (c: object) => new StaticCredentialsProvider({ acct: { user: "user@example.test", ...c } });

describe("ImapFlowTransport connection options", () => {
  it("iCloud: implicit TLS on 993, password auth, logging disabled", async () => {
    const seen: any[] = [];
    const t = new ImapFlowTransport({
      accountId: "acct", preset: ICLOUD_PRESET, credentials: creds({ password: PASSWORD }),
      createClient: (o) => { seen.push(o); return mockClient() as unknown as ImapFlow; },
    });
    await t.connect();
    expect(seen[0]).toMatchObject({ host: "imap.mail.me.com", port: 993, secure: true, logger: false });
    expect(seen[0].auth).toEqual({ user: "user@example.test", pass: PASSWORD });
  });
  it("generic STARTTLS requires the upgrade", async () => {
    const seen: any[] = [];
    const t = new ImapFlowTransport({
      accountId: "acct", preset: genericPreset({ host: "mail.example.org", port: 143, tls: "starttls" }),
      credentials: creds({ password: PASSWORD }),
      createClient: (o) => { seen.push(o); return mockClient() as unknown as ImapFlow; },
    });
    await t.connect();
    expect(seen[0]).toMatchObject({ secure: false, doSTARTTLS: true, logger: false });
  });
  it("uses XOAUTH2 (accessToken) first, falls back to the password", async () => {
    const seen: any[] = [];
    let n = 0;
    const t = new ImapFlowTransport({
      accountId: "acct", preset: genericPreset({ host: "mail.example.org", port: 993, tls: "implicit" }),
      credentials: creds({ accessToken: TOKEN, password: PASSWORD }),
      createClient: (o) => {
        seen.push(o);
        return mockClient({ connect: vi.fn(async () => { if (n++ === 0) throw new Error("auth failed"); }) }) as unknown as ImapFlow;
      },
    });
    await t.connect();
    expect(seen[0].auth).toEqual({ user: "user@example.test", accessToken: TOKEN });
    expect(seen[1].auth).toEqual({ user: "user@example.test", pass: PASSWORD });
  });
});

describe("secrets never leak", () => {
  it("scrubs secrets that a library error echoes, and never writes to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const t = new ImapFlowTransport({
      accountId: "acct", preset: ICLOUD_PRESET, credentials: creds({ accessToken: TOKEN, password: PASSWORD }),
      createClient: () => mockClient({ connect: vi.fn(async () => { throw new Error(`AUTHENTICATE PLAIN failed for ${PASSWORD} / token ${TOKEN} / XOAUTH2 dXNlcj11c2VyQGV4YW1wbGUudGVzdAFhdXRoPUJlYXJlcg`); }) }) as unknown as ImapFlow,
    });
    let msg = "";
    try { await t.connect(); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toContain(PASSWORD);
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain("dXNlcj11c2Vy");
    expect(msg).toContain("[redacted]");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
  it("scrub helper handles bearer tokens", () => {
    expect(scrub("Bearer abcdefghijklmnop12345", [])).toBe("Bearer [redacted]");
  });
  it("operation errors are scrubbed too", async () => {
    const c = mockClient({ messageMove: vi.fn(async () => { throw new Error(`boom ${PASSWORD}`); }) });
    const t = new ImapFlowTransport({ accountId: "acct", preset: ICLOUD_PRESET, credentials: creds({ password: PASSWORD }), createClient: () => c as unknown as ImapFlow });
    await t.connect();
    await expect(t.move("INBOX", 7, "Jev Auth")).rejects.toThrow(/\[redacted\]/);
    await expect(t.move("INBOX", 7, "Jev Auth")).rejects.not.toThrow(new RegExp(PASSWORD));
  });
});

describe("ImapFlowTransport operations", () => {
  const connected = async (over = {}) => {
    const c = mockClient(over);
    const t = new ImapFlowTransport({ accountId: "acct", preset: ICLOUD_PRESET, credentials: creds({ password: PASSWORD }), createClient: () => c as unknown as ImapFlow });
    await t.connect();
    return { c, t };
  };
  it("maps capabilities", async () => {
    const { t } = await connected({ capabilities: new Map([["IDLE", true], ["AUTH=XOAUTH2", true]]) });
    expect(await t.capabilities()).toEqual({ move: false, idle: true, xoauth2: true });
  });
  it("lists folders with special-use", async () => {
    const { t } = await connected();
    expect((await t.listFolders()).find((f) => f.path === "Junk")?.specialUse).toBe("\\Junk");
  });
  it("folderState converts bigint UIDVALIDITY", async () => {
    const { t } = await connected();
    expect(await t.folderState("INBOX")).toEqual({ uidValidity: 77, uidNext: 10 });
  });
  it("fetchSince drops the n:* quirk message (uid <= after) and parses the body and headers", async () => {
    const { t, c } = await connected();
    const out = await t.fetchSince("INBOX", 5);
    expect(out.map((m) => m.uid)).toEqual([7]);
    expect(out[0]).toMatchObject({ from: "Alice <alice@x.example>", subject: "hi", unread: true, replyTo: "reply@x.example" });
    expect(out[0].bodyText).toContain("Body text here");
    expect(out[0].authenticationResults).toContain("spf=pass");
    expect((c.fetch.mock.calls as any[][])[0][0]).toBe("6:*");
    expect((c.fetch.mock.calls as any[][])[0][2]).toEqual({ uid: true });
  });
  it("opens mailboxes read-only for reads", async () => {
    const { t, c } = await connected();
    await t.fetchSince("INBOX", 0);
    expect((c.getMailboxLock.mock.calls as any[][])[0][1]).toEqual({ readOnly: true });
  });
  it("move and copy use UIDs and report the destination UID", async () => {
    const { t, c } = await connected();
    expect(await t.move("INBOX", 7, "Jev Auth")).toEqual({ destUid: 3 });
    expect(c.messageMove).toHaveBeenCalledWith("7", "Jev Auth", { uid: true });
    expect(await t.copy("INBOX", 7, "Jev Auth")).toEqual({ destUid: 3 });
    expect(c.messageCopy).toHaveBeenCalledWith("7", "Jev Auth", { uid: true });
  });
  it("never deletes: \\Deleted is refused and no delete API is ever called", async () => {
    const { t, c } = await connected();
    await expect(t.setKeyword("INBOX", 7, "\\Deleted", true)).rejects.toThrow();
    await expect(t.setKeyword("INBOX", 7, "\\deleted", false)).rejects.toThrow();
    await t.setKeyword("INBOX", 7, "$JevMoved", true);
    await t.setKeyword("INBOX", 7, "$JevMoved", false);
    await t.move("INBOX", 7, "Jev Auth");
    await t.copy("INBOX", 7, "Jev Auth");
    await t.fetchSince("INBOX", 0);
    await t.createFolder("Jev Auth");
    await t.close();
    expect(c.messageDelete).not.toHaveBeenCalled();
    expect(c.mailboxDelete).not.toHaveBeenCalled();
    expect(c.messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect(c.messageFlagsAdd).toHaveBeenCalledWith("7", ["$JevMoved"], { uid: true });
  });
  it("idle subscribes to exists and stop releases", async () => {
    const release = vi.fn();
    const { t, c } = await connected({ getMailboxLock: vi.fn(async () => ({ release })) });
    const h = vi.fn();
    const s = await t.idle("INBOX", h);
    expect(c.on).toHaveBeenCalledWith("exists", expect.any(Function));
    await s.stop();
    expect(c.off).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });
  it("throws when used before connect", async () => {
    const t = new ImapFlowTransport({ accountId: "acct", preset: ICLOUD_PRESET, credentials: creds({ password: PASSWORD }) });
    await expect(t.listFolders()).rejects.toThrow(/not connected/);
  });
});
