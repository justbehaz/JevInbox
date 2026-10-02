// Read-only IMAP smoke run. Connects, lists folders and capabilities, fetches the newest messages,
// and prints the bucket each would get from the gate in DRY-RUN mode (jev.ai is a fake client, so
// only the deterministic rules are real). Writes are impossible: the transport is wrapped.
import { classify } from "../gate/gate";
import { addressOf, domainOf } from "../gate/detect";
import { UserContext } from "../gate/types";
import { FakeJev } from "../jev/fake";
import { JevClient } from "../jev/types";
import { ImapAdapter } from "../providers/imap/adapter";
import { ReadOnlyTransport } from "../providers/imap/readonly";
import { ImapTransport } from "../providers/imap/transport";

export interface SmokeOptions {
  transport: ImapTransport;
  out: (line: string) => void;
  folder?: string;
  limit?: number;
  jev?: JevClient;
  user?: UserContext;
}

export const SUBJECT_MAX = 60;

export function cut(subject: string, max = SUBJECT_MAX): string {
  const one = subject.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) : one;
}

export async function runSmoke(o: SmokeOptions): Promise<{ checked: number; counts: Record<string, number> }> {
  const folder = o.folder ?? "INBOX";
  const limit = o.limit ?? 20;
  const ro = new ReadOnlyTransport(o.transport); // no write can get through
  const adapter = new ImapAdapter({ transport: ro });
  const jev = o.jev ?? new FakeJev([{ kind: "answers", answers: {} }]);
  const user: UserContext = o.user ?? { allowlist: [], markedJunk: [], hasRepliedTo: () => false, hasAuthHistory: () => false };

  await adapter.connect();
  try {
    o.out("== Read-only smoke run (no folders created, nothing moved or flagged) ==");
    const caps = await ro.capabilities();
    o.out(`capabilities: MOVE=${caps.move} IDLE=${caps.idle} XOAUTH2=${caps.xoauth2}`);
    o.out("folders:");
    for (const f of await ro.listFolders()) o.out(`  ${f.path}${f.specialUse ? `  (${f.specialUse})` : ""}`);

    o.out(`\nnewest ${limit} in ${folder} (dry-run gate; jev.ai is a FAKE here, only deterministic rules are real):`);
    const details = await adapter.fetchLatest(folder, limit);
    const counts: Record<string, number> = {};
    let i = 0;
    for (const d of details) {
      const res = await classify({ id: d.id, from: d.from, replyTo: d.replyTo, subject: d.subject, body: d.bodySample }, user, jev);
      counts[res.bucket] = (counts[res.bucket] ?? 0) + 1;
      i++;
      // Only the From DOMAIN and a cut subject are printed. Never the address, body or snippet.
      o.out(`${String(i).padStart(2)}  ${res.bucket.padEnd(12)}  ${domainOf(addressOf(d.from)) || "?"}  "${cut(d.subject)}"`);
    }
    o.out(`\nsummary: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "no messages"}`);
    return { checked: details.length, counts };
  } finally {
    await adapter.disconnect();
  }
}
