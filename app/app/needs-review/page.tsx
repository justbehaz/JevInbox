import { fileAction } from "../actions";
import Workspace from "../../components/Workspace";
import { SP } from "../../components/Notice";
import { Row } from "../../src/ui/actions";
import { getAppState } from "../../src/ui/state";

export default async function NeedsReviewPage({ searchParams }: { searchParams: Promise<SP> }) {
  const cats = (await getAppState()).categories.enabled();
  const Actions = (r: Row) => (
    <form action={fileAction} className="flex flex-wrap items-center gap-2" aria-label={`File ${r.subject}`}>
      <input type="hidden" name="returnTo" value="/needs-review" />
      <input type="hidden" name="token" value={r.token} />
      <button name="target" value="auth" type="submit" className="rounded border border-accent px-2 py-1 text-xs text-accent hover:bg-sel">File as Auth</button>
      <label className="text-xs" htmlFor={`cat-${r.token}`}>or file under</label>
      <select id={`cat-${r.token}`} name="target" defaultValue="" className="rounded border border-line bg-bg px-2 py-1 text-xs">
        <option value="" disabled>Choose category</option>
        {cats.map((c) => <option key={c.id} value={`category:${c.id}`}>{c.name}</option>)}
      </select>
      <button type="submit" className="rounded bg-accent px-2 py-1 text-xs font-medium text-accent-fg">File</button>
    </form>
  );
  return (
    <Workspace title="Needs review" path="/needs-review" view={{ kind: "needs_review" }} sp={await searchParams} bulk={false} rowActions={Actions}
      intro={<p className="mb-3 text-sm text-muted">Mail jev.ai could not classify with confidence, mail that looks like security mail, and anything that hit an error. Nothing here is junk. One click files it.</p>} />
  );
}
