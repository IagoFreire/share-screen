import { describe, expect, it } from "vitest";
import { createSessionToken, SESSION_TTL_MS, verifySessionToken } from "./session.js";

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const NOW = 1_800_000_000_000;

describe("desktop sessions", () => {
  it("round-trips the user id", () => {
    const token = createSessionToken("123456789", NOW, SECRET);
    expect(verifySessionToken(token, NOW + 1000, SECRET)).toBe("123456789");
  });

  it("rejects an expired token", () => {
    const token = createSessionToken("123456789", NOW, SECRET);
    expect(verifySessionToken(token, NOW + SESSION_TTL_MS + 1, SECRET)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = createSessionToken("123456789", NOW, SECRET);
    const [payload, signature] = token.split(".");
    const flipped = (payload[0] === "A" ? "B" : "A") + payload.slice(1);
    expect(verifySessionToken(`${flipped}.${signature}`, NOW, SECRET)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const token = createSessionToken("123456789", NOW, "another-secret-that-is-also-32-characters!!");
    expect(verifySessionToken(token, NOW, SECRET)).toBeNull();
  });

  it("rejects garbage without throwing", () => {
    for (const garbage of ["", "a.b", "x", "..", "e30.e30"]) {
      expect(verifySessionToken(garbage, NOW, SECRET)).toBeNull();
    }
  });
});
