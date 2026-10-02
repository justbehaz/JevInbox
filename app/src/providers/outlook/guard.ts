// Allow-list for every Microsoft Graph request this app can make. Refused BEFORE the network:
// DELETE, the junkemail / deleteditems folders (by alias or by id), and any move whose destination is
// not one of our own folders, inbox or archive.
export class GraphGuardError extends Error {
  constructor(msg: string) {
    super(`Graph request refused: ${msg}`);
    this.name = "GraphGuardError";
  }
}
export class GraphReadOnlyViolation extends GraphGuardError {
  constructor(what: string) {
    super(`read-only (Preview mode) does not allow ${what}`);
    this.name = "GraphReadOnlyViolation";
  }
}

export const OUR_FOLDER_NAMES = ["Jev Auth", "Jev Needs review", "Jev Junk"] as const;
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0/";

export interface GraphGuardContext {
  readOnly: boolean;
  /** Ids of our own folders. */
  ourFolderIds: () => ReadonlySet<string>;
  /** Ids of the mailbox's Junk Email and Deleted Items folders, learned by read-only discovery. */
  forbiddenFolderIds: () => ReadonlySet<string>;
}

const FORBIDDEN_ALIASES = new Set(["junkemail", "deleteditems", "recoverableitemsdeletions", "recoverableitemspurges"]);
export type GQuery = Record<string, string | number | undefined>;

/** `path` is relative to the Graph base (no leading slash, no query). */
export function checkGraphRequest(method: string, path: string, query: GQuery, body: unknown, ctx: GraphGuardContext): void {
  const m = method.toUpperCase();
  if (path.startsWith("/") || path.includes("..") || path.includes("?") || /^https?:/i.test(path)) throw new GraphGuardError("malformed path");
  if (m === "DELETE" || m === "PUT" || m === "PATCH") throw new GraphGuardError(`${m} is never allowed`);
  if (m !== "GET" && m !== "POST") throw new GraphGuardError(`method ${m} is not allowed`);
  const seg = path.split("/");
  const forbidden = ctx.forbiddenFolderIds();

  // Discovery: the only GETs that may mention the junk/deleted folders, and only for their id.
  const isDiscovery = m === "GET" && seg.length === 3 && seg[0] === "me" && seg[1] === "mailFolders" &&
    (seg[2] === "junkemail" || seg[2] === "deleteditems") && String(query.$select ?? "") === "id";
  if (isDiscovery) return;

  if (seg.some((s) => FORBIDDEN_ALIASES.has(s.toLowerCase()))) throw new GraphGuardError("the Junk Email and Deleted Items folders are never touched");
  if (seg.some((s) => forbidden.has(s))) throw new GraphGuardError("that folder is the mailbox Junk or Deleted Items folder; it is never touched");

  if (m === "GET") {
    const ok =
      (seg[0] === "me" && seg[1] === "mailFolders" && seg.length === 2) ||
      (seg[0] === "me" && seg[1] === "mailFolders" && seg.length === 3) ||
      (seg[0] === "me" && seg[1] === "mailFolders" && seg[3] === "messages" && seg.length === 4) ||
      (seg[0] === "me" && seg[1] === "mailFolders" && seg[3] === "messages" && seg[4] === "delta" && seg.length === 5) ||
      (seg[0] === "me" && seg[1] === "messages" && seg.length === 3);
    if (!ok) throw new GraphGuardError(`GET ${path} is not on the allow-list`);
    return;
  }

  // POST
  if (ctx.readOnly) throw new GraphReadOnlyViolation(`POST ${path}`);
  if (path === "me/mailFolders") {
    const name = (body as { displayName?: unknown } | undefined)?.displayName;
    if (typeof name !== "string" || !(OUR_FOLDER_NAMES as readonly string[]).includes(name)) throw new GraphGuardError("only the Jev folders may be created");
    return;
  }
  if (seg[0] === "me" && seg[1] === "messages" && seg.length === 4 && seg[3] === "move") {
    const dest = (body as { destinationId?: unknown } | undefined)?.destinationId;
    if (typeof dest !== "string") throw new GraphGuardError("move needs a destination");
    if (FORBIDDEN_ALIASES.has(dest.toLowerCase()) || forbidden.has(dest)) throw new GraphGuardError("the Junk Email and Deleted Items folders are never a destination");
    if (dest !== "inbox" && dest !== "archive" && !ctx.ourFolderIds().has(dest)) throw new GraphGuardError("destination is not one of our folders");
    return;
  }
  throw new GraphGuardError(`POST ${path} is not on the allow-list`);
}
