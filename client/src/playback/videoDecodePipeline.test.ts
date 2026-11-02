import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVideoDecodePipeline } from "./videoDecodePipeline.js";

/** Stands in for the browser's VideoDecoder; the test emits its output frames by hand. */
class FakeDecoder {
  static last: FakeDecoder | null = null;
  static created = 0;
  static isConfigSupported = async () => ({ supported: true });
  state = "unconfigured";
  decodeQueueSize = 0;
  decoded: Array<{ type: string; timestamp: number }> = [];
  throwOnDecode = false;
  constructor(public init: { output: (frame: unknown) => void; error: (error: unknown) => void }) {
    FakeDecoder.last = this;
    FakeDecoder.created += 1;
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: { type: string; timestamp: number }) {
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
        timestamp: number;
        constructor(init: { type: string; timestamp: number }) {
          this.type = init.type;
          this.timestamp = init.timestamp;
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

  describe("a clock far behind the picture", () => {
    // A hardware decoder outputs into a pool of ~15 surfaces (measured in Chrome) and every
    // held VideoFrame keeps one. Holding 17-34 frames for the audio clock stopped the
    // decoder in a real live, and its restarts froze the picture every few seconds.
    const chunkAt = (i: number) => ({ keyFrame: i === 0, timestampUs: 1_000_000 + i * FRAME_US, data: new Uint8Array(1) });

    /** Lets the fake decoder output every chunk it was handed, as a real one with free surfaces would. */
    function drain(decoder: FakeDecoder, outputs: { count: number }) {
      while (outputs.count < decoder.decoded.length) {
        decoder.init.output(fakeFrame(decoder.decoded[outputs.count++]!.timestamp));
      }
    }

    it("hands the decoder only a few frames ahead of the screen, keeping the rest encoded", async () => {
      const clock = { setSource: vi.fn(), currentTimestampUs: () => 0 };
      const pipeline = await startVideoDecodePipeline(fakeCanvas(), { clock });
      const outputs = { count: 0 };

      for (let i = 0; i < 40; i++) {
        pipeline.decodeChunk(chunkAt(i));
        drain(FakeDecoder.last!, outputs);
      }

      expect(FakeDecoder.last!.decoded.length).toBeLessThanOrEqual(6);
      expect(pipeline.stats().queuedFrames).toBeLessThanOrEqual(6);
      expect(pipeline.stats().bufferedChunks).toBe(40 - FakeDecoder.last!.decoded.length);
    });

    it("keeps feeding the decoder in order as the clock reaches the held frames", async () => {
      let nowUs = 0;
      const clock = { setSource: vi.fn(), currentTimestampUs: () => nowUs };
      const pipeline = await startVideoDecodePipeline(fakeCanvas(), { clock });
      const outputs = { count: 0 };
      for (let i = 0; i < 40; i++) {
        pipeline.decodeChunk(chunkAt(i));
        drain(FakeDecoder.last!, outputs);
      }

      nowUs = chunkAt(20).timestampUs;
      pipeline.decodeChunk(chunkAt(40));
      drain(FakeDecoder.last!, outputs);
      expect(FakeDecoder.last!.decoded.length).toBeGreaterThan(21);
      expect(pipeline.stats().queuedFrames).toBeLessThanOrEqual(6);

      nowUs = chunkAt(100).timestampUs;
      pipeline.decodeChunk(chunkAt(41));
      drain(FakeDecoder.last!, outputs);
      expect(FakeDecoder.last!.decoded.map((chunk) => chunk.timestamp)).toEqual(
        Array.from({ length: 42 }, (_, i) => chunkAt(i).timestampUs),
      );
      expect(FakeDecoder.created).toBe(1);
    });
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

  describe("a decoder falling behind", () => {
    let perfNow = 0;
    beforeEach(() => {
      perfNow = 0;
      vi.spyOn(performance, "now").mockImplementation(() => perfNow);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("drops the backlog and says so when chunks wait in it for seconds", async () => {
      const onKeyframeNeeded = vi.fn();
      const onOverload = vi.fn();
      const pipeline = await startVideoDecodePipeline(fakeCanvas(), { onKeyframeNeeded, onOverload });
      pipeline.decodeChunk(key); // never comes out

      perfNow = 2500;
      pipeline.decodeChunk({ ...delta, timestampUs: 16_667 });

      expect(FakeDecoder.created).toBe(2);
      expect(onOverload).toHaveBeenCalledTimes(1);
      expect(onKeyframeNeeded).toHaveBeenCalledTimes(1);
      expect(pipeline.stats().overloads).toBe(1);
    });

    it("runs a backlog behind the clock through to live instead of leaving it stuck", async () => {
      // After a minimized stretch a backlog used to stay ~1 s behind for good: held frames
      // starved the decoder, so it decoded only as fast as frames were shown. Frames
      // already behind the clock now come out, get dropped, and free room at once.
      const clock = { setSource: vi.fn(), currentTimestampUs: () => 1_000_000 };
      const onOverload = vi.fn();
      const pipeline = await startVideoDecodePipeline(fakeCanvas(), { clock, onOverload });
      const decoder = FakeDecoder.last!;
      let outputs = 0;

      for (let i = 0; i <= 60; i++) {
        pipeline.decodeChunk({ keyFrame: i === 0, timestampUs: i * FRAME_US, data: new Uint8Array(1) });
      }
      while (outputs < decoder.decoded.length) decoder.init.output(fakeFrame(decoder.decoded[outputs++]!.timestamp));

      expect(decoder.decoded).toHaveLength(61);
      expect(pipeline.stats().bufferedChunks).toBe(0);
      // The newest due frame waits for a paint, and the last one isn't due yet.
      expect(pipeline.stats().queuedFrames).toBeLessThanOrEqual(2);
      expect(FakeDecoder.created).toBe(1);
      expect(onOverload).not.toHaveBeenCalled();
    });

    it("leaves a busy decoder alone while it keeps up", async () => {
      // A hardware decoder routinely holds dozens of chunks while decoded frames wait in
      // the jitter buffer; counting them as overload killed the decoder over and over.
      const onOverload = vi.fn();
      const pipeline = await startVideoDecodePipeline(fakeCanvas(), { onOverload });
      for (let t = 0; t <= 5000; t += 100) {
        perfNow = t;
        FakeDecoder.last!.decodeQueueSize = 100;
        pipeline.decodeChunk({ keyFrame: t === 0, timestampUs: t * 1000, data: new Uint8Array(1) });
        FakeDecoder.last!.init.output(fakeFrame(t * 1000));
      }

      expect(FakeDecoder.created).toBe(1);
      expect(onOverload).not.toHaveBeenCalled();
    });

    it("doesn't judge the decoder while the window is hidden", async () => {
      vi.stubGlobal("document", { visibilityState: "hidden" });
      const onOverload = vi.fn();
      const pipeline = await startVideoDecodePipeline(fakeCanvas(), { onOverload });
      pipeline.decodeChunk(key);

      perfNow = 10_000;
      pipeline.decodeChunk({ ...delta, timestampUs: 16_667 });

      expect(FakeDecoder.created).toBe(1);
      expect(onOverload).not.toHaveBeenCalled();
    });

    it("resyncToLive also throws away what is still inside the decoder", async () => {
      const pipeline = await startVideoDecodePipeline(fakeCanvas());
      pipeline.decodeChunk(key);

      pipeline.resyncToLive();
      pipeline.decodeChunk(delta);
      pipeline.decodeChunk(key);

      expect(FakeDecoder.created).toBe(2);
      expect(FakeDecoder.last!.decoded.map((chunk) => chunk.type)).toEqual(["key"]);
    });
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
