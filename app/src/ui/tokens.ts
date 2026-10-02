// A message is addressed in URLs and forms by its account, current folder and provider id.
export function encodeToken(accountId: string, folder: string, id: string): string {
  return Buffer.from(JSON.stringify([accountId, folder, id])).toString("base64url");
}
export function decodeToken(token: string): { accountId: string; folder: string; id: string } | null {
  try {
    const [accountId, folder, id] = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return typeof accountId === "string" && typeof folder === "string" && typeof id === "string" ? { accountId, folder, id } : null;
  } catch {
    return null;
  }
}
