import Link from "next/link";
import { getAppState } from "../src/ui/state";
import { navData } from "../src/ui/actions";
import NavLink from "./NavLink";
import ThemeToggle from "./ThemeToggle";

function Count({ n, unread, label }: { n: number; unread: number; label: string }) {
  return (
    <span className="text-xs text-muted" aria-label={`${n} messages${unread ? `, ${unread} unread` : ""} in ${label}`}>
      {unread ? <strong className="text-fg">{unread}</strong> : null}{unread ? " / " : ""}{n}
    </span>
  );
}

export default async function Shell({ children }: { children: React.ReactNode }) {
  const nav = navData(await getAppState());
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line bg-card px-4 py-2">
        <Link href="/" className="text-lg font-bold">Jev Inbox</Link>
        <p className="hidden text-xs text-muted sm:block">Demo mailbox. No account is connected and nothing is saved.</p>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/settings" className="rounded border border-line px-3 py-1 text-sm hover:bg-sel">Settings</Link>
        </div>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <nav aria-label="Mailboxes" className="w-full shrink-0 border-b border-line bg-card p-3 md:w-64 md:border-b-0 md:border-r">
          <ul className="space-y-0.5">
            <li><NavLink href="/"><span>Inbox</span><Count n={nav.buckets.inbox.count} unread={nav.buckets.inbox.unread} label="Inbox" /></NavLink></li>
          </ul>
          <h2 className="mb-1 mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-muted">System</h2>
          <ul className="space-y-0.5">
            <li><NavLink href="/auth"><span>Auth</span><Count n={nav.buckets.auth.count} unread={nav.buckets.auth.unread} label="Auth" /></NavLink></li>
            <li><NavLink href="/needs-review"><span>Needs review</span><Count n={nav.buckets.needsReview.count} unread={nav.buckets.needsReview.unread} label="Needs review" /></NavLink></li>
            <li><NavLink href="/junk"><span>Junk</span><Count n={nav.buckets.junk.count} unread={nav.buckets.junk.unread} label="Junk" /></NavLink></li>
            <li><NavLink href="/archive"><span>Archive</span><Count n={nav.buckets.archived.count} unread={nav.buckets.archived.unread} label="Archive" /></NavLink></li>
          </ul>
          <h2 className="mb-1 mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-muted">People</h2>
          <ul><li><NavLink href="/senders"><span>Senders</span></NavLink></li></ul>
          <h2 className="mb-1 mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-muted">Categories</h2>
          <ul className="space-y-0.5">
            {nav.categories.map((c) => (
              <li key={c.id}><NavLink href={`/category/${c.id}`}><span>{c.name}</span><Count n={c.count} unread={c.unread} label={c.name} /></NavLink></li>
            ))}
          </ul>
          <p className="mt-3 px-3 text-sm"><NavLink href="/categories">Manage categories</NavLink></p>
        </nav>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4">{children}</main>
      </div>
    </div>
  );
}
