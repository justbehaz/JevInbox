export type TlsMode = "implicit" | "starttls"; // plaintext is not offered

export interface ImapPreset {
  name: string;
  host: string;
  port: number;
  tls: TlsMode;
  /** Informational: iCloud has no OAuth, so only app-specific passwords work. */
  authHint: "app_password" | "password_or_xoauth2";
}

export const ICLOUD_PRESET: ImapPreset = {
  name: "iCloud",
  host: "imap.mail.me.com",
  port: 993,
  tls: "implicit",
  authHint: "app_password",
};

export function genericPreset(input: { host: string; port: number; tls: TlsMode }): ImapPreset {
  const host = (input.host ?? "").trim();
  if (!host || /[\s/\\]/.test(host)) throw new Error("invalid IMAP host");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("invalid IMAP port");
  if (input.tls !== "implicit" && input.tls !== "starttls") throw new Error("TLS is required: use implicit TLS or STARTTLS");
  return { name: "IMAP", host, port: input.port, tls: input.tls, authHint: "password_or_xoauth2" };
}
