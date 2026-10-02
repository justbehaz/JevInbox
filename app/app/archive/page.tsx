import Workspace from "../../components/Workspace";
import { SP } from "../../components/Notice";

export default async function ArchivePage({ searchParams }: { searchParams: Promise<SP> }) {
  return <Workspace title="Archive" path="/archive" view={{ kind: "archived" }} sp={await searchParams} bulk={false}
    intro={<p className="mb-3 text-sm text-muted">Archived mail lives in your provider&apos;s Archive folder. Archiving is not deleting.</p>} />;
}
