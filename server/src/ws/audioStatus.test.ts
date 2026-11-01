import { describe, expect, it } from "vitest";
import { sanitizeAudioStatus } from "./audioStatus.js";

describe("sanitizeAudioStatus", () => {
  it("keeps a well-formed status", () => {
    const status = { apps: [{ exe: "League of Legends.exe", state: "ok" }] };

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
