import { describe, expect, it } from "vitest";
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
});
