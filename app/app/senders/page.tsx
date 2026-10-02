import Link from "next/link";
import Notice, { SP } from "../../components/Notice";
import { getAppState } from "../../src/ui/state";

export default async function SendersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const st = await getAppState();
  const senders = st.store.senderSummary({ includeMuted: true });
  const domains = st.store.domainRollup();
  return (
    <div>
      <Notice sp={sp} />
      <h1 className="mb-1 text-xl font-bold">Senders</h1>
      <p className="mb-3 text-sm text-muted">Grouped on this device by the From address. This is not a category and jev.ai is not involved.</p>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <section aria-label="Senders">
          <div className="overflow-x-auto rounded border border-line bg-card">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Senders with message counts and last seen date</caption>
              <thead className="border-b border-line text-xs uppercase text-muted">
                <tr><th scope="col" className="px-3 py-2">Sender</th><th scope="col" className="px-3 py-2">Messages</th><th scope="col" className="px-3 py-2">Last seen</th><th scope="col" className="px-3 py-2">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {senders.map((s) => (
                  <tr key={s.senderKey}>
                    <td className="px-3 py-2"><Link className="text-accent underline" href={`/senders/${encodeURIComponent(s.senderKey)}`}>{s.senderKey}</Link>{s.displayName ? <span className="block text-xs text-muted">{s.displayName}</span> : null}</td>
                    <td className="px-3 py-2">{s.messageCount}</td>
                    <td className="px-3 py-2">{s.lastSeen?.slice(0, 10) ?? "-"}</td>
                    <td className="px-3 py-2 text-xs">{[s.allowlisted && "Allowed", s.markedJunk && "Marked junk", s.muted && "Muted"].filter(Boolean).join(", ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <aside aria-label="Domains">
          <h2 className="mb-2 text-base font-semibold">By domain</h2>
          <ul className="divide-y divide-line rounded border border-line bg-card text-sm">
            {domains.map((d) => (
              <li key={d.rootDomain} className="flex justify-between gap-2 px-3 py-2"><span>{d.rootDomain}</span><span className="text-muted">{d.senderCount} sender{d.senderCount === 1 ? "" : "s"}, {d.messageCount} msg</span></li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
