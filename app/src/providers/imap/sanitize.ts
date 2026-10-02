// Keep secrets out of errors and logs. The adapter never logs; this guards error messages that
// bubble up from the library, which could echo credentials or tokens.

export function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join("[redacted]");
  }
  // generic: AUTH PLAIN/XOAUTH2 base64 blobs and Bearer tokens
  out = out.replace(/(XOAUTH2|AUTHENTICATE\s+\w+|Bearer)\s+[A-Za-z0-9+/=._-]{12,}/gi, "$1 [redacted]");
  return out;
}

export class ImapAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapAdapterError";
  }
}

export function safeError(e: unknown, secrets: Array<string | undefined>): ImapAdapterError {
  const msg = e instanceof Error ? e.message : String(e);
  return new ImapAdapterError(scrub(msg, secrets));
}
