import { describe, expect, it } from "vitest";
import { createBitrateController, createUplinkGate, uplinkHighWaterBytes } from "./uplinkGate.js";

const HIGH = 1000;

describe("uplink gate", () => {
  it("sends while the socket keeps up", () => {
    const gate = createUplinkGate(HIGH);

    expect(gate.admit(false, 0)).toBe("send");
    expect(gate.admit(false, HIGH)).toBe("send");
  });

  it("drops video as congested once the socket backs up past the high-water mark", () => {
    expect(createUplinkGate(HIGH).admit(false, HIGH + 1)).toBe("congested");
  });

  it("after a drop holds the deltas back and asks for one keyframe once the socket drains", () => {
    const gate = createUplinkGate(HIGH);
    gate.admit(false, HIGH + 1);

    // Still draining: no point asking for an expensive frame yet.
    expect(gate.admit(false, HIGH * 0.8)).toBe("drop");
    expect(gate.admit(false, HIGH * 0.4)).toBe("drop-and-request-keyframe");
    expect(gate.admit(false, 0)).toBe("drop");
    expect(gate.admit(true, 0)).toBe("send");
    expect(gate.admit(false, 0)).toBe("send");
  });

  it("asks again when the keyframe it asked for gets dropped too", () => {
    const gate = createUplinkGate(HIGH);
    gate.admit(false, HIGH + 1);
    gate.admit(false, 0); // requested

    expect(gate.admit(true, HIGH + 1)).toBe("congested");
    expect(gate.admit(false, 0)).toBe("drop-and-request-keyframe");
  });
});

describe("uplink high-water mark", () => {
  it("allows a bit over half a second of the broadcast plus room for a keyframe", () => {
    // 6 Mbps: 450 kB of queue plus 256 kB of slack.
    expect(uplinkHighWaterBytes(6_000_000)).toBe(450_000 + 256 * 1024);
  });
});

describe("bitrate controller", () => {
  it("lowers the bitrate on congestion", () => {
    expect(createBitrateController().onCongestion(1000)).toBeCloseTo(0.8);
  });

  it("lowers at most once per settling period", () => {
    const controller = createBitrateController();
    controller.onCongestion(1000);

    expect(controller.onCongestion(2000)).toBeNull();
    expect(controller.onCongestion(3000)).toBeCloseTo(0.64);
  });

  it("never goes below half the target", () => {
    const controller = createBitrateController();
    let scale: number | null = 1;
    for (let at = 0; at < 60_000; at += 2000) scale = controller.onCongestion(at) ?? scale;

    expect(scale).toBe(0.5);
  });

  it("climbs back slowly once the link stays clean", () => {
    const controller = createBitrateController();
    controller.onCongestion(1000);

    expect(controller.onHealthy(5000)).toBeNull();
    expect(controller.onHealthy(11_000)).toBeCloseTo(0.92);
    expect(controller.onHealthy(12_000)).toBeNull();
    expect(controller.onHealthy(16_000)).toBeCloseTo(1);
    expect(controller.onHealthy(30_000)).toBeNull(); // already at the target
  });
});
