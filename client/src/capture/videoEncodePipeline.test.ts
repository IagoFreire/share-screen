import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVideoEncodePipeline } from "./videoEncodePipeline.js";

/** A captured frame; `clone()` and `new VideoFrame(frame, init)` give independent copies. */
class FakeFrame {
  closed = false;
  constructor(
    public displayWidth: number,
    public displayHeight: number,
    public timestamp: number,
  ) {}
  clone() {
    return new FakeFrame(this.displayWidth, this.displayHeight, this.timestamp);
  }
  close() {
    this.closed = true;
  }
}

class FakeEncoder {
  static last: FakeEncoder | null = null;
  static isConfigSupported = async () => ({ supported: true });
  state = "unconfigured";
  encodeQueueSize = 0;
  config: { width: number; height: number } | null = null;
  encoded: Array<{ timestamp: number; keyFrame: boolean }> = [];
  constructor() {
    FakeEncoder.last = this;
  }
  configure(config: { width: number; height: number }) {
    this.config = config;
    this.state = "configured";
  }
  encode(frame: FakeFrame, options: { keyFrame: boolean }) {
    this.encoded.push({ timestamp: frame.timestamp, keyFrame: options.keyFrame });
  }
  close() {
    this.state = "closed";
  }
}

/** The capture: frames are pushed by the test, as the browser would when the picture changes. */
function fakeCapture() {
  const waiting: Array<(result: { done: boolean; value?: FakeFrame }) => void> = [];
  const ready: FakeFrame[] = [];
  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readable = {
        getReader: () => ({
          read: () =>
            new Promise((resolve) => {
              const frame = ready.shift();
              if (frame) resolve({ done: false, value: frame });
              else waiting.push(resolve);
            }),
          cancel: async () => {
            for (const resolve of waiting.splice(0)) resolve({ done: true });
          },
        }),
      };
    },
  );
  return {
    push(frame: FakeFrame) {
      const resolve = waiting.shift();
      if (resolve) resolve({ done: false, value: frame });
      else ready.push(frame);
    },
  };
}

const track = {} as MediaStreamTrack;
const quality = { height: 1080, framerate: 60, bitrateKbps: 6000 } as never;

/** Lets the pump's awaits (read, isConfigSupported, configure) settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("startVideoEncodePipeline", () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("VideoEncoder", FakeEncoder);
    vi.stubGlobal(
      "VideoFrame",
      class extends FakeFrame {
        constructor(source: FakeFrame, init: { timestamp: number }) {
          super(source.displayWidth, source.displayHeight, init.timestamp);
        }
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function advance(ms: number) {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
  }

  it("encodes a fullscreen 4K source at the chosen height, keeping its shape", async () => {
    const capture = fakeCapture();
    const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });

    capture.push(new FakeFrame(3840, 2160, 0));
    await settle();

    expect(FakeEncoder.last!.config).toMatchObject({ width: 1920, height: 1080 });
    pipeline.stop();
  });

  it("lets go of every captured frame once it is encoded, so the capture never runs dry", async () => {
    const capture = fakeCapture();
    const cloneSpy = vi.spyOn(FakeFrame.prototype, "clone");
    const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });
    const frames = [0, 16_000, 33_000].map((timestamp) => new FakeFrame(1920, 1080, timestamp));

    for (const frame of frames) {
      capture.push(frame);
      await settle();
    }

    // Holding even one (a copy of the last picture) froze the live under a fullscreen game.
    expect(frames.every((frame) => frame.closed)).toBe(true);
    expect(cloneSpy).not.toHaveBeenCalled();
    pipeline.stop();
  });

  it("puts the keyframe a viewer asks for on the next captured frame", async () => {
    const capture = fakeCapture();
    const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });
    capture.push(new FakeFrame(1920, 1080, 0));
    await settle();
    await advance(1000);

    pipeline.requestKeyframe();
    now += 16;
    capture.push(new FakeFrame(1920, 1080, 1_016_000));
    await settle();

    const encoded = FakeEncoder.last!.encoded;
    expect(encoded.map((chunk) => chunk.keyFrame)).toEqual([true, true]);
    pipeline.stop();
  });
});
