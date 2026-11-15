import { describe, expect, it } from "vitest";
import { findTransmitLink, parseTransmitLink } from "./deepLink";

describe("parseTransmitLink", () => {
  it("reads the room and guild of a transmit link", () => {
    expect(parseTransmitLink("janja://transmit?room=i-123abc&guild=987654321")).toEqual({
      roomId: "i-123abc",
      guildId: "987654321",
    });
  });

  it("takes a voice-room live without a guild", () => {
    expect(parseTransmitLink("janja://transmit?room=voice:lounge")).toEqual({ roomId: "voice:lounge", guildId: null });
  });

  it.each([
    ["another scheme", "https://transmit?room=abc"],
    ["another action", "janja://logout?room=abc"],
    ["no room", "janja://transmit"],
    ["a room with odd characters", "janja://transmit?room=abc%3Cscript%3E"],
    ["a guild that isn't a snowflake", "janja://transmit?room=abc&guild=1;rm"],
    ["not a URL", "janja:/"],
  ])("refuses %s", (_case, url) => {
    expect(parseTransmitLink(url)).toBeNull();
  });
});

describe("findTransmitLink", () => {
  it("finds the link among Windows' launch arguments", () => {
    const argv = ["C:\\Janja\\Janja.exe", "--allow-file-access-from-files", "janja://transmit?room=abc"];
    expect(findTransmitLink(argv)).toEqual({ roomId: "abc", guildId: null });
  });

  it("finds nothing in a plain launch", () => {
    expect(findTransmitLink(["C:\\Janja\\Janja.exe"])).toBeNull();
  });
});
