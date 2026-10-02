import { Row } from "../src/ui/actions";

export function Badge({ row }: { row: Row }) {
  const base = "rounded px-1.5 py-0.5 text-xs font-medium border";
  if (row.bucket === "auth") return <span className={`${base} border-accent text-accent`} aria-label="Security mail (Auth), cannot be moved">Auth</span>;
  if (row.bucket === "junk") return <span className={`${base} border-danger text-danger`}>Junk</span>;
  if (row.bucket === "needs_review") return <span className={`${base} border-warn text-warn`}>Needs review</span>;
  if (row.bucket === "archived") return <span className={`${base} border-line text-muted`}>Archived</span>;
  return <span className={`${base} border-line text-muted`} aria-label={`Category: ${row.categoryName ?? "none"}`}>{row.categoryName ?? "Inbox"}</span>;
}

