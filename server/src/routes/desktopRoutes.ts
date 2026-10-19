import { Router, type NextFunction, type Request, type Response } from "express";
import type { DesktopLoginResponse, DesktopUser, VoiceLocation } from "@screenshare-bot/shared";
import { createSessionToken, verifySessionToken } from "../auth/session.js";

/**
 * HTTP API for the desktop app. Everything Discord-facing is injected so the routes can
 * be exercised without a network: app.ts wires in the real OAuth exchange and clock.
 */
export interface DesktopRouterDeps {
  /** Swaps an OAuth code (from the app's loopback redirect) for a Discord access token. */
  exchangeCode(code: string): Promise<{ access_token: string }>;
  fetchUser(accessToken: string): Promise<DesktopUser>;
  /** Rejects (VoiceLookupError) when Discord couldn't answer, resolves null when not in voice. */
  locateVoice(userId: string): Promise<VoiceLocation | null>;
  now(): number;
  secret: string;
}

const BEARER_PREFIX = "Bearer ";

/** Rejects requests without a valid desktop session; sets res.locals.userId otherwise. */
export function requireSession(deps: Pick<DesktopRouterDeps, "now" | "secret">) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : "";
    const userId = token ? verifySessionToken(token, deps.now(), deps.secret) : null;
    if (!userId) {
      res.status(401).json({ error: "invalid-session" });
      return;
    }
    res.locals.userId = userId;
    next();
  };
}

export function createDesktopRouter(deps: DesktopRouterDeps): Router {
  const router = Router();
  const sessionGuard = requireSession(deps);

  router.post("/login", async (req, res) => {
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== "string" || !code) {
      res.status(400).json({ error: "Missing `code`." });
      return;
    }

    try {
      const token = await deps.exchangeCode(code);
      const user = await deps.fetchUser(token.access_token);
      const body: DesktopLoginResponse = { session: createSessionToken(user.id, deps.now(), deps.secret), user };
      res.json(body);
    } catch (error) {
      console.error("Desktop login failed:", error);
      res.status(502).json({ error: "Discord login failed." });
    }
  });

  // Lets the app check a stored session at startup without touching Discord at all.
  router.get("/me", sessionGuard, (_req, res) => {
    res.json({ userId: res.locals.userId as string });
  });

  // A failed lookup is a 503, never `location: null`: the app keeps showing the last
  // known channel through a Discord hiccup instead of flashing "not in a voice channel".
  router.get("/voice", sessionGuard, async (_req, res) => {
    try {
      res.json({ location: await deps.locateVoice(res.locals.userId as string) });
    } catch (error) {
      console.warn("Desktop voice lookup failed:", error);
      res.status(503).json({ error: "voice-lookup-failed" });
    }
  });

  return router;
}
