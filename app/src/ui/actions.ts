// UI action layer. Every function here is called by server actions and by tests. It contains no
// gate logic: classification stays in src/gate, moves go through the adapter, and the sender
// rules live in the sender store. What it adds is the user-facing protection copy from 05-screens.md.
import { MoveResult } from "../providers/types";
import { MarkJunkResult, StoredBucket, StoredMessage } from "../senders/store";
import { routedMover, toStoredBucket } from "../senders/wiring";
import { AppState } from "./state";
import { decodeToken, encodeToken } from "./tokens";

export type Kind = "ok" | "error" | "info";
export interface Notice { kind: Kind; text: string }

export const AUTH_IMMUTABLE_COPY = "Security mail cannot be moved from Auth.";
export const SECURITY_SHAPE_COPY = "This looks like security mail, so it stays out of Junk.";
export const JUNK_BANNER =
  "Security mail (Auth) is never in this folder. Jev Inbox never deletes mail. You can mark a message Not junk, keep it here, or archive it.";
export const MARK_JUNK_NOTE =
  "IMPORTANT: Security alerts and password resets from this sender will ALWAYS go to your Auth folder, not Junk. You cannot silence security mail by marking a sender junk.";

// ------------------------------------------------------------------ reading
export interface NavData {
  buckets: { auth: Count; needsReview: Count; junk: Count; archived: Count; inbox: Count };
  categories: Array<{ id: string; name: string; count: number; unread: number }>;
}
interface Count { count: number; unread: number }

export function navData(st: AppState): NavData {
  const c = st.store.bucketCounts();
  const z: Count = { count: 0, unread: 0 };
  const inboxCount = st.store.query({ hideMuted: true, excludeBuckets: ["junk", "archived"] });
  return {
    buckets: {
      auth: c.buckets.auth ?? z,
      needsReview: c.buckets.needs_review ?? z,
      junk: c.buckets.junk ?? z,
      archived: c.buckets.archived ?? z,
      inbox: { count: inboxCount.length, unread: inboxCount.filter((m) => m.unread).length },
    },
    categories: st.categories.enabled().map((cat) => ({ id: cat.id, name: cat.name, count: c.categories[cat.id]?.count ?? 0, unread: c.categories[cat.id]?.unread ?? 0 })),
  };
}

export type View =
  | { kind: "inbox" }
  | { kind: "auth" }
  | { kind: "junk" }
  | { kind: "needs_review" }
  | { kind: "archived" }
  | { kind: "category"; id: string }
  | { kind: "sender"; key: string };

export interface Row extends StoredMessage { token: string; categoryName: string | null; protectedMail: boolean }

export function listView(st: AppState, view: View): Row[] {
  let rows: StoredMessage[];
  switch (view.kind) {
    case "inbox": rows = st.store.query({ hideMuted: true, excludeBuckets: ["junk", "archived"] }); break;
    case "auth": rows = st.store.query({ bucket: "auth" }); break;
    case "junk": rows = st.store.query({ bucket: "junk" }); break;
    case "needs_review": rows = st.store.query({ bucket: "needs_review", hideMuted: true }); break;
    case "archived": rows = st.store.query({ bucket: "archived" }); break;
    case "category": rows = st.store.query({ bucket: "category", categoryId: view.id, hideMuted: true }); break;
    case "sender": rows = st.store.query({ senderKey: view.key }); break; // single source of truth: never filtered
  }
  return rows.map((m) => toRow(st, m));
}

function toRow(st: AppState, m: StoredMessage): Row {
  return {
    ...m,
    token: encodeToken(m.accountId, m.folder, m.messageId),
    categoryName: m.categoryId ? st.categories.nameOf(m.categoryId) : null,
    protectedMail: st.store.isProtected(m.accountId, m.folder, m.messageId),
  };
}

export interface Preview {
  row: Row;
  from: string;
  replyTo?: string;
  date: string;
  authenticationResults?: string;
  snippet: string;
  whyFiled: string;
}

const REASONS: Record<string, string> = {
  deterministic_auth: "It looks like an authentication or account-security message (code, reset, or login alert).",
  jev_auth_yes: "jev.ai is confident this is an authentication or account-security message.",
  jev_auth_low_confidence: "jev.ai was not sure whether this is security mail, so it was sent to Needs review.",
  security_shape_backstop: "It has the shape of security mail (a code or sign-in wording), so it was kept out of Junk and sent to Needs review.",
  user_marked_junk: "You marked this sender as junk.",
  sender_marked_junk: "You marked this sender as junk.",
  jev_junk: "jev.ai is very confident this is unwanted mail.",
  category_match: "It matches this category.",
  no_category_match: "No category matched with enough confidence.",
  provider_error: "jev.ai could not be reached, so it was sent to Needs review.",
  user_filed: "You filed it here.",
  user_not_junk: "You marked it Not junk.",
  security_override: "It looked like security mail, so it was kept out of Junk.",
};

export async function preview(st: AppState, token: string): Promise<Preview | null> {
  const t = decodeToken(token);
  if (!t) return null;
  const m = st.store.getMessage(t.accountId, t.folder, t.id);
  if (!m) return null;
  const row = toRow(st, m);
  let detail;
  try {
    detail = await (await st.adapterFor(m.accountId)).fetchHeadersAndSnippet(m.folder, m.messageId);
  } catch {
    return { row, from: m.senderKey, date: m.date, snippet: m.snippet, whyFiled: why(m.reason) };
  }
  return {
    row, from: detail.from, replyTo: detail.replyTo, date: detail.date.toISOString(),
    authenticationResults: detail.authenticationResults, snippet: detail.snippet, whyFiled: why(m.reason),
  };
}
const why = (r: string | null) => (r && REASONS[r]) || "Filed by Jev Inbox.";

// ------------------------------------------------------------------ moving
export type MoveTarget = "junk" | "needs_review" | "archive" | { category: string };

export interface MoveSummary extends Notice {
  moved: number;
  blocked: Array<{ token: string; reason: string }>;
  failed: number;
}

/** Perform one provider move and mirror the result into the sender store. */
async function relocate(st: AppState, m: StoredMessage, dest: "junk" | "needs_review" | "archive" | "auth" | "category", categoryId: string | null, reason: string): Promise<{ ok: boolean; bucket?: StoredBucket }> {
  let r: MoveResult;
  try {
    const adapter = await st.adapterFor(m.accountId);
    if (dest === "category") r = await adapter.moveToInbox(m.folder, m.messageId);
    else r = await adapter.moveToBucket(m.folder, m.messageId, dest);
  } catch {
    return { ok: false }; // could not reach the account; nothing was changed
  }
  if (!r.success) return { ok: false };
  // junk may have been redirected (adapter guard / fallback): trust what the adapter actually did
  let bucket: StoredBucket;
  if (dest === "category") bucket = "category";
  else if (!r.moved && r.bucketUsed === null) return { ok: false }; // no usable folder: left in place
  else bucket = toStoredBucket(r.bucketUsed) ?? "needs_review";
  st.store.updateLocation(m.accountId, m.folder, m.messageId, {
    bucket,
    categoryId: bucket === "category" ? categoryId : null,
    newMessageId: r.moved ? r.newMessageId : undefined,
    folder: r.moved ? r.destination : undefined,
    reason,
  });
  return { ok: true, bucket };
}

/**
 * Move messages (manual and bulk). Auth mail is immutable: it cannot go to Junk, Needs review or a
 * category. Security-shaped mail cannot go to Junk. Archive is allowed for everything (not a delete).
 */
export async function moveMessages(st: AppState, tokens: string[], target: MoveTarget): Promise<MoveSummary> {
  const blocked: MoveSummary["blocked"] = [];
  let moved = 0;
  let failed = 0;
  let authBlocked = 0;
  const targetName = target === "junk" ? "Junk" : target === "needs_review" ? "Needs review" : target === "archive" ? "Archive" : "that category";

  for (const token of tokens) {
    const t = decodeToken(token);
    const m = t ? st.store.getMessage(t.accountId, t.folder, t.id) : null;
    if (!m) { failed++; continue; }

    if (target !== "archive" && m.bucket === "auth") {
      blocked.push({ token, reason: AUTH_IMMUTABLE_COPY });
      authBlocked++;
      continue;
    }
    if (target === "junk" && st.store.isProtected(m.accountId, m.folder, m.messageId)) {
      blocked.push({ token, reason: SECURITY_SHAPE_COPY });
      continue;
    }
    let res;
    if (target === "junk") res = await relocate(st, m, "junk", null, "user_filed");
    else if (target === "needs_review") res = await relocate(st, m, "needs_review", null, "user_filed");
    else if (target === "archive") res = await relocate(st, m, "archive", null, "user_filed");
    else {
      if (!st.categories.get(target.category)?.enabled) { failed++; continue; }
      res = await relocate(st, m, "category", target.category, "user_filed");
    }
    if (res.ok) moved++; else failed++;
  }

  let text: string;
  let kind: Kind = "ok";
  if (blocked.length && !moved) {
    text = blocked.length === 1 ? blocked[0].reason : `${blocked.length} messages are security mail and cannot be moved to ${targetName}.`;
    kind = "error";
  } else if (blocked.length) {
    text = authBlocked
      ? `Moved ${moved} message${moved === 1 ? "" : "s"}. ${authBlocked} Auth message${authBlocked === 1 ? "" : "s"} stay${authBlocked === 1 ? "s" : ""} in Auth.`
      : `Moved ${moved} message${moved === 1 ? "" : "s"}. ${blocked.length} looked like security mail and stayed out of Junk.`;
    kind = "info";
  } else if (failed && !moved) {
    text = `Could not move ${failed === 1 ? "that message" : `${failed} messages`}.`;
    kind = "error";
  } else {
    text = `Moved ${moved} message${moved === 1 ? "" : "s"} to ${targetName}.`;
  }
  return { kind, text, moved, blocked, failed };
}

// ------------------------------------------------------------------ queues
export type JunkAction = "not_junk" | "keep" | "archive";

/** Junk queue: only Not junk, Keep in Junk and Archive exist. There is no delete. */
export async function junkQueueAction(st: AppState, token: string, action: JunkAction, opts: { allowSender?: boolean } = {}): Promise<Notice> {
  const t = decodeToken(token);
  const m = t ? st.store.getMessage(t.accountId, t.folder, t.id) : null;
  if (!m) return { kind: "error", text: "That message is no longer here." };
  if (m.bucket !== "junk") return { kind: "error", text: "That message is not in Junk." };
  if (action === "keep") return { kind: "info", text: "Kept in Junk." };
  if (action === "archive") {
    const r = await relocate(st, m, "archive", null, "user_filed");
    return r.ok ? { kind: "ok", text: "Archived. Archiving is not deleting; you can find it in your Archive." } : { kind: "error", text: "Could not archive that message." };
  }
  // not junk: back to its category if it had one, otherwise Needs review
  const catId = m.categoryId && st.categories.get(m.categoryId)?.enabled ? m.categoryId : null;
  const r = catId ? await relocate(st, m, "category", catId, "user_not_junk") : await relocate(st, m, "needs_review", null, "user_not_junk");
  if (!r.ok) return { kind: "error", text: "Could not restore that message." };
  let text = catId ? "Restored to its category." : "Restored to Needs review.";
  if (opts.allowSender) {
    st.store.allow(m.senderKey);
    text += ` ${m.senderKey} is now allowed; future mail will be filed normally.`;
  }
  return { kind: "ok", text };
}

/** Needs review: one click files a message into a category or Auth. */
export async function fileFromReview(st: AppState, token: string, target: { category: string } | "auth"): Promise<Notice> {
  const t = decodeToken(token);
  const m = t ? st.store.getMessage(t.accountId, t.folder, t.id) : null;
  if (!m) return { kind: "error", text: "That message is no longer here." };
  if (m.bucket !== "needs_review") return { kind: "error", text: "That message is not in Needs review." };
  if (target === "auth") {
    const r = await relocate(st, m, "auth", null, "user_filed");
    return r.ok ? { kind: "ok", text: "Filed as Auth." } : { kind: "error", text: "Could not file that message." };
  }
  const cat = st.categories.get(target.category);
  if (!cat || !cat.enabled) return { kind: "error", text: "That category is not available." };
  const r = await relocate(st, m, "category", cat.id, "user_filed");
  return r.ok ? { kind: "ok", text: `Filed under ${cat.name}.` } : { kind: "error", text: "Could not file that message." };
}

// ------------------------------------------------------------------ senders
export function senderAllow(st: AppState, key: string): Notice {
  try { st.store.allow(key); } catch { return { kind: "error", text: "Unknown sender." }; }
  return { kind: "ok", text: `${key} is now allowed. Future mail is exempt from Junk and filed normally; mail already filed stays where it is.` };
}
export function senderUnallow(st: AppState, key: string): Notice {
  try { st.store.unallow(key); } catch { return { kind: "error", text: "Unknown sender." }; }
  return { kind: "ok", text: `${key} is no longer on the allow list.` };
}
export function senderMute(st: AppState, key: string, on: boolean): Notice {
  try { on ? st.store.mute(key) : st.store.unmute(key); } catch { return { kind: "error", text: "Unknown sender." }; }
  return { kind: "ok", text: on ? `${key} is muted. Its mail is hidden from your lists, nothing is moved, and security mail is never hidden.` : `${key} is no longer muted.` };
}
export function senderUnmarkJunk(st: AppState, key: string): Notice {
  try { st.store.unmarkJunk(key); } catch { return { kind: "error", text: "Unknown sender." }; }
  return { kind: "ok", text: `${key} is no longer marked junk. Mail already in Junk stays there.` };
}
export function describeMarkJunk(key: string, r: MarkJunkResult): string {
  const parts = [`${key} is now marked junk. Future mail will go to Junk.`, `Moved ${r.moved} message${r.moved === 1 ? "" : "s"} to Junk.`];
  const stay = r.skippedAuth + r.skippedSecurityShape;
  if (stay) parts.push(`${stay} security message${stay === 1 ? "" : "s"} stay${stay === 1 ? "s" : ""} where ${stay === 1 ? "it is" : "they are"} (Auth is never moved to Junk).`);
  if (r.failed) parts.push(`${r.failed} could not be moved.`);
  return parts.join(" ");
}
export async function senderMarkJunk(st: AppState, key: string): Promise<Notice> {
  try {
    const r = await st.store.markJunk(key, routedMover((id) => st.adapterFor(id)));
    return { kind: r.failed ? "info" : "ok", text: describeMarkJunk(key, r) };
  } catch {
    return { kind: "error", text: "Unknown sender." };
  }
}

// ------------------------------------------------------------------ categories
export function addCategory(st: AppState, name: string): Notice {
  const r = st.categories.add(name);
  return r.ok ? { kind: "ok", text: `Added "${r.category!.name}".` } : { kind: "error", text: r.error };
}
export function setCategoryEnabled(st: AppState, id: string, enabled: boolean): Notice {
  const r = st.categories.setEnabled(id, enabled);
  if (!r.ok) return { kind: "error", text: r.error };
  return { kind: "ok", text: `${r.category!.name} ${enabled ? "enabled" : "disabled"}. ${enabled ? "" : "It still counts toward the 48-category limit until you delete it."}`.trim() };
}
/** Delete a disabled category. Its messages go to Needs review; nothing is deleted. */
export async function deleteCategory(st: AppState, id: string): Promise<Notice> {
  const cat = st.categories.get(id);
  if (!cat) return { kind: "error", text: "Unknown category." };
  if (cat.enabled) return { kind: "error", text: "Disable a category before deleting it." };
  const rows = st.store.query({ bucket: "category", categoryId: id });
  let moved = 0;
  for (const m of rows) if ((await relocate(st, m, "needs_review", null, "category_deleted")).ok) moved++;
  if (moved < rows.length) return { kind: "error", text: "Some messages could not be moved to Needs review, so the category was kept." };
  st.categories.remove(id);
  return { kind: "ok", text: `Deleted "${cat.name}". ${moved} message${moved === 1 ? "" : "s"} moved to Needs review; none were deleted.` };
}
