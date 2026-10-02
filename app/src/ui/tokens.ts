// A message is addressed in URLs and forms by its current folder and provider id.
export function encodeToken(folder: string, id: string): string {
  return Buffer.from(JSON.stringify([folder, id])).toString("base64url");
}
export function decodeToken(token: string): { folder: string; id: string } | null {
  try {
    const [folder, id] = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return typeof folder === "string" && typeof id === "string" ? { folder, id } : null;
  } catch {
    return null;
  }
}
