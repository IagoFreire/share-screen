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

  it("keeps counting through the burst that follows a stalled page", () => {
    // Blocks 0-4 arrive on time; then the page stalls 120 ms and blocks 5-16, captured
    // 10 ms apart all along, arrive together. They are still one continuous stream.
    const T = 5_000_000;
    const timeline = createAudioTimeline(BLOCK_US);
    for (let block = 0; block < 5; block += 1) timeline.stamp(T + block * BLOCK_US);

    const burst = Array.from({ length: 12 }, (_, i) => timeline.stamp(T + 160_000 + i * 100));
    const after = [timeline.stamp(T + 170_000), timeline.stamp(T + 180_000)];

    expect(burst).toEqual(Array.from({ length: 12 }, (_, i) => T + (5 + i) * BLOCK_US));
    expect(after).toEqual([T + 170_000, T + 180_000]);
  });

  it("re-anchors once a real gap persists instead of drifting behind", () => {
    // The helper skipped a second of its schedule: every block from here on arrives a
    // second later than the count says, for as long as the stream runs.
    const T = 5_000_000;
    const timeline = createAudioTimeline(BLOCK_US);
    timeline.stamp(T);

    const stamps = Array.from({ length: 80 }, (_, i) => timeline.stamp(T + 1_010_000 + i * BLOCK_US));

    expect(stamps[0]).toBe(T + BLOCK_US); // one late block proves nothing yet
    expect(stamps.at(-1)).toBe(T + 1_010_000 + 79 * BLOCK_US); // back on the real clock
  });

  it("re-anchors when blocks keep arriving earlier than counted", () => {
    // The first block was delayed 100 ms on its way in, so the anchor started late.
    const T = 5_000_000;
    const timeline = createAudioTimeline(BLOCK_US);
    timeline.stamp(T + 100_000);

    const stamps = Array.from({ length: 80 }, (_, i) => timeline.stamp(T + (i + 1) * BLOCK_US));

    expect(stamps.at(-1)).toBe(T + 80 * BLOCK_US);
  });
});
