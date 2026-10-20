import { describe, expect, it } from "vitest";
import { buildQualityPreset, planLayers } from "./constants.js";
import { decodeFrame, encodeFrame, FrameType } from "./protocol.js";

describe("frame encoding", () => {
  it("encodeFrame/decodeFrame round-trips header and payload", () => {
    const encoded = encodeFrame(
      { slot: 2, type: FrameType.Video, timestamp: 1234.5, clock: 7, keyFrame: true },
      new Uint8Array([1, 2, 3]),
    );

    const decoded = decodeFrame(encoded);

    expect(decoded.slot).toBe(2);
    expect(decoded.type).toBe(FrameType.Video);
    expect(decoded.timestamp).toBe(1234.5);
    expect(decoded.clock).toBe(7);
    expect(decoded.keyFrame).toBe(true);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3]);
  });

  it("carries the simulcast layer alongside the keyframe flag", () => {
    const encoded = encodeFrame(
      { slot: 1, type: FrameType.Video, timestamp: 1, clock: 1, keyFrame: true, layer: 2 },
      new Uint8Array([0]),
    );

    const decoded = decodeFrame(encoded);

    expect(decoded.layer).toBe(2);
    expect(decoded.keyFrame).toBe(true);
  });

  it("reads frames from single-layer senders as layer 0", () => {
    const decoded = decodeFrame(encodeFrame({ slot: 1, type: FrameType.Video, timestamp: 1, clock: 1 }, new Uint8Array([0])));
    expect(decoded.layer).toBe(0);
  });
});

describe("planLayers", () => {
  it("adds 720p30 and 480p30 under a 1080p60 top layer", () => {
    const layers = planLayers(buildQualityPreset("1080p", 60, "high"));

    expect(layers.map((layer) => `${layer.height}p${layer.framerate}`)).toEqual(["1080p60", "720p30", "480p30"]);
    expect(layers[0].bitrateKbps).toBe(buildQualityPreset("1080p", 60, "high").bitrateKbps);
    expect(layers[1].bitrateKbps).toBe(buildQualityPreset("720p", 30, "balanced").bitrateKbps);
  });

  it("only keeps layers below the top one", () => {
    expect(planLayers(buildQualityPreset("720p", 30, "balanced")).map((layer) => layer.height)).toEqual([720, 480]);
    expect(planLayers(buildQualityPreset("480p", 60, "balanced")).map((layer) => layer.height)).toEqual([480]);
  });
});
