import { describe, expect, it } from "vitest";
import { chooseDevice } from "./voiceDevices.js";
import { createVoiceSchedule } from "./voiceSchedule.js";

const device = (deviceId: string, label = deviceId) => ({ deviceId, label });

describe("chooseDevice", () => {
  it("keeps the device the user picked while it is plugged in", () => {
    expect(chooseDevice([device("default"), device("usb")], "usb")).toBe("usb");
  });

  it("falls back to the system default when the picked one is gone", () => {
    expect(chooseDevice([device("default"), device("usb")], "headset")).toBe("default");
  });

  it("uses the first device when there is no default entry", () => {
    expect(chooseDevice([device("a"), device("b")], null)).toBe("a");
  });

  it("has nothing to choose without devices", () => {
    expect(chooseDevice([], "usb")).toBeNull();
  });
});

describe("voice schedule", () => {
  it("plays the first packet one jitter buffer from now", () => {
    const schedule = createVoiceSchedule(0.08);
    expect(schedule.startTime(1_000_000, 10)).toBeCloseTo(10.08);
  });

  it("places later packets by their timestamps, not their arrival", () => {
    const schedule = createVoiceSchedule(0.08);
    schedule.startTime(1_000_000, 10);

    expect(schedule.startTime(1_020_000, 10.001)).toBeCloseTo(10.1);
    expect(schedule.startTime(1_040_000, 10.03)).toBeCloseTo(10.12);
  });

  it("re-anchors after running dry instead of playing into the past", () => {
    const schedule = createVoiceSchedule(0.08);
    schedule.startTime(1_000_000, 10);

    // A packet that should have started at 10.10 arrives at 10.5: start over from now.
    expect(schedule.startTime(1_020_000, 10.5)).toBeCloseTo(10.58);
    expect(schedule.startTime(1_040_000, 10.52)).toBeCloseTo(10.6);
  });

  it("re-anchors when a backlog would pile up too far ahead", () => {
    const schedule = createVoiceSchedule(0.08);
    schedule.startTime(1_000_000, 10);

    // Timestamps jump a second ahead of where playback is: catch up instead of lagging.
    expect(schedule.startTime(2_000_000, 10.02)).toBeCloseTo(10.1);
  });
});
