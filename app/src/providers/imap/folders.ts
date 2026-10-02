import { BucketName } from "../types";
import { FolderInfo } from "./transport";

export const DEFAULT_BUCKET_FOLDERS: Record<BucketName, string> = {
  auth: "Jev Auth",
  junk: "Jev Junk",
  needs_review: "Jev Needs review",
  archive: "Archive",
};

const SPAM_SPECIAL_USE = new Set(["\\junk", "\\trash"]);
const SPAM_NAME_RE =
  /^(junk|spam|junk e-?mail|junk mail|bulk mail?|bulk|trash|deleted( items| messages)?|\[gmail\]\/spam|\[gmail\]\/trash)$/i;

/** True for the provider's own spam/junk/trash folder (by special-use flag or well-known name). */
export function isProviderSpamFolder(path: string, folders: FolderInfo[]): boolean {
  const info = folders.find((f) => f.path === path);
  if (info?.specialUse && SPAM_SPECIAL_USE.has(info.specialUse.toLowerCase())) return true;
  // Any path segment counts: "INBOX/Junk" and "Junk/Jev Junk" are both treated as provider spam.
  return SPAM_NAME_RE.test(path) || path.split(/[/.]/).some((seg) => SPAM_NAME_RE.test(seg.trim()));
}

/** Throws if `path` is, or looks like, the provider's own spam/trash folder. */
export function assertNotProviderSpam(path: string, folders: FolderInfo[]): void {
  if (isProviderSpamFolder(path, folders)) {
    throw new Error(`refusing to write to provider spam/trash folder "${path}"`);
  }
}

/** Validate configured bucket folder names at construction time (before any server contact). */
export function validateBucketNames(names: Record<BucketName, string>): void {
  const seen = new Set<string>();
  for (const [bucket, name] of Object.entries(names)) {
    if (!name.trim()) throw new Error(`empty folder name for ${bucket}`);
    if (isProviderSpamFolder(name, [])) {
      throw new Error(`bucket "${bucket}" cannot use the provider spam/trash folder name "${name}"`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error("bucket folder names must be distinct");
    seen.add(key);
  }
}
