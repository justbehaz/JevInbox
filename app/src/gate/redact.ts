// On-device redaction. One-time codes must never leave the device (03-jev-contract.md).

const CODE_RE = /(?<![\w@.])(?:\d{4,10}|\d{3}[ -]\d{3}|\d{2}[ -]\d{2}[ -]\d{2}|\d{4}[ -]\d{4})(?![\w])/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const LINKY = /(reset|verify|confirm|magic|token|signin|sign-in|login|auth|activate|recover|otp|code|key|sig)/i;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{16,}\b/g;

export function redactText(input: string): string {
  let out = input.replace(URL_RE, (u) => {
    const hasQuery = /[?&][^=]+=/.test(u);
    if (LINKY.test(u) || (hasQuery && LONG_TOKEN_RE.test(u)) || /[A-Za-z0-9_-]{16,}/.test(u)) {
      LONG_TOKEN_RE.lastIndex = 0;
      return "[LINK]";
    }
    LONG_TOKEN_RE.lastIndex = 0;
    return u;
  });
  out = out.replace(LONG_TOKEN_RE, "[LINK]");
  out = out.replace(CODE_RE, "[CODE]");
  return out;
}

export function buildSnippet(body: string): string {
  // Redact FIRST, then truncate, so a code cut at the boundary cannot leak.
  return redactText(body).slice(0, 500);
}

/** Belt and braces: true if a standalone 4-8 digit code survives in the outgoing text. */
export function containsCode(text: string): boolean {
  CODE_RE.lastIndex = 0;
  const r = CODE_RE.test(text);
  CODE_RE.lastIndex = 0;
  return r;
}
