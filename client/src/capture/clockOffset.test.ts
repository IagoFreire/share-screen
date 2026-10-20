import { describe, expect, it } from "vitest";
import { audioRebaseUs, estimateClockOffsetUs } from "./clockOffset.js";

describe("estimateClockOffsetUs", () => {
  it("trusts the sample delivered fastest, since delivery delay only makes a stamp look older", () => {
    expect(
      estimateClockOffsetUs([
        { timestampUs: 1_000_000, readAtUs: 30_000 },
        { timestampUs: 1_016_000, readAtUs: 40_000 },
        { timestampUs: 1_033_000, readAtUs: 70_000 },
      ]),
    ).toBe(976_000);
  });

  it("is null without samples", () => {
    expect(estimateClockOffsetUs([])).toBeNull();
  });
});

describe("audioRebaseUs", () => {
  it("shifts audio onto the video clock when the two run on different clocks", () => {
    // Electron: video stamped since boot (~9.4 h), loopback audio on the page's clock.
    expect(audioRebaseUs(34_000_000_000, 15_000)).toBe(33_999_985_000);
  });

  it("leaves audio alone when both already share a clock", () => {
    expect(audioRebaseUs(25_000, 15_000)).toBe(0);
  });

  it("leaves audio alone when either clock couldn't be measured", () => {
    expect(audioRebaseUs(null, 15_000)).toBe(0);
    expect(audioRebaseUs(25_000, null)).toBe(0);
  });
});
