import { junkAction } from "../actions";
import Workspace from "../../components/Workspace";
import { SP } from "../../components/Notice";
import { JUNK_BANNER, Row } from "../../src/ui/actions";

function Actions(r: Row) {
  return (
    <form action={junkAction} className="flex flex-wrap items-center gap-2" aria-label={`Actions for ${r.subject}`}>
      <input type="hidden" name="returnTo" value="/junk" />
      <input type="hidden" name="token" value={r.token} />
      <button name="action" value="not_junk" type="submit" className="rounded border border-line px-2 py-1 text-xs hover:bg-sel">Not junk</button>
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" name="allowSender" /> Also always allow mail from this sender
      </label>
      <button name="action" value="keep" type="submit" className="rounded border border-line px-2 py-1 text-xs hover:bg-sel">Keep in Junk</button>
      <button name="action" value="archive" type="submit" className="rounded border border-line px-2 py-1 text-xs hover:bg-sel">Archive</button>
    </form>
  );
}

export default async function JunkPage({ searchParams }: { searchParams: Promise<SP> }) {
  return (
    <Workspace title="Junk" path="/junk" view={{ kind: "junk" }} sp={await searchParams} bulk={false} rowActions={Actions}
      intro={<p role="note" className="mb-3 rounded border border-warn bg-card px-3 py-2 text-sm">{JUNK_BANNER}</p>} />
  );
}
