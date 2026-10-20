import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVideoDecodePipeline } from "./videoDecodePipeline.js";

/** Stands in for the browser's VideoDecoder; the test emits its output frames by hand. */
class FakeDecoder {
  static last: FakeDecoder | null = null;
  static isConfigSupported = async () => ({ supported: true });
  state = "unconfigured";
  decodeQueueSize = 0;
  constructor(public init: { output: (frame: unknown) => void; error: (error: unknown) => void }) {
    FakeDecoder.last = this;
  }
  configure() {
    this.state = "configured";
  }
  decode() {}
  close() {
    this.state = "closed";
  }
}

function fakeFrame(timestampUs: number) {
  return { timestamp: timestampUs, displayWidth: 1920, displayHeight: 1080, close: vi.fn() };
}

const fakeCanvas = () =>
  ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }) }) as unknown as HTMLCanvasElement;

const FRAME_US = 16_667;

describe("startVideoDecodePipeline", () => {
  beforeEach(() => {
    vi.stubGlobal("VideoDecoder", FakeDecoder);
    vi.stubGlobal("EncodedVideoChunk", class {});
    // No animation frame ever runs: the window is minimized or covered by another app.
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("releases frames that are already due even while no animation frame runs", async () => {
    // Audio is far ahead of every frame, so all of them are due.
    const clock = { setSource: vi.fn(), currentTimestampUs: () => 10_000_000 };
    await startVideoDecodePipeline(fakeCanvas(), { clock });
    const frames = Array.from({ length: 100 }, (_, i) => fakeFrame(i * FRAME_US));

    for (const frame of frames) FakeDecoder.last!.init.output(frame);

    // Held frames are what starve the hardware decoder: only the newest may wait for a paint.
    const held = frames.filter((frame) => frame.close.mock.calls.length === 0);
    expect(held).toEqual([frames[99]]);
  });

  it("keeps frames that are not due yet, so the jitter buffer still works", async () => {
    const clock = { setSource: vi.fn(), currentTimestampUs: () => 0 };
    await startVideoDecodePipeline(fakeCanvas(), { clock });
    const frames = Array.from({ length: 10 }, (_, i) => fakeFrame(100_000 + i * FRAME_US));

    for (const frame of frames) FakeDecoder.last!.init.output(frame);

    expect(frames.every((frame) => frame.close.mock.calls.length === 0)).toBe(true);
  });
});
