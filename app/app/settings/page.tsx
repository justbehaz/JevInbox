import { addAccountAction } from "../actions";
import Notice, { SP } from "../../components/Notice";

const input = "w-full rounded border border-line bg-bg px-2 py-1 text-sm";
const submit = "rounded bg-accent px-3 py-1 text-sm font-medium text-accent-fg";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  return (
    <div className="max-w-3xl">
      <Notice sp={sp} />
      <h1 className="mb-1 text-xl font-bold">Settings</h1>

      <section aria-labelledby="acct-h" className="mt-4">
        <h2 id="acct-h" className="mb-1 text-lg font-semibold">Add account</h2>
        <p className="mb-3 text-sm text-muted">Preview only. Nothing you type here is saved or sent anywhere yet; the demo mailbox stays loaded.</p>

        <div className="space-y-3">
          <details className="rounded border border-line bg-card p-3" open>
            <summary className="cursor-pointer font-medium">iCloud Mail</summary>
            <form action={addAccountAction} className="mt-3 space-y-2" aria-label="Add iCloud account">
              <input type="hidden" name="provider" value="icloud" /><input type="hidden" name="returnTo" value="/settings" />
              <ol className="list-decimal pl-5 text-sm text-muted">
                <li>Sign in at account.apple.com and open Sign-In and Security.</li>
                <li>Choose App-Specific Passwords and generate one named &ldquo;Jev Inbox&rdquo;. Two-factor authentication must be on.</li>
                <li>Paste that password below. Never use your Apple Account password.</li>
              </ol>
              <p className="text-xs text-muted">Server: imap.mail.me.com, port 993, TLS.</p>
              <div><label htmlFor="ic-email" className="block text-sm">iCloud email address</label><input id="ic-email" className={input} type="email" autoComplete="off" /></div>
              <div><label htmlFor="ic-pass" className="block text-sm">App-specific password</label><input id="ic-pass" className={input} type="password" autoComplete="off" /></div>
              <button type="submit" className={submit}>Add iCloud account</button>
            </form>
          </details>

          <details className="rounded border border-line bg-card p-3">
            <summary className="cursor-pointer font-medium">Other IMAP</summary>
            <form action={addAccountAction} className="mt-3 space-y-2" aria-label="Add IMAP account">
              <input type="hidden" name="provider" value="imap" /><input type="hidden" name="returnTo" value="/settings" />
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="sm:col-span-2"><label htmlFor="im-host" className="block text-sm">Host</label><input id="im-host" className={input} autoComplete="off" /></div>
                <div><label htmlFor="im-port" className="block text-sm">Port</label><input id="im-port" className={input} inputMode="numeric" defaultValue="993" /></div>
              </div>
              <div><label htmlFor="im-tls" className="block text-sm">Encryption</label>
                <select id="im-tls" className={input} defaultValue="implicit"><option value="implicit">TLS (implicit)</option><option value="starttls">STARTTLS</option></select>
                <p className="mt-1 text-xs text-muted">Unencrypted connections are not supported.</p></div>
              <div><label htmlFor="im-user" className="block text-sm">Username</label><input id="im-user" className={input} autoComplete="off" /></div>
              <div><label htmlFor="im-pass" className="block text-sm">Password or app password</label><input id="im-pass" className={input} type="password" autoComplete="off" />
                <p className="mt-1 text-xs text-muted">If the server supports XOAUTH2 it will be used instead when a token is available.</p></div>
              <button type="submit" className={submit}>Add IMAP account</button>
            </form>
          </details>

          <div className="rounded border border-line bg-card p-3">
            <p className="font-medium">Gmail <span className="ml-2 rounded border border-line px-2 py-0.5 text-xs text-muted">Coming soon</span></p>
            <p className="text-sm text-muted">Needs Google verification before a public release.</p>
          </div>
          <div className="rounded border border-line bg-card p-3">
            <p className="font-medium">Outlook <span className="ml-2 rounded border border-line px-2 py-0.5 text-xs text-muted">Coming soon</span></p>
            <p className="text-sm text-muted">Will use Microsoft Graph.</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="thr-h" className="mt-8">
        <h2 id="thr-h" className="mb-1 text-lg font-semibold">How mail is filed</h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded border border-line bg-card p-3 text-sm">
          <dt>Auth confidence needed to file as Auth</dt><dd>80 (fixed)</dd>
          <dt>Auth &ldquo;no&rdquo; confidence needed before jev.ai may junk</dt><dd>90 (fixed)</dd>
          <dt>Junk confidence needed</dt><dd>90 (fixed)</dd>
          <dt>jev.ai</dt><dd>Demo stand-in (scripted)</dd>
        </dl>
        <p className="mt-2 text-xs text-muted">If jev.ai cannot be reached, mail goes to Needs review, never Junk.</p>
      </section>
    </div>
  );
}
