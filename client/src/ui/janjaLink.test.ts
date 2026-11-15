import { describe, expect, it } from "vitest";
import { canTryLinkSilently, janjaTransmitLink } from "./janjaLink.js";

describe("janjaTransmitLink", () => {
  it("carries the room and guild", () => {
    expect(janjaTransmitLink("i-123", "987")).toBe("janja://transmit?room=i-123&guild=987");
  });

  it("leaves the guild out when there is none, and encodes the room", () => {
    expect(janjaTransmitLink("voice:lounge", null)).toBe("janja://transmit?room=voice%3Alounge");
  });
});

describe("canTryLinkSilently", () => {
  it("only fires the link unasked in Chromium browsers", () => {
    expect(canTryLinkSilently({ userAgentData: {} } as unknown as Navigator)).toBe(true);
    expect(canTryLinkSilently({} as Navigator)).toBe(false);
  });
});
