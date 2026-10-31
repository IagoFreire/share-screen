import { describe, expect, it, vi } from "vitest";
import { FrameType, type EncodedFrame } from "@screenshare-bot/shared";
import { createQueueDelayMonitor, createStreamReceiver } from "./streamReceiver.js";
import type { AudioDecodePipeline } from "./audioDecodePipeline.js";
import type { VideoDecodePipeline } from "./videoDecodePipeline.js";

function videoFrame(clock: number, options: { slot?: number; key?: boolean; timestamp?: number } = {}): EncodedFrame {
  return {
    slot: options.slot ?? 0,
    type: FrameType.Video,
    timestamp: options.timestamp ?? clock * 16,
    clock,
    keyFrame: options.key ?? false,
    payload: new Uint8Array(1),
  };
}

function audioFrame(slot = 0): EncodedFrame {
  return { slot, type: FrameType.Audio, timestamp: 0, clock: 1, payload: new Uint8Array(1) };
}

function fakePipelines() {
  const video = { decodeChunk: vi.fn(), awaitKeyframe: vi.fn() };
  const audio = { decodeChunk: vi.fn(), reset: vi.fn() };
  return {
    video,
    audio,
    targets: (slot: number | null) => ({
      slot,
      video: video as unknown as VideoDecodePipeline,
      audio: audio as unknown as AudioDecodePipeline,
    }),
  };
}

function setup() {
  let now = 0;
  const requestKeyframe = vi.fn();
  const reportCongestion = vi.fn();
  const receiver = createStreamReceiver({ requestKeyframe, reportCongestion, now: () => now });
  return { receiver, requestKeyframe, reportCongestion, advance: (ms: number) => (now += ms), at: () => now };
}

describe("stream receiver", () => {
  it("ignores frames of a broadcast this viewer no longer watches", () => {
    const { receiver } = setup();
    const { video, audio, targets } = fakePipelines();

    receiver.route(videoFrame(1, { slot: 1, key: true }), targets(0));
    receiver.route(audioFrame(1), targets(0));
    receiver.route(audioFrame(0), targets(null));

    expect(video.decodeChunk).not.toHaveBeenCalled();
    expect(audio.decodeChunk).not.toHaveBeenCalled();
  });

  it("holds the picture back and asks for a keyframe when a video frame went missing", () => {
    const { receiver, requestKeyframe } = setup();
    const { video, targets } = fakePipelines();

    receiver.route(videoFrame(1, { key: true }), targets(0));
    receiver.route(videoFrame(2), targets(0));
    receiver.route(videoFrame(4), targets(0)); // 3 never arrived

    expect(video.awaitKeyframe).toHaveBeenCalledTimes(1);
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    expect(receiver.stats().gaps).toBe(1);
  });

  it("takes any keyframe as a fresh start, as after a layer switch", () => {
    const { receiver, requestKeyframe } = setup();
    const { targets } = fakePipelines();

    receiver.route(videoFrame(50, { key: true }), targets(0));
    receiver.route(videoFrame(7, { key: true }), targets(0));
    receiver.route(videoFrame(8), targets(0));

    expect(requestKeyframe).not.toHaveBeenCalled();
  });

  it("silences the previous broadcast's sound when frames of another one start arriving", () => {
    const { receiver } = setup();
    const { audio, targets } = fakePipelines();

    receiver.route(audioFrame(0), targets(0));
    receiver.route(audioFrame(1), targets(1));

    expect(audio.reset).toHaveBeenCalledTimes(1);
    expect(audio.decodeChunk).toHaveBeenCalledTimes(2);
  });

  it("reports congestion once frames keep arriving later than they used to", () => {
    const { receiver, reportCongestion, advance, at } = setup();
    const { targets } = fakePipelines();
    let clock = 0;
    const send = (delayMs: number) => {
      clock += 1;
      receiver.route(videoFrame(clock, { key: clock === 1, timestamp: at() - delayMs }), targets(0));
    };

    for (let i = 0; i < 60; i += 1) {
      send(40); // a steady link
      advance(16);
    }
    for (let i = 0; i < 120; i += 1) {
      send(40 + 600); // the queue grew by 600 ms
      advance(16);
    }

    expect(reportCongestion).toHaveBeenCalledTimes(1);
  });
});

describe("queue delay monitor", () => {
  it("measures delay against the best seen recently, whatever the two clocks' offset", () => {
    const monitor = createQueueDelayMonitor();

    monitor.observe(1_000_000, 50);
    const reading = monitor.observe(1_000_100, 450);

    expect(reading.queueDelayMs).toBe(300);
  });

  it("only calls it congestion when the delay lasts", () => {
    const monitor = createQueueDelayMonitor();
    monitor.observe(0, 0);

    expect(monitor.observe(100, 500).congested).toBe(false); // one late burst
    expect(monitor.observe(200, 220).congested).toBe(false); // back to normal
    expect(monitor.observe(300, 700).congested).toBe(false);
    expect(monitor.observe(1400, 1800).congested).toBe(true); // late for over a second
  });
});
