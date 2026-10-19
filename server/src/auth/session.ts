import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sessions for the desktop app: proof, issued after a Discord OAuth login, that a
 * connection really belongs to a given Discord user. Stateless on purpose -- the relay
 * already restarts with the PC it runs on, and a signed token survives that without a
 * store, where an in-memory session table would log everyone out.
 */

/** How long a desktop login lasts before the app asks for Discord again. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  uid: string;
  exp: number;
}

function sign(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encodedPayload).digest();
}

export function createSessionToken(userId: string, nowMs: number, secret: string): string {
  const payload: SessionPayload = { uid: userId, exp: nowMs + SESSION_TTL_MS };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret).toString("base64url")}`;
}

/** The token's user id, or null for anything expired, forged or malformed. Never throws. */
export function verifySessionToken(token: string, nowMs: number, secret: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSignature] = parts;

  const expected = sign(encodedPayload, secret);
  const actual = Buffer.from(encodedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof payload.uid !== "string" || !payload.uid || typeof payload.exp !== "number") return null;
    return nowMs <= payload.exp ? payload.uid : null;
  } catch {
    return null;
  }
}
