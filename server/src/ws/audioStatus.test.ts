import { describe, expect, it } from "vitest";
import { isAppExeName, sanitizeAudioStatus } from "./audioStatus.js";

describe("isAppExeName", () => {
  it("accepts an executable name as the helper reports it", () => {
    expect(isAppExeName("Spotify.exe")).toBe(true);
    expect(isAppExeName("League of Legends.exe")).toBe(true);
  });

  it("rejects paths, lists and anything that isn't an exe name", () => {
    expect(isAppExeName("C:\\Windows\\a.exe")).toBe(false);
    expect(isAppExeName("a.exe,b.exe")).toBe(false);
    expect(isAppExeName("a.exe\ndisable x.exe")).toBe(false);
    expect(isAppExeName("spotify")).toBe(false);
    expect(isAppExeName(`${"x".repeat(200)}.exe`)).toBe(false);
    expect(isAppExeName(42)).toBe(false);
  });
});

describe("sanitizeAudioStatus", () => {
  it("keeps a well-formed status", () => {
    const status = { apps: [{ exe: "League of Legends.exe", state: "ok" }, { exe: "Spotify.exe", state: "disabled" }] };

    expect(sanitizeAudioStatus(status)).toEqual(status);
  });

  it("drops entries it doesn't understand and anything that isn't a status", () => {
    expect(sanitizeAudioStatus({ apps: [{ exe: "a.exe", state: "weird" }, { exe: 3, state: "ok" }] })).toEqual({
      apps: [],
    });
    expect(sanitizeAudioStatus(null)).toBeNull();
    expect(sanitizeAudioStatus({ apps: "nope" })).toBeNull();
  });

  it("bounds what one presenter can make the relay hold and forward", () => {
    const status = sanitizeAudioStatus({
      apps: Array.from({ length: 100 }, (_, i) => ({ exe: `${"x".repeat(500)}${i}.exe`, state: "quiet" })),
    });

    expect(status!.apps).toHaveLength(32);
    expect(status!.apps[0]!.exe.length).toBeLessThanOrEqual(100);
  });
});
