import { afterEach, describe, expect, it, vi } from "vitest";
import { startAudioEncodePipeline } from "./audioEncodePipeline.js";

/** What the pipeline asked MediaStreamTrackProcessor for. */
let processorInit: { maxBufferSize?: number } | null = null;
/** What the pipeline configured the Opus encoder with. */
let encoderConfig: AudioEncoderConfig | null = null;

function stubBrowserAudio(): void {
  vi.stubGlobal(
    "AudioEncoder",
    class {
      static isConfigSupported = async () => ({ supported: true });
      state = "unconfigured";
      configure(config: AudioEncoderConfig) {
        encoderConfig = config;
        this.state = "configured";
      }
      encode() {}
      close() {
        this.state = "closed";
      }
    },
  );
  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readable = { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) };
      constructor(init: { maxBufferSize?: number }) {
        processorInit = init;
      }
    },
  );
}

const track = { getSettings: () => ({ sampleRate: 48000, channelCount: 2 }) } as unknown as MediaStreamTrack;

describe("audio encode pipeline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    processorInit = null;
    encoderConfig = null;
  });

  it("encodes at 160 kbps with full effort unless told otherwise", async () => {
    stubBrowserAudio();

    (await startAudioEncodePipeline(track, () => {})).stop();

    expect(encoderConfig?.bitrate).toBe(160_000);
    expect(encoderConfig?.opus?.complexity).toBe(10);
  });

  it("encodes at the bitrate and effort it is given", async () => {
    stubBrowserAudio();

    (await startAudioEncodePipeline(track, () => {}, { bitrateKbps: 64, complexity: 5 })).stop();

    expect(encoderConfig?.bitrate).toBe(64_000);
    expect(encoderConfig?.opus?.complexity).toBe(5);
  });

  it("keeps a stalled page's audio instead of letting the track drop it", async () => {
    // Chromium keeps only 10 audio frames (~100 ms) by default and discards the oldest
    // beyond that, so any longer stall cut holes in the audio.
    stubBrowserAudio();

    const pipeline = await startAudioEncodePipeline(track, () => {});
    pipeline.stop();

    expect(processorInit?.maxBufferSize ?? 0).toBeGreaterThanOrEqual(50);
  });
});
