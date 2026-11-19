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

/**
 * What the encoder does with each frame: put it out as asked (a keyframe when forced), put
 * it out as a delta whatever was asked (a driver ignoring the flag), drop it (realtime rate
 * control: forced ones, or all of them for a while), or hold on to it and never answer
 * again (a hung encoder: its queue fills up).
 */
type EncoderBehaviour = "as-asked" | "ignore-keyframes" | "drop-keyframes" | "drop-all" | "silent";

class FakeEncoder {
  static last: FakeEncoder | null = null;
  static created = 0;
  /** How encoders created from now on behave; the first one made after a change gets it. */
  static behaviour: EncoderBehaviour = "as-asked";
  static isConfigSupported = async () => ({ supported: true });
  state = "unconfigured";
  encodeQueueSize = 0;
  config: { width: number; height: number } | null = null;
  encoded: Array<{ timestamp: number; keyFrame: boolean }> = [];
  behaviour = FakeEncoder.behaviour;
  private readonly output: (chunk: { type: string; timestamp: number }) => void;
  private readonly error: (error: Error) => void;
  constructor(init: { output: (chunk: { type: string; timestamp: number }) => void; error: (error: Error) => void }) {
    this.output = init.output;
    this.error = init.error;
    FakeEncoder.last = this;
    FakeEncoder.created += 1;
  }
  /** A driver reset: WebCodecs closes the encoder for good and reports it. */
  fail() {
    this.state = "closed";
    this.error(new Error("driver reset"));
  }
  configure(config: { width: number; height: number }) {
    this.config = config;
    this.state = "configured";
  }
  encode(frame: FakeFrame, options: { keyFrame: boolean }) {
    this.encoded.push({ timestamp: frame.timestamp, keyFrame: options.keyFrame });
    // A real encoder's very first frame is always a keyframe, whatever it is asked.
    const first = this.encoded.length === 1;
    const behaviour = first ? "as-asked" : this.behaviour;
    if (behaviour === "silent") {
      this.encodeQueueSize += 1; // stuck inside, never answered
      return;
    }
    if (behaviour === "drop-all") return;
    if (behaviour === "drop-keyframes" && options.keyFrame) return;
    const type = first || (options.keyFrame && behaviour === "as-asked") ? "key" : "delta";
    const timestamp = frame.timestamp;
    queueMicrotask(() => {
      if (this.state !== "closed") this.output({ type, timestamp });
    });
  }
  close() {
    this.state = "closed";
  }
}

/** The still-picture copy: records what was drawn into it. */
class FakeCanvas {
  drawn: FakeFrame[] = [];
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return { drawImage: (frame: FakeFrame) => this.drawn.push(frame) };
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
    FakeEncoder.created = 0;
    FakeEncoder.behaviour = "as-asked";
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("VideoEncoder", FakeEncoder);
    vi.stubGlobal(
      "VideoFrame",
      class extends FakeFrame {
        constructor(source: FakeCanvas, init: { timestamp: number }) {
          super(source.width, source.height, init.timestamp);
        }
      },
    );
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
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

  it("encodes a copy of the still screen as the keyframe a viewer asks for", async () => {
    const capture = fakeCapture();
    const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });
    capture.push(new FakeFrame(3840, 2160, 1_000_000));
    await settle();
    await advance(1000); // past the requested-keyframe spacing; the screen hasn't changed since

    pipeline.requestKeyframe();
    await advance(200);

    const encoded = FakeEncoder.last!.encoded;
    expect(encoded).toHaveLength(2);
    expect(encoded[1]!.keyFrame).toBe(true);
    // Stamped on the capture's clock as if captured now, not as the stale original.
    expect(encoded[1]!.timestamp).toBeGreaterThan(1_000_000 + 1_000_000);
    pipeline.stop();
  });

  it("resumes on a still screen with a keyframe from the copy", async () => {
    const capture = fakeCapture();
    const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });
    capture.push(new FakeFrame(1920, 1080, 0));
    await settle();
    pipeline.setPaused(true);
    await advance(2000);

    pipeline.setPaused(false); // a viewer arrived; the screen is still
    await advance(200);

    const encoded = FakeEncoder.last!.encoded;
    expect(encoded.map((chunk) => chunk.keyFrame)).toEqual([true, true]);
    pipeline.stop();
  });

  it("leaves a moving capture alone: the next real frame carries the keyframe", async () => {
    const capture = fakeCapture();
    const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });
    capture.push(new FakeFrame(1920, 1080, 0));
    await settle();
    await advance(1000);

    pipeline.requestKeyframe();
    now += 16;
    capture.push(new FakeFrame(1920, 1080, 1_016_000));
    await settle();
    await advance(100);

    const encoded = FakeEncoder.last!.encoded;
    expect(encoded.map((chunk) => chunk.timestamp)).toEqual([0, 1_016_000]);
    expect(encoded[1]!.keyFrame).toBe(true);
    pipeline.stop();
  });

  describe("a keyframe asked for that never comes out", () => {
    /** A moving picture: one captured frame every 16 ms, stamped on the capture clock. */
    async function playFrames(capture: ReturnType<typeof fakeCapture>, count: number) {
      for (let i = 0; i < count; i++) {
        await advance(16);
        capture.push(new FakeFrame(1920, 1080, now * 1000));
        await settle();
      }
    }

    it("forces it again when the encoder dropped the frame it was forced on", async () => {
      const capture = fakeCapture();
      const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });
      await playFrames(capture, 1);
      await advance(1000);
      // Realtime rate control drops the big keyframe the viewer asked for.
      FakeEncoder.last!.behaviour = "drop-keyframes";
      const before = FakeEncoder.last!.encoded.length;

      pipeline.requestKeyframe();
      await playFrames(capture, 20);

      const forced = FakeEncoder.last!.encoded.slice(before).filter((frame) => frame.keyFrame);
      expect(forced.length).toBeGreaterThanOrEqual(2);
      pipeline.stop();
    });

    it("starts a new encoder when the ones a viewer needs keep failing, so a keyframe goes out", async () => {
      const capture = fakeCapture();
      const chunks: Array<{ type: string; timestamp: number }> = [];
      const pipeline = await startVideoEncodePipeline(track, (chunk) => chunks.push(chunk), { quality });
      await playFrames(capture, 1);
      await advance(1000);
      FakeEncoder.last!.behaviour = "ignore-keyframes"; // the driver ignores the flag
      const askedAt = now * 1000;

      pipeline.requestKeyframe();
      await playFrames(capture, 60);

      expect(FakeEncoder.created).toBe(2);
      expect(chunks.some((chunk) => chunk.type === "key" && chunk.timestamp > askedAt)).toBe(true);
      pipeline.stop();
    });

    it("gets a still screen its keyframe too, through a new encoder if it has to", async () => {
      const capture = fakeCapture();
      const chunks: Array<{ type: string; timestamp: number }> = [];
      const pipeline = await startVideoEncodePipeline(track, (chunk) => chunks.push(chunk), { quality });
      capture.push(new FakeFrame(1920, 1080, 0));
      await settle();
      await advance(1000);
      FakeEncoder.last!.behaviour = "drop-keyframes";

      pipeline.requestKeyframe();
      for (let i = 0; i < 60; i++) await advance(100); // nothing new is captured meanwhile

      expect(FakeEncoder.created).toBe(2);
      expect(chunks.filter((chunk) => chunk.type === "key")).toHaveLength(2);
      pipeline.stop();
    });

    it("restarts an encoder that stopped putting anything out", async () => {
      const capture = fakeCapture();
      const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });
      await playFrames(capture, 1);
      FakeEncoder.last!.behaviour = "silent"; // hung: takes frames, never answers

      await playFrames(capture, 250); // 4 s of a moving picture

      expect(FakeEncoder.created).toBe(2);
      expect(FakeEncoder.last!.encoded[0]!.keyFrame).toBe(true);
      pipeline.stop();
    });

    it("keeps an encoder whose rate control drops everything for a while: it still takes frames", async () => {
      const capture = fakeCapture();
      const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });
      await playFrames(capture, 1);
      // Replacing it would count as a failure and push it toward the software encoder.
      FakeEncoder.last!.behaviour = "drop-all";

      await playFrames(capture, 250);

      expect(FakeEncoder.created).toBe(1);
      pipeline.stop();
    });

    it("brings a failed encoder back on a still screen once a viewer needs a keyframe", async () => {
      const capture = fakeCapture();
      const chunks: Array<{ type: string; timestamp: number }> = [];
      const pipeline = await startVideoEncodePipeline(track, (chunk) => chunks.push(chunk), { quality });
      capture.push(new FakeFrame(1920, 1080, 0));
      await settle();
      await advance(1000);
      FakeEncoder.last!.fail();

      pipeline.requestKeyframe();
      for (let i = 0; i < 20; i++) await advance(100); // nothing new is captured meanwhile

      expect(FakeEncoder.created).toBe(2);
      expect(chunks.filter((chunk) => chunk.type === "key")).toHaveLength(2);
      pipeline.stop();
    });

    it("leaves a still screen's encoder alone: no frames offered is not a hang", async () => {
      const capture = fakeCapture();
      const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });
      await playFrames(capture, 1);

      for (let i = 0; i < 100; i++) await advance(100); // 10 s with nothing new captured
      await playFrames(capture, 5);

      expect(FakeEncoder.created).toBe(1);
      pipeline.stop();
    });
  });

  it("repeats nothing while paused or once no keyframe is due", async () => {
    const capture = fakeCapture();
    const pipeline = await startVideoEncodePipeline(track, () => undefined, { quality });
    capture.push(new FakeFrame(1920, 1080, 0));
    await settle();

    await advance(2000); // still, but the start keyframe already went out
    pipeline.setPaused(true);
    pipeline.requestKeyframe();
    await advance(1000);

    expect(FakeEncoder.last!.encoded).toHaveLength(1);
    pipeline.stop();
  });
});
