import { describe, expect, it } from "vitest";
import { resolveJoinIdentity } from "./joinIdentity.js";

const verify = (token: string) => (token === "good-token" ? "42" : null);

describe("resolveJoinIdentity", () => {
  it("keeps the declared user id when no session is sent", () => {
    expect(resolveJoinIdentity({ userId: "7" }, verify)).toEqual({ ok: true, userId: "7", verified: false });
    expect(resolveJoinIdentity({ userId: null, session: null }, verify)).toEqual({
      ok: true,
      userId: null,
      verified: false,
    });
  });

  it("uses the session's user id when the session is valid", () => {
    expect(resolveJoinIdentity({ userId: "42", session: "good-token" }, verify)).toEqual({
      ok: true,
      userId: "42",
      verified: true,
    });
  });

  it("a valid session overrides a spoofed userId", () => {
    expect(resolveJoinIdentity({ userId: "999-admin", session: "good-token" }, verify)).toEqual({
      ok: true,
      userId: "42",
      verified: true,
    });
  });

  it("rejects an invalid session", () => {
    expect(resolveJoinIdentity({ userId: "42", session: "forged" }, verify)).toEqual({ ok: false });
  });
});
