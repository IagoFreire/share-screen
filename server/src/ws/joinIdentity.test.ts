import { describe, expect, it } from "vitest";
import { pausesSiblingConnections, resolveJoinIdentity, startsWatchingNothing } from "./joinIdentity.js";

describe("startsWatchingNothing", () => {
  it("a viewer starts on a broadcast by default", () => {
    expect(startsWatchingNothing({})).toBe(false);
  });

  it("a viewer who had left the live stays out of it", () => {
    expect(startsWatchingNothing({ watchNothing: true })).toBe(true);
  });

  it("a presenter-only connection never watches anything", () => {
    expect(startsWatchingNothing({ presenterOnly: true })).toBe(true);
  });
});

describe("pausesSiblingConnections", () => {
  it("a viewer join pauses the same user's other connections", () => {
    expect(pausesSiblingConnections({})).toBe(true);
    expect(pausesSiblingConnections({ presenterOnly: false })).toBe(true);
  });

  it("a presenter-only join leaves the user's player alone", () => {
    expect(pausesSiblingConnections({ presenterOnly: true })).toBe(false);
  });

  it("a join that watches nothing leaves the tab the user does watch in alone", () => {
    expect(pausesSiblingConnections({ watchNothing: true })).toBe(false);
  });
});

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
