import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVideoDecodePipeline } from "./videoDecodePipeline.js";

/** Stands in for the browser's VideoDecoder; the test emits its output frames by hand. */
class FakeDecoder {
  static last: FakeDecoder | null = null;
  static created = 0;
  static isConfigSupported = async () => ({ supported: true });
  state = "unconfigured";
  decodeQueueSize = 0;
  decoded: Array<{ type: string }> = [];
  throwOnDecode = false;
  constructor(public init: { output: (frame: unknown) => void; error: (error: unknown) => void }) {
    FakeDecoder.last = this;
    FakeDecoder.created += 1;
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: { type: string }) {
    if (this.throwOnDecode) throw new DOMException("not a keyframe", "DataError");
    this.decoded.push(chunk);
  }
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
    FakeDecoder.created = 0;
    vi.stubGlobal("VideoDecoder", FakeDecoder);
    vi.stubGlobal(
      "EncodedVideoChunk",
      class {
        type: string;
        constructor(init: { type: string }) {
          this.type = init.type;
        }
      },
    );
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

  const key = { keyFrame: true, timestampUs: 0, data: new Uint8Array(1) };
  const delta = { keyFrame: false, timestampUs: 0, data: new Uint8Array(1) };

  it("rebuilds a decoder that failed, then resumes on the next keyframe", async () => {
    const onKeyframeNeeded = vi.fn();
    const pipeline = await startVideoDecodePipeline(fakeCanvas(), { onKeyframeNeeded });
    pipeline.decodeChunk(key);
    const failed = FakeDecoder.last!;

    // WebCodecs closes a decoder for good when decoding fails.
    failed.state = "closed";
    failed.init.error(new DOMException("decode failed", "EncodingError"));
    pipeline.decodeChunk(delta);
    pipeline.decodeChunk(key);

    expect(onKeyframeNeeded).toHaveBeenCalledTimes(1);
    expect(FakeDecoder.created).toBe(2);
    expect(FakeDecoder.last!.decoded.map((chunk) => chunk.type)).toEqual(["key"]);
  });

  it("waits for a keyframe when the browser refuses a chunk outright", async () => {
    const onKeyframeNeeded = vi.fn();
    const pipeline = await startVideoDecodePipeline(fakeCanvas(), { onKeyframeNeeded });
    pipeline.decodeChunk(key);
    FakeDecoder.last!.throwOnDecode = true;

    pipeline.decodeChunk(delta);
    FakeDecoder.last!.throwOnDecode = false;
    pipeline.decodeChunk(delta);

    expect(onKeyframeNeeded).toHaveBeenCalledTimes(1);
    expect(FakeDecoder.last!.decoded.map((chunk) => chunk.type)).toEqual(["key"]);
  });

  it("drops the decoder's backlog when this machine falls seconds behind the stream", async () => {
    const onKeyframeNeeded = vi.fn();
    const onOverload = vi.fn();
    const pipeline = await startVideoDecodePipeline(fakeCanvas(), { onKeyframeNeeded, onOverload });
    pipeline.decodeChunk(key);
    FakeDecoder.last!.init.output(fakeFrame(0)); // decoded up to t=0...

    pipeline.decodeChunk({ ...delta, timestampUs: 3_000_000 }); // ...while chunks reach t=3 s

    expect(FakeDecoder.created).toBe(2);
    expect(onOverload).toHaveBeenCalledTimes(1);
    expect(onKeyframeNeeded).toHaveBeenCalledTimes(1);
    expect(pipeline.stats().overloads).toBe(1);
  });

  it("leaves a busy decoder alone while it keeps up with the stream", async () => {
    // A hardware decoder routinely holds dozens of chunks while decoded frames wait in
    // the jitter buffer; counting them as overload killed the decoder over and over.
    const onOverload = vi.fn();
    const pipeline = await startVideoDecodePipeline(fakeCanvas(), { onOverload });
    pipeline.decodeChunk(key);
    FakeDecoder.last!.init.output(fakeFrame(0));
    FakeDecoder.last!.decodeQueueSize = 100;

    pipeline.decodeChunk({ ...delta, timestampUs: 500_000 });

    expect(FakeDecoder.created).toBe(1);
    expect(onOverload).not.toHaveBeenCalled();
  });

  it("awaitKeyframe holds deltas back until the next keyframe (a frame went missing)", async () => {
    const pipeline = await startVideoDecodePipeline(fakeCanvas());
    pipeline.decodeChunk(key);

    pipeline.awaitKeyframe();
    pipeline.decodeChunk(delta);
    pipeline.decodeChunk(key);

    expect(FakeDecoder.last!.decoded.map((chunk) => chunk.type)).toEqual(["key", "key"]);
  });
});
