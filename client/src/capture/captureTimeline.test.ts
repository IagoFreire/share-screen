import { describe, expect, it } from "vitest";
import { createCaptureTimeline } from "./captureTimeline.js";

const RATE = 48_000;
const BLOCK = 480; // 10 ms
const CHUNK = 960; // one 20 ms Opus packet

describe("createCaptureTimeline", () => {
  it("stamps each packet with the capture time of its first sample", () => {
    const timeline = createCaptureTimeline(RATE);
    for (let i = 0; i < 4; i += 1) timeline.record(i * 10_000, BLOCK);

    expect(timeline.next(CHUNK)).toBe(0);
    expect(timeline.next(CHUNK)).toBe(20_000);
  });

  it("follows a jump in the input timestamps instead of counting samples past it", () => {
    const timeline = createCaptureTimeline(RATE);
    timeline.record(0, BLOCK);
    timeline.record(10_000, BLOCK);
    // The capture clock was corrected 54 ms back.
    timeline.record(-34_000, BLOCK);
    timeline.record(-24_000, BLOCK);

    expect(timeline.next(CHUNK)).toBe(0);
    expect(timeline.next(CHUNK)).toBe(-34_000);
  });

  it("interpolates when a packet starts partway into a block", () => {
    const timeline = createCaptureTimeline(RATE);
    for (let i = 0; i < 4; i += 1) timeline.record(i * 10_000, BLOCK);

    timeline.next(720);
    expect(timeline.next(CHUNK)).toBe(15_000);
  });

  it("extrapolates from the last block when the encoder runs ahead of what was recorded", () => {
    const timeline = createCaptureTimeline(RATE);
    timeline.record(0, BLOCK);

    expect(timeline.next(BLOCK)).toBe(0);
    expect(timeline.next(BLOCK)).toBe(10_000);
  });

  it("moves every stamp onto another clock by the given offset", () => {
    const timeline = createCaptureTimeline(RATE, 5_000_000);
    timeline.record(0, BLOCK);
    timeline.record(10_000, BLOCK);

    expect(timeline.next(BLOCK)).toBe(5_000_000);
    expect(timeline.next(BLOCK)).toBe(5_010_000);
  });

  it("returns null before any input was recorded", () => {
    expect(createCaptureTimeline(RATE).next(CHUNK)).toBeNull();
  });
});
