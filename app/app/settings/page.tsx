import { applyFilingAction, cancelAccountAction, confirmAccountAction, previewOnAction, removeAccountAction, syncNowAction, testAccountAction } from "../actions";
import Notice, { param, SP } from "../../components/Notice";
import { getRuntime } from "../../src/runtime/runtime";
import { applyPlan, describePlan, JEV_BANNER, JEV_BANNER_DETAIL, pendingReport, PREVIEW_BANNER } from "../../src/ui/accountActions";

const input = "w-full rounded border border-line bg-bg px-2 py-1 text-sm";
const submit = "rounded bg-accent px-3 py-1 text-sm font-medium text-accent-fg";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const rt = await getRuntime();
  const accounts = rt.accounts.list();
  const token = param(sp, "pending");
  const report = token ? pendingReport(rt, token) : null;
  return (
    <div className="max-w-3xl">
      <Notice sp={sp} />
      <h1 className="mb-1 text-xl font-bold">Settings</h1>

      <section aria-labelledby="accts-h" className="mt-4">
        <h2 id="accts-h" className="mb-1 text-lg font-semibold">Your accounts</h2>
        {accounts.length === 0 ? (
          <p className="rounded border border-line bg-card p-3 text-sm text-muted">No account saved. You are looking at the demo mailbox.</p>
        ) : (
          <ul className="space-y-3">
            {accounts.map((a) => (
              <li key={a.id} className="rounded border border-line bg-card p-3">
                <p className="font-medium">{a.email} <span className="ml-2 text-xs text-muted">{a.provider === "icloud" ? "iCloud" : `IMAP (${a.host}:${a.port})`}</span></p>
                <p className="text-sm text-muted">{a.lastSyncAt ? `Last sync ${a.lastSyncAt.slice(0, 16).replace("T", " ")} UTC: ${a.lastSyncNote ?? ""}` : "Not synced yet."}</p>
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  <form action={syncNowAction}><input type="hidden" name="returnTo" value="/settings" /><button type="submit" className="rounded border border-line px-3 py-1 text-sm hover:bg-sel">Sync now</button></form>
                  {a.preview ? (() => {
                    const plan = applyPlan(rt, a.id);
                    return (
                      <details className="rounded border border-accent p-2">
                        <summary className="cursor-pointer text-sm">Preview mode is on &mdash; apply filing to my mailbox&hellip;</summary>
                        <form action={applyFilingAction} className="mt-2 max-w-md space-y-2">
                          <input type="hidden" name="returnTo" value="/settings" /><input type="hidden" name="accountId" value={a.id} />
                          <p className="text-sm">{PREVIEW_BANNER}</p>
                          {a.lastSyncAt ? (
                            <p role="note" className="rounded border border-accent px-2 py-1 text-sm">{plan ? describePlan(plan) : ""}</p>
                          ) : (
                            <p role="note" className="rounded border border-line px-2 py-1 text-sm text-muted">Press Sync now first to see how many messages would move.</p>
                          )}
                          <p className="text-xs text-muted">Applying creates these folders on your mailbox: {plan?.willCreate.join(", ")}. Your other folders, including the server&apos;s Junk, are never written to, and no mail is ever deleted.</p>
                          <button type="submit" className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-fg">Apply filing to my mailbox</button>
                        </form>
                      </details>
                    );
                  })() : (
                    <form action={previewOnAction} className="max-w-md">
                      <input type="hidden" name="returnTo" value="/settings" /><input type="hidden" name="accountId" value={a.id} />
                      <button type="submit" className="rounded border border-line px-3 py-1 text-sm hover:bg-sel">Turn preview back on</button>
                      <p className="mt-1 text-xs text-muted">Stops future moves. It does not undo mail that was already moved.</p>
                    </form>
                  )}
                  <details className="rounded border border-line p-2">
                    <summary className="cursor-pointer text-sm">Remove account&hellip;</summary>
                    <form action={removeAccountAction} className="mt-2 max-w-md space-y-2">
                      <input type="hidden" name="returnTo" value="/settings" /><input type="hidden" name="accountId" value={a.id} />
                      <p role="note" className="rounded border border-warn px-2 py-1 text-sm">This deletes the password stored for this account and the data this app keeps about it on this computer. It does not touch any mail on the server. The Jev folders (Jev Auth, Jev Needs review, Jev Junk) stay on your mailbox, along with any mail already moved into them.</p>
                      <button type="submit" className="rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-sel">Remove {a.email}</button>
                    </form>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted" role="note"><strong>{JEV_BANNER}.</strong> {JEV_BANNER_DETAIL} Passwords are kept in {rt.secrets.kind === "keychain" ? "the macOS Keychain" : "an encrypted file"}; this app&apos;s data lives outside the project folder.</p>
      </section>

      {report ? (
        <section aria-labelledby="test-h" className="mt-6 rounded border border-accent bg-card p-4">
          <h2 id="test-h" className="text-lg font-semibold">Connection test result</h2>
          <p className="mt-1 text-sm">Connected to {report.host}:{report.port} ({report.tls === "implicit" ? "TLS" : "STARTTLS"}) as {report.email}. This test was read-only: nothing on the mailbox was changed.</p>
          <p className="mt-2 text-sm">Capabilities: MOVE {report.capabilities.move ? "yes" : "no"}, IDLE {report.capabilities.idle ? "yes" : "no"}, XOAUTH2 {report.capabilities.xoauth2 ? "yes" : "no"}.</p>
          <h3 className="mt-3 text-sm font-semibold">Folders found ({report.folders.length})</h3>
          <ul className="mt-1 max-h-48 overflow-auto rounded border border-line bg-bg p-2 text-sm" aria-label="Folders found">
            {report.folders.map((f) => <li key={f.path}>{f.path}{f.specialUse ? <span className="ml-2 text-xs text-muted">{f.specialUse}</span> : null}</li>)}
          </ul>
          <p className="mt-3 text-sm">Confirming only saves the account, in <strong>Preview mode</strong>: nothing is created or moved on your mailbox. {report.willCreate.length ? <>Later, when you apply filing, these folders will be created: <strong>{report.willCreate.join(", ")}</strong>. </> : "The Jev folders already exist. "}Your other folders, including the server&apos;s Junk, are never written to, and no mail is ever deleted.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={confirmAccountAction}><input type="hidden" name="token" value={token} /><button type="submit" className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-fg">Confirm and save account (Preview mode)</button></form>
            <form action={cancelAccountAction}><input type="hidden" name="returnTo" value="/settings" /><input type="hidden" name="token" value={token} /><button type="submit" className="rounded border border-line px-3 py-1 text-sm hover:bg-sel">Cancel</button></form>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="acct-h" className="mt-4">
        <h2 id="acct-h" className="mb-1 text-lg font-semibold">Add account</h2>
        <p className="mb-3 text-sm text-muted">Step 1 tests the connection read-only and shows what was found. Nothing is saved or created until you confirm in step 2. Your password is never shown again.</p>

        <div className="space-y-3">
          <details className="rounded border border-line bg-card p-3" open>
            <summary className="cursor-pointer font-medium">iCloud Mail</summary>
            <form action={testAccountAction} className="mt-3 space-y-2" aria-label="Add iCloud account">
              <input type="hidden" name="provider" value="icloud" /><input type="hidden" name="returnTo" value="/settings" />
              <ol className="list-decimal pl-5 text-sm text-muted">
                <li>Sign in at account.apple.com and open Sign-In and Security.</li>
                <li>Choose App-Specific Passwords and generate one named &ldquo;Jev Inbox&rdquo;. Two-factor authentication must be on.</li>
                <li>Paste that password below. Never use your Apple Account password.</li>
              </ol>
              <p className="text-xs text-muted">Server: imap.mail.me.com, port 993, TLS.</p>
              <div><label htmlFor="ic-email" className="block text-sm">iCloud email address</label><input id="ic-email" name="email" required className={input} type="email" autoComplete="off" /></div>
              <div><label htmlFor="ic-pass" className="block text-sm">App-specific password</label><input id="ic-pass" name="password" required className={input} type="password" autoComplete="off" /></div>
              <button type="submit" className={submit}>Test connection</button>
            </form>
          </details>

          <details className="rounded border border-line bg-card p-3">
            <summary className="cursor-pointer font-medium">Other IMAP</summary>
            <form action={testAccountAction} className="mt-3 space-y-2" aria-label="Add IMAP account">
              <input type="hidden" name="provider" value="imap" /><input type="hidden" name="returnTo" value="/settings" />
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="sm:col-span-2"><label htmlFor="im-host" className="block text-sm">Host</label><input id="im-host" name="host" required className={input} autoComplete="off" /></div>
                <div><label htmlFor="im-port" className="block text-sm">Port</label><input id="im-port" name="port" required className={input} inputMode="numeric" defaultValue="993" /></div>
              </div>
              <div><label htmlFor="im-tls" className="block text-sm">Encryption</label>
                <select id="im-tls" name="tls" className={input} defaultValue="implicit"><option value="implicit">TLS (implicit)</option><option value="starttls">STARTTLS</option></select>
                <p className="mt-1 text-xs text-muted">Unencrypted connections are not supported.</p></div>
              <div><label htmlFor="im-user" className="block text-sm">Username (usually your full email address)</label><input id="im-user" name="email" required className={input} autoComplete="off" /></div>
              <div><label htmlFor="im-pass" className="block text-sm">Password or app password</label><input id="im-pass" name="password" required className={input} type="password" autoComplete="off" />
                <p className="mt-1 text-xs text-muted">If the server supports XOAUTH2 it will be used instead when a token is available.</p></div>
              <button type="submit" className={submit}>Test connection</button>
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
          <dt>jev.ai</dt><dd>{rt.isLive ? "Not connected" : "Demo stand-in (scripted)"}</dd>
        </dl>
        <p className="mt-2 text-xs text-muted">If jev.ai cannot be reached, mail goes to Needs review, never Junk.</p>
      </section>
    </div>
  );
}
