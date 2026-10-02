import { describe, expect, it } from "vitest";
import { EnvCredentialsProvider, createImapAdapter, presetFromEnv } from "../src/providers/imap";

describe("env helpers (dev only)", () => {
  it("icloud preset ignores host/port overrides", () => {
    expect(presetFromEnv({ IMAP_PRESET: "icloud", IMAP_HOST: "evil.example" })).toMatchObject({ host: "imap.mail.me.com", port: 993 });
  });
  it("generic preset needs valid host, port and TLS", () => {
    expect(presetFromEnv({ IMAP_PRESET: "generic", IMAP_HOST: "h.example", IMAP_PORT: "993", IMAP_TLS: "implicit" }).port).toBe(993);
    expect(() => presetFromEnv({ IMAP_PRESET: "generic", IMAP_HOST: "h.example", IMAP_PORT: "993", IMAP_TLS: "none" })).toThrow();
    expect(() => presetFromEnv({ IMAP_PRESET: "" })).toThrow();
  });
  it("credentials need a user and a secret; blank values are rejected", async () => {
    await expect(new EnvCredentialsProvider({ IMAP_USER: "u@example.test", IMAP_PASSWORD: "" }).get()).rejects.toThrow();
    await expect(new EnvCredentialsProvider({ IMAP_PASSWORD: "x" }).get()).rejects.toThrow();
    expect(await new EnvCredentialsProvider({ IMAP_USER: "u@example.test", IMAP_PASSWORD: "p" }).get()).toMatchObject({ user: "u@example.test" });
  });
  it("createImapAdapter builds without touching the network", () => {
    const a = createImapAdapter({ accountId: "a", preset: presetFromEnv({ IMAP_PRESET: "icloud" }), credentials: new EnvCredentialsProvider({}) });
    expect(a).toBeTruthy();
  });
});
