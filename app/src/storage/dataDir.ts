// Where persistent data lives: a user data dir OUTSIDE the repo, overridable with JEV_DATA_DIR.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface DirEnv { env: Record<string, string | undefined>; platform: NodeJS.Platform; home: string; cwd: string }

export function resolveDataDir(e: DirEnv): string {
  const override = e.env.JEV_DATA_DIR?.trim();
  let dir: string;
  if (override) {
    dir = isAbsolute(override) ? resolve(override) : resolve(e.home, override);
  } else if (e.platform === "darwin") {
    dir = join(e.home, "Library", "Application Support", "JevInbox");
  } else if (e.platform === "win32") {
    dir = join(e.env.APPDATA || join(e.home, "AppData", "Roaming"), "JevInbox");
  } else {
    dir = join(e.env.XDG_DATA_HOME || join(e.home, ".local", "share"), "jev-inbox");
  }
  // Never inside the project (and so never inside the repo).
  const rel = relative(resolve(e.cwd), dir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error("The data directory must be outside the project folder. Set JEV_DATA_DIR to another location.");
  }
  return dir;
}

export function ensureDataDir(e: DirEnv = { env: process.env, platform: process.platform, home: homedir(), cwd: process.cwd() }): string {
  const dir = resolveDataDir(e);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const DB_FILE = "jev.sqlite";
export const SECRETS_FILE = "secrets.enc.json";
export { sep };
