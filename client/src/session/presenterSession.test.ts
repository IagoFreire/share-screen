import { describe, expect, it } from "vitest";
import {
  buildQualityPreset,
  planLayers,
  FrameType,
  type ControlMessage,
  type FrameHeader,
} from "@screenshare-bot/shared";
import { createPresenterSession, type PresenterSessionDeps } from "./presenterSession.js";

const QUALITY = buildQualityPreset("720p", 30, "balanced");

/** A MediaStreamTrack stand-in that can be ended from the test. */
function fakeTrack() {
  const listeners: Array<() => void> = [];
  return {
    track: {
      addEventListener: (type: string, listener: () => void) => {
        if (type === "ended") listeners.push(listener);
      },
    } as unknown as MediaStreamTrack,
    end: () => listeners.forEach((listener) => listener()),
  };
}

function fakeChunk(bytes: number[], timestampUs: number, type: "key" | "delta" = "delta") {
  return {
    byteLength: bytes.length,
    timestamp: timestampUs,
    type,
    copyTo: (target: Uint8Array) => target.set(bytes),
  };
}

function setup(options: { withAudio?: boolean } = {}) {
  const video = fakeTrack();
  const frames: Array<{ header: FrameHeader; payload: Uint8Array }> = [];
  const controls: ControlMessage[] = [];
  let emitVideo: (chunk: ReturnType<typeof fakeChunk>) => void = () => {};
  let keyframeRequests = 0;
  let videoStops = 0;

  const deps: PresenterSessionDeps = {
    sendFrame: (header, payload) => frames.push({ header, payload }),
    sendControl: (message) => controls.push(message),
    capture: async () => ({
      stream: {} as MediaStream,
      videoTrack: video.track,
      audioTrack: options.withAudio === false ? null : ({} as MediaStreamTrack),
    }),
    startVideo: async (_track, onChunk) => {
      emitVideo = (chunk) => onChunk(chunk as unknown as EncodedVideoChunk);
      return {
        requestKeyframe: () => {
          keyframeRequests += 1;
        },
        stop: () => {
          videoStops += 1;
        },
      };
    },
    startAudio: async () => ({ params: { sampleRate: 48000, channels: 2 }, stop: () => {} }),
    presenterId: "42",
  };

  return {
    session: createPresenterSession(deps),
    frames,
    controls,
    endSource: video.end,
    emitVideo: (chunk: ReturnType<typeof fakeChunk>) => emitVideo(chunk),
    keyframeRequests: () => keyframeRequests,
    videoStops: () => videoStops,
  };
}

describe("presenter session", () => {
  it("start sends start-presenting with the audio params", async () => {
    const { session, controls } = setup();

    await session.start(QUALITY);

    expect(session.isPresenting).toBe(true);
    expect(controls).toEqual([
      { kind: "start-presenting", presenterId: "42", audio: { sampleRate: 48000, channels: 2 } },
    ]);
  });

  it("video frames carry the slot from presenting-started and an increasing clock", async () => {
    const { session, frames, emitVideo } = setup();
    await session.start(QUALITY);

    expect(session.handleControl({ kind: "presenting-started", slot: 3 })).toBe(true);
    emitVideo(fakeChunk([9, 8], 5000, "key"));
    emitVideo(fakeChunk([7], 6000));

    expect(frames.map((frame) => frame.header)).toEqual([
      { slot: 3, type: FrameType.Video, timestamp: 5, clock: 1, keyFrame: true },
      { slot: 3, type: FrameType.Video, timestamp: 6, clock: 2, keyFrame: false },
    ]);
    expect(Array.from(frames[0].payload)).toEqual([9, 8]);
  });

  it("request-keyframe reaches the video pipeline", async () => {
    const { session, keyframeRequests } = setup();
    await session.start(QUALITY);

    expect(session.handleControl({ kind: "request-keyframe" })).toBe(true);

    expect(keyframeRequests()).toBe(1);
  });

  it("stop is idempotent and sends stop-presenting once", async () => {
    const { session, controls, videoStops } = setup();
    await session.start(QUALITY);

    session.stop();
    session.stop();

    expect(session.isPresenting).toBe(false);
    expect(controls.filter((message) => message.kind === "stop-presenting")).toHaveLength(1);
    expect(videoStops()).toBe(1);
  });

  it("a source that ends stops the session and notifies onEnded", async () => {
    const { session, controls, endSource } = setup();
    let endedCalls = 0;
    session.onEnded(() => {
      endedCalls += 1;
    });
    await session.start(QUALITY);

    endSource();

    expect(session.isPresenting).toBe(false);
    expect(endedCalls).toBe(1);
    expect(controls.at(-1)).toEqual({ kind: "stop-presenting" });
  });

  it("a stop requested by the server ends the session and notifies onEnded", async () => {
    const { session } = setup();
    let endedCalls = 0;
    session.onEnded(() => {
      endedCalls += 1;
    });
    await session.start(QUALITY);

    expect(session.handleControl({ kind: "request-stop-presenting" })).toBe(true);

    expect(session.isPresenting).toBe(false);
    expect(endedCalls).toBe(1);
  });

  it("start without an audio track reports hasAudio false", async () => {
    const { session, controls } = setup({ withAudio: false });

    expect(await session.start(QUALITY)).toEqual({ hasAudio: false });
    expect(controls[0]).toEqual({ kind: "start-presenting", presenterId: "42", audio: null });
  });

  it("ignores control messages that aren't presenter business", () => {
    const { session } = setup();
    expect(session.handleControl({ kind: "viewer-count", count: 2 })).toBe(false);
  });
});

describe("presenter session simulcast", () => {
  const LAYERS = planLayers(buildQualityPreset("1080p", 60, "balanced"));

  function simulcastSetup() {
    const clones: Array<{ constraints: MediaTrackConstraints | null; stopped: boolean }> = [];
    const captured = {
      addEventListener: () => {},
      clone: () => {
        const clone = { constraints: null as MediaTrackConstraints | null, stopped: false };
        clones.push(clone);
        return {
          applyConstraints: async (constraints: MediaTrackConstraints) => {
            clone.constraints = constraints;
          },
          stop: () => {
            clone.stopped = true;
          },
        } as unknown as MediaStreamTrack;
      },
    } as unknown as MediaStreamTrack;
    const emitters: Array<(chunk: ReturnType<typeof fakeChunk>) => void> = [];
    const keyframes: number[] = [];
    const frames: FrameHeader[] = [];
    const controls: ControlMessage[] = [];

    const session = createPresenterSession({
      sendFrame: (header) => frames.push(header),
      sendControl: (message) => controls.push(message),
      capture: async () => ({ stream: {} as MediaStream, videoTrack: captured, audioTrack: null }),
      startVideo: async (_track, onChunk) => {
        const index = emitters.length;
        emitters.push((chunk) => onChunk(chunk as unknown as EncodedVideoChunk));
        keyframes.push(0);
        return {
          requestKeyframe: () => {
            keyframes[index] += 1;
          },
          stop: () => {},
        };
      },
      startAudio: async () => ({ params: { sampleRate: 48000, channels: 2 }, stop: () => {} }),
      presenterId: "42",
    });
    return { session, clones, emitters, keyframes, frames, controls };
  }

  it("encodes one version per layer, each tagged with its layer and its own clock", async () => {
    const { session, emitters, frames } = simulcastSetup();
    await session.start(LAYERS[0], LAYERS);

    emitters[2](fakeChunk([1], 1000, "key"));
    emitters[0](fakeChunk([2], 1000, "key"));

    expect(emitters).toHaveLength(3);
    expect(frames.map((frame) => [frame.layer, frame.clock])).toEqual([
      [2, 1],
      [0, 1],
    ]);
  });

  it("scales the lower layers down from clones of the capture", async () => {
    const { session, clones } = simulcastSetup();
    await session.start(LAYERS[0], LAYERS);

    expect(clones.map((clone) => clone.constraints)).toEqual([
      { height: { ideal: 720 }, frameRate: { ideal: 30 } },
      { height: { ideal: 480 }, frameRate: { ideal: 30 } },
    ]);
  });

  it("announces its layers when going live", async () => {
    const { session, controls } = simulcastSetup();
    await session.start(LAYERS[0], LAYERS);

    expect(controls[0]).toMatchObject({
      kind: "start-presenting",
      layers: [
        { layer: 0, height: 1080, framerate: 60 },
        { layer: 1, height: 720, framerate: 30 },
        { layer: 2, height: 480, framerate: 30 },
      ],
    });
  });

  it("a keyframe request for one layer only reaches that encoder", async () => {
    const { session, keyframes } = simulcastSetup();
    await session.start(LAYERS[0], LAYERS);

    session.handleControl({ kind: "request-keyframe", layer: 1 });

    expect(keyframes).toEqual([0, 1, 0]);
  });

  it("stopping also stops the cloned tracks", async () => {
    const { session, clones } = simulcastSetup();
    await session.start(LAYERS[0], LAYERS);

    session.stop();

    expect(clones.every((clone) => clone.stopped)).toBe(true);
  });
});
