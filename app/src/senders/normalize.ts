// Local sender normalisation. A sender is the lowercased From ADDRESS (display names are not
// identity and can be spoofed). Domain rollup groups by registrable-ish root domain.
import { addressOf, domainOf } from "../gate/detect";

export interface NormalizeOptions {
  /** Treat user+tag@host as user@host. Off by default. */
  stripPlusTag?: boolean;
}

export interface SenderId {
  key: string; // normalised address
  domain: string; // full domain of the address
  rootDomain: string; // rollup domain
  displayName: string | null;
}

// Small list of common two-label public suffixes. Good enough for rollups; not a security boundary.
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp",
  "com.br", "co.in", "co.za", "com.mx", "com.tr", "com.sg", "com.hk", "co.kr",
]);

export function rootDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return TWO_LABEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

export function normalizeSender(from: string, opts: NormalizeOptions = {}): SenderId {
  let address = addressOf(from);
  if (opts.stripPlusTag) {
    const at = address.lastIndexOf("@");
    if (at > 0) address = address.slice(0, at).split("+")[0] + address.slice(at);
  }
  const nameMatch = from.match(/^\s*"?([^"<]*?)"?\s*</);
  const displayName = nameMatch?.[1]?.trim() || null;
  const domain = domainOf(address);
  return { key: address, domain, rootDomain: rootDomain(domain), displayName };
}
