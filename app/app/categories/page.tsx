import { categoryAction } from "../actions";
import Notice, { SP } from "../../components/Notice";
import { CATEGORY_CAP } from "../../src/categories/manager";
import { getAppState } from "../../src/ui/state";

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const st = await getAppState();
  const cats = st.categories.list();
  const n = st.categories.count();
  const atCap = n >= CATEGORY_CAP;
  const counts = st.store.bucketCounts(false).categories;
  const defaults = cats.filter((c) => !c.custom);
  const custom = cats.filter((c) => c.custom);
  const btn = "rounded border border-line px-2 py-1 text-xs hover:bg-sel";

  const Row = ({ c }: { c: (typeof cats)[number] }) => (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div className="min-w-0">
        <span className={c.enabled ? "" : "text-muted line-through"}>{c.name}</span>
        <span className="ml-2 text-xs text-muted">{counts[c.id]?.count ?? 0} messages{c.enabled ? "" : " (disabled, still counts toward the limit)"}</span>
      </div>
      <form action={categoryAction} className="flex gap-2">
        <input type="hidden" name="returnTo" value="/categories" /><input type="hidden" name="id" value={c.id} />
        {c.enabled ? (
          <button className={btn} name="action" value="disable" type="submit" aria-label={`Disable ${c.name}`}>Disable</button>
        ) : (
          <>
            <button className={btn} name="action" value="enable" type="submit" aria-label={`Enable ${c.name}`}>Enable</button>
            <button className={`${btn} border-danger text-danger`} name="action" value="delete" type="submit" aria-label={`Delete ${c.name}. Its messages move to Needs review.`}>Delete</button>
          </>
        )}
      </form>
    </li>
  );

  return (
    <div className="max-w-3xl">
      <Notice sp={sp} />
      <h1 className="mb-1 text-xl font-bold">Categories</h1>
      <p className="mb-3 text-sm text-muted">Auth, Junk and Needs review are system buckets and do not count. Disabled categories still count toward the limit until you delete them. Deleting a category moves its messages to Needs review; nothing is deleted.</p>

      <p aria-live="polite" role="status" className={`mb-3 text-lg font-semibold ${atCap ? "text-danger" : ""}`} data-testid="cap-counter">
        {n} of {CATEGORY_CAP} categories used{atCap ? " (limit reached)" : `, ${CATEGORY_CAP - n} free`}
      </p>

      <section aria-labelledby="add-h" className="mb-5 rounded border border-line bg-card p-3">
        <h2 id="add-h" className="mb-2 text-base font-semibold">Add a custom category</h2>
        <form action={categoryAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="returnTo" value="/categories" /><input type="hidden" name="action" value="add" />
          <div>
            <label htmlFor="cat-name" className="block text-sm">Name</label>
            <input id="cat-name" name="name" maxLength={40} required disabled={atCap} aria-describedby="cat-help"
              className="rounded border border-line bg-bg px-2 py-1 text-sm disabled:opacity-50" />
          </div>
          <button type="submit" disabled={atCap} className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-fg disabled:opacity-50">Add category</button>
          <p id="cat-help" className="basis-full text-xs text-muted">{atCap ? `You've reached the ${CATEGORY_CAP}-category limit. Delete a category to add a new one (disabling does not free a slot).` : "Up to 40 characters. Names must be unique."}</p>
        </form>
      </section>

      {custom.length ? (
        <section aria-labelledby="custom-h" className="mb-5">
          <h2 id="custom-h" className="mb-2 text-base font-semibold">Your categories ({custom.length})</h2>
          <ul className="divide-y divide-line rounded border border-line bg-card">{custom.map((c) => <Row key={c.id} c={c} />)}</ul>
        </section>
      ) : null}

      <section aria-labelledby="def-h">
        <h2 id="def-h" className="mb-2 text-base font-semibold">Default categories ({defaults.length})</h2>
        <ul className="divide-y divide-line rounded border border-line bg-card">{defaults.map((c) => <Row key={c.id} c={c} />)}</ul>
      </section>
    </div>
  );
}
