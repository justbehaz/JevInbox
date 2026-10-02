import Link from "next/link";
import { moveAction } from "../app/actions";
import { AUTH_IMMUTABLE_COPY, Preview as PreviewData } from "../src/ui/actions";
import { SP } from "./Notice";
import { Badge } from "./Badge";

export default function Preview({ pv, path }: { pv: PreviewData | null; path: string; sp: SP }) {
  if (!pv) return <div className="rounded border border-line bg-card p-4 text-sm text-muted">Select a message to preview it.</div>;
  const { row } = pv;
  const isAuth = row.bucket === "auth";
  return (
    <article className="rounded border border-line bg-card p-4" aria-labelledby="pv-subject">
      <h2 id="pv-subject" className="text-base font-semibold">{row.subject}</h2>
      <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-sm">
        <dt className="text-muted">From</dt><dd className="break-all">{pv.from}</dd>
        {pv.replyTo ? (<><dt className="text-muted">Reply-To</dt><dd className="break-all">{pv.replyTo}</dd></>) : null}
        <dt className="text-muted">Date</dt><dd>{pv.date.slice(0, 16).replace("T", " ")}</dd>
        {pv.authenticationResults ? (<><dt className="text-muted">Auth results</dt><dd className="break-all">{pv.authenticationResults}</dd></>) : null}
        <dt className="text-muted">Filed as</dt><dd><Badge row={row} /></dd>
      </dl>
      <p className="mt-3 whitespace-pre-wrap rounded border border-line bg-bg p-3 text-sm" aria-label="Message snippet">{pv.snippet || "(no text)"}</p>
      <p className="mt-2 text-xs text-muted"><strong>Why filed:</strong> {pv.whyFiled}</p>
      <p className="mt-2 text-sm">
        <Link href={`/senders/${encodeURIComponent(row.senderKey)}`} className="text-accent underline">All from this sender</Link>
      </p>
      <form action={moveAction} className="mt-3 flex flex-wrap gap-2">
        <input type="hidden" name="returnTo" value={path} />
        <input type="hidden" name="token" value={row.token} />
        <button name="target" value="archive" type="submit" className="rounded border border-line px-3 py-1 text-sm hover:bg-sel">Archive</button>
        {isAuth ? (
          <p className="basis-full text-xs text-muted" role="note">{AUTH_IMMUTABLE_COPY} It can only be archived, which is reversible and not a delete.</p>
        ) : (
          <>
            <button name="target" value="needs_review" type="submit" className="rounded border border-line px-3 py-1 text-sm hover:bg-sel">Needs review</button>
            {row.protectedMail ? (
              <p className="basis-full text-xs text-muted" role="note">This looks like security mail, so it cannot be moved to Junk.</p>
            ) : (
              <button name="target" value="junk" type="submit" className="rounded border border-line px-3 py-1 text-sm hover:bg-sel">Move to Junk</button>
            )}
          </>
        )}
      </form>
    </article>
  );
}
