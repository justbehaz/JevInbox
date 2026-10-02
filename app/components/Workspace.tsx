import Link from "next/link";
import type { ReactNode } from "react";
import { moveAction } from "../app/actions";
import { listView, preview, View, Row } from "../src/ui/actions";
import { getAppState } from "../src/ui/state";
import Notice, { param, SP } from "./Notice";
import Preview from "./Preview";
import { Badge } from "./Badge";

/** List + preview, with bulk move controls. Used by every list screen. */
export default async function Workspace({
  title, path, view, sp, header, rowActions, intro, bulk = true,
}: {
  title: string; path: string; view: View; sp: SP; header?: ReactNode; intro?: ReactNode; bulk?: boolean;
  rowActions?: (row: Row) => ReactNode;
}) {
  const st = await getAppState();
  const rows = listView(st, view);
  const selected = param(sp, "m");
  const pv = selected ? await preview(st, selected) : null;
  const cats = st.categories.enabled();
  return (
    <div>
      <Notice sp={sp} />
      {header}
      <h1 className="mb-1 text-xl font-bold">{title}</h1>
      {intro}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <section aria-label={`${title} messages`}>
          {rows.length === 0 ? (
            <p className="rounded border border-line bg-card p-4 text-sm text-muted">No messages here.</p>
          ) : (
            <form action={moveAction}>
              <input type="hidden" name="returnTo" value={path} />
              <ul className="divide-y divide-line rounded border border-line bg-card">
                {rows.map((r) => (
                  <li key={r.token} aria-current={selected === r.token ? "true" : undefined} className={`flex items-start gap-3 px-3 py-2 ${selected === r.token ? "bg-sel" : ""}`}>
                    {bulk ? (
                      <label className="mt-1">
                        <span className="sr-only">Select message from {r.senderName ?? r.senderKey}: {r.subject}</span>
                        <input type="checkbox" name="token" value={r.token} className="h-4 w-4" />
                      </label>
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <Link href={`${path}${path.includes("?") ? "&" : "?"}m=${encodeURIComponent(r.token)}`} scroll={false}
                        aria-label={`Message from ${r.senderName ?? r.senderKey} on ${r.date.slice(0, 10)}: ${r.subject}`}
                        className="block hover:underline">
                        <span className={`block truncate text-sm ${r.unread ? "font-semibold" : ""}`}>{r.senderName ?? r.senderKey}</span>
                        <span className="block truncate text-sm">{r.subject}</span>
                      </Link>
                      <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                        <Badge row={r} /> <span>{r.date.slice(0, 10)}</span>{r.previewNote ? <span className="rounded border border-line px-1.5 py-0.5">{r.previewNote}</span> : null}
                      </span>
                      {rowActions ? <div className="mt-2">{rowActions(r)}</div> : null}
                    </div>
                  </li>
                ))}
              </ul>
              {bulk ? (
                <fieldset className="mt-3 flex flex-wrap items-center gap-2 rounded border border-line bg-card p-3">
                  <legend className="px-1 text-sm font-semibold">Move selected messages</legend>
                  <label className="text-sm" htmlFor="bulk-target">To</label>
                  <select id="bulk-target" name="target" className="rounded border border-line bg-bg px-2 py-1 text-sm" defaultValue="archive">
                    <option value="archive">Archive</option>
                    <option value="needs_review">Needs review</option>
                    <option value="junk">Junk</option>
                    {cats.map((c) => <option key={c.id} value={`category:${c.id}`}>{c.name}</option>)}
                  </select>
                  <button type="submit" className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-fg">Move</button>
                  <p className="basis-full text-xs text-muted">Security mail (Auth) cannot be moved to Junk, Needs review or a category. If your selection includes some, it stays where it is and the rest are moved.</p>
                </fieldset>
              ) : null}
            </form>
          )}
        </section>
        <aside aria-label="Message preview"><Preview pv={pv} path={path} sp={sp} /></aside>
      </div>
    </div>
  );
}
