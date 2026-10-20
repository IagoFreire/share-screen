import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StoredLogin } from "@screenshare-bot/shared";
import { createSessionStore } from "./sessionStore.js";

const LOGIN: StoredLogin = {
  session: "signed-session",
  user: { id: "42", username: "iago", globalName: "Iago", avatarUrl: null },
};

/** Reversible stand-in for safeStorage, so the test can also check nothing is stored in clear. */
const codec = {
  encrypt: (text: string) => Buffer.from(text, "utf8").reverse(),
  decrypt: (data: Buffer) => Buffer.from(data).reverse().toString("utf8"),
};

async function tempFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "screenshare-session-")), "session.bin");
}

describe("session store", () => {
  it("round-trips a login", async () => {
    const store = createSessionStore({ filePath: await tempFile(), ...codec });

    await store.save(LOGIN);

    expect(await store.load()).toEqual(LOGIN);
  });

  it("returns null when nothing was saved", async () => {
    const store = createSessionStore({ filePath: await tempFile(), ...codec });
    expect(await store.load()).toBeNull();
  });

  it("returns null on a corrupt file", async () => {
    const filePath = await tempFile();
    await writeFile(filePath, Buffer.from("not encrypted json"));
    const store = createSessionStore({ filePath, ...codec });

    expect(await store.load()).toBeNull();
  });

  it("clear forgets the login", async () => {
    const store = createSessionStore({ filePath: await tempFile(), ...codec });
    await store.save(LOGIN);

    await store.clear();

    expect(await store.load()).toBeNull();
  });
});
