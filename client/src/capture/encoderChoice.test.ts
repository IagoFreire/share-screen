import { describe, expect, it } from "vitest";
import { encoderAttempts, VIDEO_CODEC_BASELINE, VIDEO_CODEC_HIGH } from "./encoderChoice.js";

describe("encoderAttempts", () => {
  it("lets the browser pick the encoder for a normal live", () => {
    expect(encoderAttempts({ lowPower: false, softwareOnly: false })).toEqual([
      { codec: VIDEO_CODEC_HIGH, hardwareAcceleration: "no-preference" },
    ]);
  });

  it("keeps High on the software fallback of a normal live", () => {
    expect(encoderAttempts({ lowPower: false, softwareOnly: true })).toEqual([
      { codec: VIDEO_CODEC_HIGH, hardwareAcceleration: "prefer-software" },
    ]);
  });

  it("Potato asks for the GPU encoder first, then a Baseline software one", () => {
    expect(encoderAttempts({ lowPower: true, softwareOnly: false })).toEqual([
      { codec: VIDEO_CODEC_HIGH, hardwareAcceleration: "prefer-hardware" },
      { codec: VIDEO_CODEC_BASELINE, hardwareAcceleration: "prefer-software" },
    ]);
  });

  it("Potato goes straight to Baseline software once the GPU encoder kept failing", () => {
    expect(encoderAttempts({ lowPower: true, softwareOnly: true })).toEqual([
      { codec: VIDEO_CODEC_BASELINE, hardwareAcceleration: "prefer-software" },
    ]);
  });
});
