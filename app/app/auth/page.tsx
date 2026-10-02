import Workspace from "../../components/Workspace";
import { SP } from "../../components/Notice";

export default async function AuthPage({ searchParams }: { searchParams: Promise<SP> }) {
  return <Workspace title="Auth" path="/auth" view={{ kind: "auth" }} sp={await searchParams}
    intro={<p className="mb-3 text-sm text-muted">Authenticator codes, one-time passwords, verification links, password resets and login alerts. This mail is never filed as Junk and cannot be moved there.</p>} />;
}
