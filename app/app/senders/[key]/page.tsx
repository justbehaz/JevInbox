import Link from "next/link";
import { notFound } from "next/navigation";
import { senderAction } from "../../actions";
import Workspace from "../../../components/Workspace";
import { SP } from "../../../components/Notice";
import { MARK_JUNK_NOTE } from "../../../src/ui/actions";
import { getAppState } from "../../../src/ui/state";

function safeDecode(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export default async function SenderPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<SP> }) {
  const key = safeDecode((await params).key).toLowerCase();
  const sp = await searchParams;
  const st = await getAppState();
  const s = st.store.sender(key);
  if (!s) notFound();
  const breakdown = st.store.bucketBreakdown(key);
  const path = `/senders/${encodeURIComponent(key)}`;
  const label = (l: string) => (l === "auth" ? "Auth" : l === "junk" ? "Junk" : l === "needs_review" ? "Needs review" : l === "archived" ? "Archived" : l === "inbox" ? "Inbox" : st.categories.nameOf(l));
  const btn = "rounded border border-line px-3 py-1 text-sm hover:bg-sel";

  const header = (
    <section aria-labelledby="sender-h" className="mb-4 rounded border border-line bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted"><Link href="/senders" className="underline">Senders</Link> / All from this sender</p>
      <h1 id="sender-h" className="mt-1 break-all text-xl font-bold">All from this sender</h1>
      <p className="mt-1 break-all text-base">{s.senderKey}{s.displayName ? <span className="ml-2 text-sm text-muted">({s.displayName})</span> : null}</p>
      <p className="mt-1 text-sm text-muted">
        {s.messageCount} message{s.messageCount === 1 ? "" : "s"}, {s.unreadCount} unread, last seen {s.lastSeen?.slice(0, 10) ?? "-"}.
        {" "}{[s.allowlisted && "Allowed.", s.markedJunk && "Marked junk.", s.muted && "Muted."].filter(Boolean).join(" ")}
      </p>
      <ul className="mt-2 flex flex-wrap gap-2 text-xs" aria-label="Messages by bucket or category">
        {breakdown.map((b) => <li key={b.label} className="rounded border border-line px-2 py-0.5">{label(b.label)}: {b.count}</li>)}
      </ul>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <form action={senderAction}>
          <input type="hidden" name="returnTo" value={path} /><input type="hidden" name="sender" value={s.senderKey} />
          <button className={btn} name="action" value={s.allowlisted ? "unallow" : "allow"} type="submit">{s.allowlisted ? "Remove from allow list" : "Allow sender"}</button>
        </form>
        <form action={senderAction}>
          <input type="hidden" name="returnTo" value={path} /><input type="hidden" name="sender" value={s.senderKey} />
          <button className={btn} name="action" value={s.muted ? "unmute" : "mute"} type="submit">{s.muted ? "Unmute sender" : "Mute sender"}</button>
        </form>
        {s.markedJunk ? (
          <form action={senderAction}>
            <input type="hidden" name="returnTo" value={path} /><input type="hidden" name="sender" value={s.senderKey} />
            <button className={btn} name="action" value="unmark" type="submit">Unmark junk</button>
          </form>
        ) : (
          <details className="rounded border border-line p-2">
            <summary className="cursor-pointer text-sm">Mark junk&hellip;</summary>
            <form action={senderAction} className="mt-2 max-w-md space-y-2">
              <input type="hidden" name="returnTo" value={path} /><input type="hidden" name="sender" value={s.senderKey} />
              <p role="note" className="rounded border border-warn px-2 py-1 text-sm">{MARK_JUNK_NOTE}</p>
              <p className="text-xs text-muted">Existing non-security mail from this sender is moved to Junk. Nothing is deleted, and you can undo this.</p>
              <button className="rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-sel" name="action" value="mark_junk" type="submit">Mark {s.senderKey} as junk</button>
            </form>
          </details>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">Mute only hides this sender&apos;s mail from your lists; it moves nothing, and security mail is never hidden. This view always shows everything.</p>
    </section>
  );
  return <Workspace title="Messages" path={path} view={{ kind: "sender", key }} sp={sp} header={header} />;
}
