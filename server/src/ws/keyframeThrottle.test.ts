import { describe, expect, it } from "vitest";
import { createKeyframeThrottle } from "./keyframeThrottle.js";

describe("keyframe throttle", () => {
  it("lets the first request for a stream through", () => {
    expect(createKeyframeThrottle(1000).allow("room:0:1", 5000)).toBe(true);
  });

  it("holds back repeats for the same stream inside the interval", () => {
    const throttle = createKeyframeThrottle(1000);
    throttle.allow("room:0:1", 5000);

    expect(throttle.allow("room:0:1", 5500)).toBe(false);
    expect(throttle.allow("room:0:1", 6000)).toBe(true);
  });

  it("tracks each stream on its own", () => {
    const throttle = createKeyframeThrottle(1000);
    throttle.allow("room:0:1", 5000);

    expect(throttle.allow("room:0:2", 5100)).toBe(true);
  });
});
