import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopUser } from "@screenshare-bot/shared";
import { verifySessionToken } from "../auth/session.js";
import { createDesktopRouter, type DesktopRouterDeps } from "./desktopRoutes.js";

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const NOW = 1_800_000_000_000;
const USER: DesktopUser = { id: "42", username: "iago", globalName: "Iago", avatarUrl: null };

let server: Server | null = null;

async function start(overrides: Partial<DesktopRouterDeps> = {}): Promise<string> {
  const deps: DesktopRouterDeps = {
    exchangeCode: async () => ({ access_token: "discord-token" }),
    fetchUser: async () => USER,
    now: () => NOW,
    secret: SECRET,
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use("/api/desktop", createDesktopRouter(deps));
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/desktop`;
}

afterEach(() => {
  server?.close();
  server = null;
});

function postLogin(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/desktop/login", () => {
  it("login returns a verifiable session for the Discord user", async () => {
    const base = await start();

    const response = await postLogin(base, { code: "abc" });
    const body = (await response.json()) as { session: string; user: DesktopUser };

    expect(response.status).toBe(200);
    expect(body.user).toEqual(USER);
    expect(verifySessionToken(body.session, NOW, SECRET)).toBe("42");
  });

  it("login rejects a missing code with 400", async () => {
    const base = await start();
    expect((await postLogin(base, {})).status).toBe(400);
  });

  it("login maps a Discord failure to 502", async () => {
    const base = await start({
      exchangeCode: async () => {
        throw new Error("discord down");
      },
    });
    expect((await postLogin(base, { code: "abc" })).status).toBe(502);
  });
});

describe("requireSession", () => {
  it("requireSession rejects a bad bearer with 401 invalid-session", async () => {
    const base = await start();

    const response = await fetch(`${base}/me`, { headers: { Authorization: "Bearer nope" } });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid-session" });
  });

  it("requireSession lets a valid session through", async () => {
    const base = await start();
    const login = (await (await postLogin(base, { code: "abc" })).json()) as { session: string };

    const response = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${login.session}` } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "42" });
  });
});
