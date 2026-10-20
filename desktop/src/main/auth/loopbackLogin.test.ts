import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopLoginResponse } from "@screenshare-bot/shared";
import { buildAuthorizeUrl, parseCallback, runLoopbackLogin, type LoopbackLoginDeps } from "./loopbackLogin.js";

const RESPONSE: DesktopLoginResponse = {
  session: "signed-session",
  user: { id: "42", username: "iago", globalName: "Iago", avatarUrl: null },
};

/** Each test gets its own port so a socket lingering from the previous one can't interfere. */
let nextPort = 53200;

function deps(overrides: Partial<LoopbackLoginDeps> = {}): LoopbackLoginDeps & { opened: string[]; exchanges: string[] } {
  const opened: string[] = [];
  const exchanges: string[] = [];
  return {
    opened,
    exchanges,
    openExternal: async (url) => {
      opened.push(url);
    },
    fetchClientId: async () => "client-123",
    exchange: async (code) => {
      exchanges.push(code);
      return RESPONSE;
    },
    timeoutMs: 2000,
    port: nextPort++,
    ...overrides,
  };
}

async function waitForOpened(opened: string[]): Promise<URL> {
  while (opened.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  return new URL(opened[0]);
}

function callbackUrl(port: number, query: string): string {
  return `http://127.0.0.1:${port}/callback?${query}`;
}

const blockers: net.Server[] = [];
afterEach(() => {
  for (const server of blockers.splice(0)) server.close();
});

describe("buildAuthorizeUrl", () => {
  it("asks Discord for an identify-only code sent to the loopback port", () => {
    expect(buildAuthorizeUrl("client-123", "state-abc", 53134)).toBe(
      "https://discord.com/oauth2/authorize?client_id=client-123&response_type=code&scope=identify" +
        "&redirect_uri=http%3A%2F%2F127.0.0.1%3A53134%2Fcallback&state=state-abc",
    );
  });
});

describe("parseCallback", () => {
  it("returns the code when the state matches", () => {
    expect(parseCallback("/callback?code=abc&state=s1", "s1")).toEqual({ code: "abc" });
  });

  it("rejects a different state", () => {
    expect(parseCallback("/callback?code=abc&state=other", "s1")).toEqual({ error: "state-mismatch" });
  });

  it("reports a denied consent", () => {
    expect(parseCallback("/callback?error=access_denied&state=s1", "s1")).toEqual({ error: "denied" });
  });

  it("reports a missing code", () => {
    expect(parseCallback("/callback?state=s1", "s1")).toEqual({ error: "missing-code" });
  });
});

describe("runLoopbackLogin", () => {
  it("exchanges the code from Discord's redirect", async () => {
    const d = deps();
    const login = runLoopbackLogin(d);
    const authorize = await waitForOpened(d.opened);

    const page = await fetch(callbackUrl(d.port!, `code=abc&state=${authorize.searchParams.get("state")}`));

    expect(await login).toEqual(RESPONSE);
    expect(d.exchanges).toEqual(["abc"]);
    expect(await page.text()).toContain("Pode voltar ao ScreenShare");
  });

  it("a second callback after success is ignored", async () => {
    const d = deps();
    const login = runLoopbackLogin(d);
    const state = (await waitForOpened(d.opened)).searchParams.get("state");

    await Promise.allSettled([
      fetch(callbackUrl(d.port!, `code=first&state=${state}`)),
      fetch(callbackUrl(d.port!, `code=second&state=${state}`)),
    ]);

    await login;
    expect(d.exchanges).toHaveLength(1);
  });

  it("rejects a callback whose state doesn't match", async () => {
    const d = deps();
    const login = runLoopbackLogin(d);
    await waitForOpened(d.opened);

    void fetch(callbackUrl(d.port!, "code=abc&state=forged")).catch(() => {});

    await expect(login).rejects.toThrow("Login cancelado.");
    expect(d.exchanges).toEqual([]);
  });

  it("runLoopbackLogin times out and frees the port", async () => {
    const d = deps({ timeoutMs: 50 });

    await expect(runLoopbackLogin(d)).rejects.toThrow("O login não foi concluído. Tente de novo.");

    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(d.port, "127.0.0.1", () => resolve());
    });
    probe.close();
  });

  it("cancelling an abandoned login rejects at once and frees the port", async () => {
    const controller = new AbortController();
    const d = deps({ signal: controller.signal, timeoutMs: 60_000 });
    const login = runLoopbackLogin(d);
    await waitForOpened(d.opened);

    controller.abort();

    await expect(login).rejects.toThrow("Login cancelado.");
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(d.port, "127.0.0.1", () => resolve());
    });
    probe.close();
  });

  it("port in use rejects with the pt-BR message", async () => {
    const d = deps();
    const blocker = net.createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(d.port, "127.0.0.1", () => resolve()));

    await expect(runLoopbackLogin(d)).rejects.toThrow(
      "A porta 53134 está em uso. Feche outro login em andamento e tente de novo.".replace("53134", String(d.port)),
    );
    expect(d.opened).toEqual([]);
  });
});
