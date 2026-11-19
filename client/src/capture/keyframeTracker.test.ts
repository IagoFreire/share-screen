import { describe, expect, it } from "vitest";
import {
  createKeyframeTracker,
  FAILED_KEYFRAMES_BEFORE_NEW_ENCODER,
  KEYFRAME_ANSWER_TIMEOUT_MS,
  KEYFRAME_RETRY_GAP_MS,
} from "./keyframeTracker.js";

const INTERVAL_MS = 10_000;
const SPACING_MS = 500;
const FRAME_MS = 33;

/** A tracker past its start: the stream's first keyframe already came out at t=0. */
function started() {
  const tracker = createKeyframeTracker({ intervalMs: INTERVAL_MS, requestSpacingMs: SPACING_MS });
  expect(tracker.decide(0, 0)).toBe(true);
  tracker.onOutput(true, 0, 5);
  return tracker;
}

describe("keyframe tracker", () => {
  it("forces the first frame of the stream", () => {
    const tracker = createKeyframeTracker({ intervalMs: INTERVAL_MS, requestSpacingMs: SPACING_MS });
    expect(tracker.decide(0, 0)).toBe(true);
  });

  it("forces the next frame after a request once the spacing since the last keyframe allows", () => {
    const tracker = started();
    tracker.request();
    expect(tracker.decide(100, 100_000)).toBe(false); // 100 ms after the last keyframe
    expect(tracker.decide(600, 600_000)).toBe(true);
  });

  it("forces again when the encoder ignored the flag and put out a delta", () => {
    const tracker = started();
    tracker.request();
    expect(tracker.decide(1000, 1_000_000)).toBe(true);
    tracker.onOutput(false, 1_000_000, 1010);

    expect(tracker.decide(1010 + KEYFRAME_RETRY_GAP_MS - 1, 1_100_000)).toBe(false);
    expect(tracker.decide(1010 + KEYFRAME_RETRY_GAP_MS, 1_200_000)).toBe(true);
  });

  it("forces again when the encoder dropped the forced frame (a later one came out first)", () => {
    const tracker = started();
    tracker.request();
    expect(tracker.decide(1000, 1_000_000)).toBe(true);
    // Realtime mode lets the rate controller drop frames: the forced one never comes out.
    expect(tracker.decide(1033, 1_033_000)).toBe(false); // waiting for its answer
    tracker.onOutput(false, 1_033_000, 1040);

    expect(tracker.decide(1040 + KEYFRAME_RETRY_GAP_MS, 1_200_000)).toBe(true);
  });

  it("counts a forced frame with no answer at all as lost (a still screen sends no later frame)", () => {
    const tracker = started();
    tracker.request();
    expect(tracker.decide(1000, 1_000_000)).toBe(true);

    expect(tracker.wants(1000 + KEYFRAME_ANSWER_TIMEOUT_MS)).toBe(false);
    expect(tracker.wants(1000 + KEYFRAME_ANSWER_TIMEOUT_MS + KEYFRAME_RETRY_GAP_MS + 1)).toBe(true);
  });

  it("is settled by the keyframe that comes out, and stops forcing", () => {
    const tracker = started();
    tracker.request();
    expect(tracker.decide(1000, 1_000_000)).toBe(true);
    tracker.onOutput(true, 1_000_000, 1010);

    for (let t = 1043; t < 5000; t += FRAME_MS) expect(tracker.decide(t, t * 1000)).toBe(false);
  });

  it("asks for a new encoder when forced keyframes someone needs keep failing", () => {
    const tracker = started();
    tracker.request();
    let now = 1000;
    for (let attempt = 0; attempt < FAILED_KEYFRAMES_BEFORE_NEW_ENCODER; attempt++) {
      expect(tracker.needsNewEncoder).toBe(false);
      expect(tracker.decide(now, now * 1000)).toBe(true);
      tracker.onOutput(false, now * 1000, now + 5);
      now += KEYFRAME_RETRY_GAP_MS + 10;
    }
    expect(tracker.needsNewEncoder).toBe(true);

    // A brand-new encoder starts on a keyframe; its first frame is forced regardless.
    tracker.onNewEncoder();
    expect(tracker.needsNewEncoder).toBe(false);
    expect(tracker.decide(now, now * 1000)).toBe(true);
    tracker.onOutput(true, now * 1000, now + 5);
    expect(tracker.decide(now + 40, (now + 40) * 1000)).toBe(false);
  });

  it("lets any keyframe coming out serve a request still waiting for the spacing", () => {
    const tracker = started();
    tracker.request();
    // A keyframe the encoder made on its own (a scene cut) reaches the relay after the request.
    tracker.onOutput(true, 200_000, 210);

    expect(tracker.decide(700, 700_000)).toBe(false);
  });

  it("does not let a keyframe from before a new size settle the one the new size needs", () => {
    const tracker = started();
    tracker.decide(1000, 1_000_000); // nothing due: a plain delta
    tracker.require(); // the source was resized
    // The delta's predecessor, an old-size keyframe, comes out late.
    tracker.onOutput(true, 990_000, 1005);

    expect(tracker.decide(1033, 1_033_000)).toBe(true);
  });

  it("takes a late keyframe from a slow encoder rather than forcing and replacing it forever", () => {
    const tracker = createKeyframeTracker({ intervalMs: INTERVAL_MS, requestSpacingMs: SPACING_MS });
    expect(tracker.decide(0, 0)).toBe(true); // the stream's first frame
    tracker.wants(KEYFRAME_ANSWER_TIMEOUT_MS); // no answer in time: counted as lost...
    expect(tracker.decide(KEYFRAME_ANSWER_TIMEOUT_MS + KEYFRAME_RETRY_GAP_MS, 1_150_000)).toBe(true);
    tracker.onOutput(true, 0, 1200); // ...but it was only slow: the first frame comes out a keyframe
    tracker.onOutput(false, 1_150_000, 1210); // and the retry, unneeded now, a delta

    expect(tracker.decide(1400, 1_400_000)).toBe(false);
    expect(tracker.needsNewEncoder).toBe(false);
  });

  it("puts a keyframe in every interval, without forcing every frame when the encoder ignores it", () => {
    const tracker = started();
    expect(tracker.decide(INTERVAL_MS - 10, 9_990_000)).toBe(false);
    expect(tracker.decide(INTERVAL_MS + 10, 10_010_000)).toBe(true);
    tracker.onOutput(false, 10_010_000, INTERVAL_MS + 20);

    // Nobody is waiting on this one: retried an interval later, never worth a new encoder.
    expect(tracker.decide(INTERVAL_MS + 20 + KEYFRAME_RETRY_GAP_MS, 10_200_000)).toBe(false);
    expect(tracker.decide(2 * INTERVAL_MS, 20_000_000)).toBe(false);
    expect(tracker.needsNewEncoder).toBe(false);
    expect(tracker.decide(2 * INTERVAL_MS + 10, 20_010_000)).toBe(true);
  });

  it("counts a failed periodic keyframe against a request that arrived meanwhile", () => {
    const tracker = started();
    expect(tracker.decide(INTERVAL_MS + 10, 10_010_000)).toBe(true);
    tracker.request(); // a viewer joined while the periodic one was in the encoder
    tracker.onOutput(false, 10_010_000, INTERVAL_MS + 20);

    expect(tracker.decide(INTERVAL_MS + 20 + KEYFRAME_RETRY_GAP_MS, 10_200_000)).toBe(true);
  });
});
