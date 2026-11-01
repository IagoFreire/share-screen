import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaClock } from "./mediaClock.js";
import { startAudioDecodePipeline } from "./audioDecodePipeline.js";

/** What the fake AudioContext saw scheduled: when each packet plays, and until when. */
interface Played {
  start: number;
  /** Context time playback ends: its natural end, or earlier if stopped. */
  end: number;
  timestampUs: number;
}

let ctxTime = 0;
let contextOutputLatency = 0;
/** What every decoded sample holds. */
let sampleValue = 0;
let played: Played[] = [];
let decoders: FakeAudioDecoder[] = [];
let lastDecodedUs = 0;

class FakeAudioContext {
  state = "running";
  baseLatency = 0;
  destination = {};
  get currentTime() {
    return ctxTime;
  }
  get outputLatency() {
    return contextOutputLatency;
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  createBuffer(_channels: number, frames: number, sampleRate: number) {
    return { duration: frames / sampleRate, copyToChannel() {} };
  }
  createBufferSource() {
    const entry: Played = { start: 0, end: 0, timestampUs: 0 };
    return {
      buffer: null as null | { duration: number },
      playbackRate: { value: 1 },
      connect() {},
      start(when: number) {
        entry.start = when;
        entry.end = when + this.buffer!.duration / this.playbackRate.value;
        entry.timestampUs = lastDecodedUs;
        played.push(entry);
      },
      stop(when = 0) {
        entry.end = Math.max(entry.start, Math.min(entry.end, when));
      },
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

class FakeAudioDecoder {
  state = "unconfigured";
  constructor(public init: { output: (data: unknown) => void; error: (error: unknown) => void }) {
    decoders.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: { timestamp: number }) {
    lastDecodedUs = chunk.timestamp;
    this.init.output({
      timestamp: chunk.timestamp,
      numberOfChannels: 2,
      numberOfFrames: 960,
      sampleRate: 48_000,
      format: "f32-planar",
      copyTo(destination: Float32Array) {
        destination.fill(sampleValue);
      },
      close() {},
    });
  }
  close() {
    this.state = "closed";
  }
}

const PACKET_S = 0.02;
const T0_US = 1_000_000_000;

/** Feeds packets in, each at its own arrival time (context seconds). */
function feed(pipeline: ReturnType<typeof startAudioDecodePipeline>, packets: Array<{ tsUs: number; at: number }>) {
  for (const packet of packets) {
    ctxTime = packet.at;
    pipeline.decodeChunk({ timestampUs: packet.tsUs, data: new Uint8Array(1) });
  }
}

/** Longest stretch where two packets play at once, in ms (0 = never). */
function overlapMs(): number {
  const sorted = [...played].filter((p) => p.end > p.start).sort((a, b) => a.start - b.start);
  let overlap = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    overlap = Math.max(overlap, sorted[i - 1]!.end - sorted[i]!.start);
  }
  return overlap * 1000;
}

/** Seams between consecutive packets that are not sample-flush, in ms. */
function seamsMs(): number[] {
  const sorted = [...played].filter((p) => p.end > p.start).sort((a, b) => a.start - b.start);
  const seams: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (sorted[i]!.start - sorted[i - 1]!.end) * 1000;
    if (Math.abs(gap) > 0.01) seams.push(gap);
  }
  return seams;
}

describe("audio decode pipeline", () => {
  beforeEach(() => {
    ctxTime = 0;
    contextOutputLatency = 0;
    sampleValue = 0;
    played = [];
    decoders = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioDecoder", FakeAudioDecoder);
    vi.stubGlobal("EncodedAudioChunk", class {
      timestamp: number;
      constructor(init: { timestamp: number }) {
        this.timestamp = init.timestamp;
      }
    });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("plays a steady stream back to back", () => {
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 });

    feed(
      pipeline,
      Array.from({ length: 500 }, (_, k) => ({ tsUs: T0_US + k * PACKET_S * 1e6, at: 1 + k * PACKET_S })),
    );

    expect(overlapMs()).toBe(0);
    expect(seamsMs()).toEqual([]);
    expect(pipeline.stats().underruns).toBe(0);
  });

  it("never plays two moments of the stream on top of each other after a stall's burst", () => {
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 });

    // 2 s with nothing arriving, then TCP hands the whole backlog over at once.
    feed(
      pipeline,
      Array.from({ length: 1500 }, (_, k) => {
        const sent = 1 + k * PACKET_S;
        const at = sent >= 10 && sent < 12 ? 12 + k * 0.0001 : sent;
        return { tsUs: T0_US + k * PACKET_S * 1e6, at };
      }),
    );

    expect(overlapMs()).toBe(0);
    expect(pipeline.stats().catchUps).toBeGreaterThan(0);
  });

  it("keeps playing seamlessly when the sender's sound card drifts from its clock", () => {
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 });
    const drift = 50e-6;

    // Five minutes: 960 samples per packet, stamped 50 ppm apart from their length.
    feed(
      pipeline,
      Array.from({ length: 15_000 }, (_, k) => {
        const sent = (k * PACKET_S) / (1 + drift);
        return { tsUs: T0_US + sent * 1e6, at: 1 + sent };
      }),
    );

    expect(seamsMs()).toEqual([]);
    expect(overlapMs()).toBe(0);
  });

  it("leaves a real hole in the stream as silence, so sound stays where its timestamps put it", () => {
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 });

    feed(pipeline, [
      { tsUs: T0_US, at: 1 },
      { tsUs: T0_US + 20_000, at: 1.02 },
      { tsUs: T0_US + 140_000, at: 1.14 }, // 100 ms never captured
    ]);

    expect(seamsMs()).toHaveLength(1);
    expect(seamsMs()[0]).toBeCloseTo(100, 1);
  });

  it("drifts the playback rate gently toward the target lead instead of jumping", () => {
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 });

    // Packets arrive 2% early: the buffered lead keeps growing.
    feed(
      pipeline,
      Array.from({ length: 400 }, (_, k) => ({ tsUs: T0_US + k * PACKET_S * 1e6, at: 1 + k * PACKET_S * 0.98 })),
    );

    expect(pipeline.stats().playbackRate).toBeGreaterThan(1);
    expect(pipeline.stats().playbackRate).toBeLessThanOrEqual(1.002);
  });

  it("tells video the timestamp of the sound actually playing", () => {
    const clock = createMediaClock();
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 }, clock);
    feed(pipeline, [
      { tsUs: T0_US, at: 1 },
      { tsUs: T0_US + 20_000, at: 1.02 },
    ]);
    const firstStart = played[0]!.start;

    ctxTime = firstStart + 0.025;

    expect(clock.currentTimestampUs()).toBeCloseTo(T0_US + 25_000, -1);
    void pipeline;
  });

  it("subtracts the output latency and moves smoothly between audio callbacks", () => {
    const clock = createMediaClock();
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 }, clock);
    feed(pipeline, [{ tsUs: T0_US, at: 1 }]);
    const firstStart = played[0]!.start;
    let perfNow = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => perfNow);
    ctxTime = firstStart + 0.1;
    contextOutputLatency = 0.04; // the speakers trail what the context rendered

    const atCallback = clock.currentTimestampUs()! - T0_US;
    perfNow += 5; // between two callbacks currentTime doesn't move
    const fiveMsLater = clock.currentTimestampUs()! - T0_US;
    perfNow += 500; // a stalled context must not run on forever
    const muchLater = clock.currentTimestampUs()! - T0_US;

    expect(atCallback).toBeCloseTo(60_000, -2);
    expect(fiveMsLater - atCallback).toBeCloseTo(5_000, -2);
    expect(muchLater - atCallback).toBeLessThanOrEqual(20_000);
    void pipeline;
  });

  it("never runs the video clock backwards when the next audio callback lands", () => {
    const clock = createMediaClock();
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 }, clock);
    feed(pipeline, [{ tsUs: T0_US, at: 1 }]);
    let perfNow = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => perfNow);
    ctxTime = played[0]!.start + 0.1;

    clock.currentTimestampUs();
    perfNow += 16; // carried forward 16 ms...
    const carried = clock.currentTimestampUs()!;
    ctxTime += 0.01; // ...but the callback only moved currentTime by 10 ms
    const afterCallback = clock.currentTimestampUs()!;

    expect(afterCallback).toBeGreaterThanOrEqual(carried);
    void pipeline;
  });

  it("reports how loud the received sound is, and silence as such", () => {
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 });
    feed(pipeline, [{ tsUs: T0_US, at: 1 }]);
    expect(pipeline.stats().peakDb).toBe(-Infinity);

    sampleValue = 0.5;
    feed(pipeline, [{ tsUs: T0_US + 20_000, at: 1.02 }]);

    expect(pipeline.stats().peakDb).toBeCloseTo(-6, 0);
  });

  it("reset silences everything already scheduled, for a switch to another broadcast", () => {
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 });
    feed(pipeline, [
      { tsUs: T0_US, at: 1 },
      { tsUs: T0_US + 20_000, at: 1.02 },
    ]);

    pipeline.reset();

    expect(played.every((p) => p.end <= Math.max(p.start, ctxTime))).toBe(true);
  });

  it("rebuilds a decoder that failed instead of staying silent", () => {
    const pipeline = startAudioDecodePipeline({ sampleRate: 48_000, channels: 2 });
    decoders[0]!.state = "closed"; // what WebCodecs does after an error

    feed(pipeline, [{ tsUs: T0_US, at: 1 }]);

    expect(decoders).toHaveLength(2);
    expect(played).toHaveLength(1);
  });
});
