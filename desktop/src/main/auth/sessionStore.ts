import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoredLogin } from "@screenshare-bot/shared";

/**
 * Keeps the desktop login between launches. The session is a bearer credential for the
 * relay, so it never touches disk in clear: index.ts wires encrypt/decrypt to Electron's
 * safeStorage (Windows DPAPI, bound to this Windows user).
 */
export interface SessionStoreDeps {
  filePath: string;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface SessionStore {
  /** Null when nothing is stored or the file can't be read back -- the user just logs in again. */
  load(): Promise<StoredLogin | null>;
  save(login: StoredLogin): Promise<void>;
  clear(): Promise<void>;
}

function isStoredLogin(value: unknown): value is StoredLogin {
  const login = value as Partial<StoredLogin> | null;
  return (
    typeof login?.session === "string" &&
    typeof login.user === "object" &&
    login.user !== null &&
    typeof login.user.id === "string" &&
    typeof login.user.username === "string"
  );
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(deps.decrypt(await readFile(deps.filePath)));
        return isStoredLogin(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    async save(login) {
      await mkdir(path.dirname(deps.filePath), { recursive: true });
      await writeFile(deps.filePath, deps.encrypt(JSON.stringify(login)));
    },

    async clear() {
      await rm(deps.filePath, { force: true });
    },
  };
}
