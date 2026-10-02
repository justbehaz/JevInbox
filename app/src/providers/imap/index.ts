import { ImapAdapter, ImapAdapterOptions } from "./adapter";
import { CredentialsProvider } from "./credentials";
import { ImapFlowTransport } from "./imapflowTransport";
import { ImapPreset } from "./presets";

export * from "./adapter";
export * from "./credentials";
export * from "./presets";
export * from "./env";
export { ImapFlowTransport } from "./imapflowTransport";
export type { ImapTransport } from "./transport";

/** Real adapter: imapflow transport, credentials injected. */
export function createImapAdapter(o: {
  accountId: string;
  preset: ImapPreset;
  credentials: CredentialsProvider;
  adapter?: Omit<ImapAdapterOptions, "transport">;
}): ImapAdapter {
  const transport = new ImapFlowTransport({ accountId: o.accountId, preset: o.preset, credentials: o.credentials });
  return new ImapAdapter({ providerName: o.preset.name, ...o.adapter, transport });
}
