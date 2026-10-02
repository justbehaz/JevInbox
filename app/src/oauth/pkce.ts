import { createHash, randomBytes } from "node:crypto";

const b64url = (b: Buffer) => b.toString("base64url");
export const createVerifier = () => b64url(randomBytes(48)); // 64 chars, within RFC 7636's 43-128
export const challengeS256 = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());
export const randomState = () => b64url(randomBytes(24));
