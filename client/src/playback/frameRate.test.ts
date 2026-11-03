import { describe, expect, it } from "vitest";
import { createFrameRateMeter } from "./frameRate.js";

describe("frame rate meter", () => {
  it("counts the frames of the last second", () => {
    const meter = createFrameRateMeter();
    for (let i = 0; i < 60; i++) meter.tick(1000 + i * (1000 / 60));

    expect(meter.rate(1990)).toBe(60);
  });

  it("drops to zero once frames stop coming", () => {
    const meter = createFrameRateMeter();
    for (let i = 0; i < 30; i++) meter.tick(i * (1000 / 30));

    expect(meter.rate(1450)).toBe(16); // only the frames after 450 ms are still in the window
    expect(meter.rate(2000)).toBe(0);
  });
});
