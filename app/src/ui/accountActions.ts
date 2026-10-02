// Account and sync actions for the UI (called by server actions and tests).
import { ConnectionReport, NewAccountInput } from "../accounts/service";
import { describeSync } from "../sync/sync";
import { Runtime } from "../runtime/runtime";
import type { ApplyPlan } from "../runtime/runtime";
import { Notice } from "./actions";

export const JEV_BANNER = "jev.ai not connected — deterministic rules only";
export const JEV_BANNER_DETAIL =
  "Auth mail is recognised and filed. Everything else stays where it is or goes to Needs review. Nothing is junked until jev.ai is connected.";

export async function testAccount(rt: Runtime, input: NewAccountInput): Promise<Notice & { token?: string }> {
  const r = await rt.service.testConnection(input);
  if (!r.ok) return { kind: "error", text: `Connection test failed: ${r.error}` };
  return { kind: "ok", text: "Connection works. Nothing on your mailbox was changed. Review the details below, then confirm to save the account (it starts in Preview mode).", token: r.token };
}

export async function confirmAccount(rt: Runtime, token: string): Promise<Notice> {
  const r = await rt.service.confirm(token);
  if (!r.ok) return { kind: "error", text: r.error };
  return { kind: "ok", text: `${r.account.email} added in Preview mode. Nothing has been created or moved on your mailbox. Press Sync now to see where each message would go.` };
}

export function cancelAccount(rt: Runtime, token: string): Notice {
  rt.service.discard(token);
  return { kind: "info", text: "Cancelled. Nothing was saved." };
}

export async function removeAccount(rt: Runtime, accountId: string): Promise<Notice> {
  const r = await rt.service.remove(accountId);
  if (!r.ok) return { kind: "error", text: r.error };
  return { kind: "ok", text: `Account removed. Deleted the stored password and ${r.messages} local message record${r.messages === 1 ? "" : "s"}. Mail on the server was not touched.` };
}

export async function syncNow(rt: Runtime): Promise<Notice> {
  if (!rt.isLive) return { kind: "info", text: "You are looking at the demo mailbox. Add an account in Settings to sync real mail." };
  const s = await rt.sync.syncAll();
  return { kind: s.some((x) => x.error) ? "error" : "ok", text: describeSync(s) };
}

export function pendingReport(rt: Runtime, token: string): ConnectionReport | null {
  return rt.service.pendingReport(token);
}

/** Poll every 5 minutes while the app runs. Safe to call more than once. */
export function startBackgroundSync(rt: Runtime, everyMs = 5 * 60 * 1000): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.__jevPoll_v2) return;
  const t = setInterval(() => {
    if (rt.isLive) void rt.sync.syncAll().catch(() => undefined);
  }, everyMs);
  t.unref?.();
  g.__jevPoll_v2 = t;
}


export const PREVIEW_BANNER = "Preview mode: nothing has been moved on your mailbox. Messages are shown where they would be filed.";

export function applyPlan(rt: Runtime, accountId: string): ApplyPlan | null {
  return rt.applyPlan(accountId);
}

export function describePlan(p: ApplyPlan): string {
  const moves = `${p.authToMove} Auth message${p.authToMove === 1 ? "" : "s"} will move to ${p.willCreate[0] ?? "Jev Auth"}.`;
  return `${moves} Nothing will be junked or deleted.`;
}

/** Turn preview off: create the Jev folders, then move the Auth mail already recorded. */
export async function applyFiling(rt: Runtime, accountId: string): Promise<Notice> {
  const r = await rt.applyFiling(accountId);
  if (!r.ok) return { kind: "error", text: r.error };
  const made = r.created.length ? ` Created folders: ${r.created.join(", ")}.` : "";
  return { kind: "ok", text: `Preview mode is off.${made} Moved ${r.moved} Auth message${r.moved === 1 ? "" : "s"} to Jev Auth. Nothing was junked or deleted.${r.failed ? ` ${r.failed} could not be moved.` : ""}` };
}

/** Turn preview back on: future syncs stop moving. Past moves are not undone. */
export function previewOn(rt: Runtime, accountId: string): Notice {
  if (!rt.accounts.get(accountId)) return { kind: "error", text: "Unknown account." };
  rt.setPreview(accountId, true);
  return { kind: "ok", text: "Preview mode is on. Future syncs will not move anything. Mail that was already moved stays where it is." };
}
