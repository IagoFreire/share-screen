import { describe, expect, it } from "vitest";
import { createAudioTimeline } from "./appAudio.js";

const BLOCK_US = 10_000;

describe("createAudioTimeline", () => {
  it("starts at the first block's estimated capture time", () => {
    const timeline = createAudioTimeline(BLOCK_US);
    expect(timeline.stamp(5_000_000)).toBe(5_000_000);
  });

  it("advances exactly one block per block despite IPC jitter", () => {
    const timeline = createAudioTimeline(BLOCK_US);
    timeline.stamp(5_000_000);

    expect(timeline.stamp(5_013_000)).toBe(5_010_000);
    expect(timeline.stamp(5_017_000)).toBe(5_020_000);
  });

  it("re-anchors after a real gap instead of drifting behind", () => {
    const timeline = createAudioTimeline(BLOCK_US);
    timeline.stamp(5_000_000);

    expect(timeline.stamp(6_000_000)).toBe(6_000_000);
    expect(timeline.stamp(6_011_000)).toBe(6_010_000);
  });
});
