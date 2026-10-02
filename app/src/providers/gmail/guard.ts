// Allow-list for every Gmail API request this app can make. Anything not listed is refused BEFORE
// it reaches the network: no DELETE, no trash/untrash, no send, no SPAM or TRASH labels.
export class GmailGuardError extends Error {
  constructor(msg: string) {
    super(`Gmail request refused: ${msg}`);
    this.name = "GmailGuardError";
  }
}
export class GmailReadOnlyViolation extends GmailGuardError {
  constructor(what: string) {
    super(`read-only (Preview mode) does not allow ${what}`);
    this.name = "GmailReadOnlyViolation";
  }
}

export const OUR_LABEL_NAMES = ["Jev/Auth", "Jev/Needs review", "Jev/Junk"] as const;
export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";

export interface GuardContext {
  readOnly: boolean;
  /** Ids of our own Jev/* labels. Only these (and INBOX) may ever be added or removed. */
  allowedLabelIds: () => ReadonlySet<string>;
}

const FORBIDDEN_LABEL = /^(SPAM|TRASH)$/i;
const FORBIDDEN_PATH = /(trash|untrash|delete|send|import|insert|drafts|threads|settings|watch|stop)/i;

export function checkGmailRequest(method: string, path: string, query: Record<string, string | number | boolean | undefined>, body: unknown, ctx: GuardContext): void {
  const m = method.toUpperCase();
  if (path.startsWith("/") || path.includes("..") || path.includes("?")) throw new GmailGuardError("malformed path");
  // Only the resource names are checked (segments 0 and 2); ids in segment 1 are opaque.
  if (FORBIDDEN_PATH.test([path.split("/")[0], path.split("/")[2] ?? ""].join(" ")) || /batchDelete/i.test(path)) throw new GmailGuardError(`path "${path}" is not allowed (this app never deletes, trashes or sends)`);
  if (m === "DELETE" || m === "PUT" || m === "PATCH") throw new GmailGuardError(`${m} is never allowed`);
  if (m !== "GET" && m !== "POST") throw new GmailGuardError(`method ${m} is not allowed`);

  const parts = path.split("/");
  if (m === "GET") {
    const ok =
      path === "profile" || path === "labels" || (parts[0] === "labels" && parts.length === 2) ||
      path === "messages" || (parts[0] === "messages" && parts.length === 2) || path === "history";
    if (!ok) throw new GmailGuardError(`GET ${path} is not on the allow-list`);
    if (String(query.includeSpamTrash ?? "").toLowerCase() === "true") throw new GmailGuardError("SPAM and TRASH are never read");
    const ids = String(query.labelIds ?? "").split(",").filter(Boolean).concat(String(query.labelId ?? "").split(",").filter(Boolean));
    if (ids.some((l) => FORBIDDEN_LABEL.test(l))) throw new GmailGuardError("SPAM and TRASH are never read");
    return;
  }

  // POST
  if (ctx.readOnly) throw new GmailReadOnlyViolation(`POST ${path}`);
  if (path === "labels") {
    const name = (body as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string" || !(OUR_LABEL_NAMES as readonly string[]).includes(name)) throw new GmailGuardError("only the Jev labels may be created");
    return;
  }
  const isModify = (parts[0] === "messages" && parts.length === 3 && parts[2] === "modify") || path === "messages/batchModify";
  if (!isModify) throw new GmailGuardError(`POST ${path} is not on the allow-list`);
  const b = (body ?? {}) as { addLabelIds?: unknown; removeLabelIds?: unknown; ids?: unknown };
  const allowed = ctx.allowedLabelIds();
  for (const list of [b.addLabelIds, b.removeLabelIds]) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new GmailGuardError("malformed label list");
    for (const id of list as string[]) {
      if (FORBIDDEN_LABEL.test(id)) throw new GmailGuardError("the SPAM and TRASH labels are never touched");
      if (id !== "INBOX" && !allowed.has(id)) throw new GmailGuardError(`label "${id}" is not one of ours`);
    }
  }
  if (path === "messages/batchModify" && (!Array.isArray(b.ids) || b.ids.length > 100)) throw new GmailGuardError("batchModify needs 1-100 ids");
}
