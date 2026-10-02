import Workspace from "../components/Workspace";
import { SP } from "../components/Notice";

export default async function Inbox({ searchParams }: { searchParams: Promise<SP> }) {
  return <Workspace title="Inbox" path="/" view={{ kind: "inbox" }} sp={await searchParams}
    intro={<p className="mb-3 text-sm text-muted">Everything except Junk and Archive. Muted senders are hidden here, but security mail is never hidden.</p>} />;
}
