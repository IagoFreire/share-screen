import { describe, expect, it } from "vitest";
import { cleanDeviceLabel } from "./voiceDevices.js";
import { createVoiceGate, dbOfRms, GATE_HOLD_MS, LEVEL_FLOOR_DB, levelOfDb, rmsOf } from "./voiceLevel.js";
import { clampSensitivity, clampVolume, MAX_VOLUME } from "./voicePrefs.js";

describe("loudness scale", () => {
  it("measures a full-scale square wave at 0 dB and silence at -Infinity", () => {
    expect(dbOfRms(rmsOf(new Float32Array([1, -1, 1, -1])))).toBeCloseTo(0);
    expect(dbOfRms(rmsOf(new Float32Array(4)))).toBe(-Infinity);
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });

  it("maps the floor to 0, full scale to 1 and halfway in dB to 0.5", () => {
    expect(levelOfDb(-Infinity)).toBe(0);
    expect(levelOfDb(LEVEL_FLOOR_DB - 10)).toBe(0);
    expect(levelOfDb(LEVEL_FLOOR_DB / 2)).toBeCloseTo(0.5);
    expect(levelOfDb(0)).toBe(1);
    expect(levelOfDb(6)).toBe(1);
  });
});

describe("createVoiceGate", () => {
  it("lets audio at or above the sensitivity through", () => {
    const gate = createVoiceGate();
    expect(gate.pass(-30, -50, 0)).toBe(true);
    expect(gate.pass(-50, -50, 20)).toBe(true);
  });

  it("stays closed for audio below the sensitivity", () => {
    const gate = createVoiceGate();
    expect(gate.pass(-60, -50, 0)).toBe(false);
    expect(gate.pass(-Infinity, -50, 20)).toBe(false);
  });

  it("holds open through a short pause, then closes", () => {
    const gate = createVoiceGate();
    gate.pass(-20, -50, 1000);
    expect(gate.pass(-70, -50, 1000 + GATE_HOLD_MS)).toBe(true);
    expect(gate.pass(-70, -50, 1000 + GATE_HOLD_MS + 20)).toBe(false);
  });
});

describe("voice preferences", () => {
  it("keeps volumes between silent and 200%", () => {
    expect(clampVolume(1.5)).toBe(1.5);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(5)).toBe(MAX_VOLUME);
    expect(clampVolume(Number.NaN)).toBe(1);
  });

  it("keeps the sensitivity on the meter, in whole dB", () => {
    expect(clampSensitivity(-42.4)).toBe(-42);
    expect(clampSensitivity(-200)).toBe(LEVEL_FLOOR_DB);
    expect(clampSensitivity(3)).toBe(0);
    expect(clampSensitivity(Number.NaN)).toBe(-50);
  });
});

describe("cleanDeviceLabel", () => {
  it("drops the USB ids Windows appends", () => {
    expect(cleanDeviceLabel("Microfone do Headset (CORSAIR VIRTUOSO Wireless Gaming Headset) (1b1c:0a44)")).toBe(
      "Microfone do Headset (CORSAIR VIRTUOSO Wireless Gaming Headset)",
    );
  });

  it("leaves other labels alone", () => {
    expect(cleanDeviceLabel("LG ULTRAGEAR (2- NVIDIA High Definition Audio)")).toBe("LG ULTRAGEAR (2- NVIDIA High Definition Audio)");
    expect(cleanDeviceLabel("")).toBe("");
  });
});
