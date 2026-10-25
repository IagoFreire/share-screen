import { describe, expect, it } from "vitest";
import type { StreamInfo } from "@screenshare-bot/shared";
import { autoWatchSlot, isOwnStream } from "./streamChoice.js";

function stream(slot: number, presenterId: string | null): StreamInfo {
  return { slot, presenterId, audio: null };
}

const ME = "me";

describe("isOwnStream", () => {
  it("recognises the user's own broadcast", () => {
    expect(isOwnStream(stream(0, ME), ME)).toBe(true);
    expect(isOwnStream(stream(0, "other"), ME)).toBe(false);
  });

  it("never matches when the user is unknown", () => {
    expect(isOwnStream(stream(0, null), "")).toBe(false);
  });
});

describe("autoWatchSlot", () => {
  it("keeps the broadcast being watched while it is live", () => {
    const streams = [stream(0, "a"), stream(1, "b")];

    expect(autoWatchSlot(streams, { preferred: 1, userId: ME, hasLeft: false })).toBe(1);
  });

  it("keeps watching someone else when the user goes live", () => {
    const streams = [stream(0, ME), stream(1, "b")];

    expect(autoWatchSlot(streams, { preferred: 1, userId: ME, hasLeft: false })).toBe(1);
  });

  it("moves off the user's own broadcast to someone else's", () => {
    const streams = [stream(0, ME), stream(1, "b")];

    expect(autoWatchSlot(streams, { preferred: 0, userId: ME, hasLeft: false })).toBe(1);
  });

  it("watches nothing when the only broadcast is the user's own", () => {
    expect(autoWatchSlot([stream(0, ME)], { preferred: 0, userId: ME, hasLeft: false })).toBeNull();
  });

  it("falls back to the first broadcast when the watched one ended", () => {
    const streams = [stream(2, "a"), stream(3, "b")];

    expect(autoWatchSlot(streams, { preferred: 0, userId: ME, hasLeft: false })).toBe(2);
  });

  it("picks someone who starts later while watching nothing", () => {
    expect(autoWatchSlot([stream(0, ME), stream(1, "b")], { preferred: null, userId: ME, hasLeft: false })).toBe(1);
  });

  it("keeps the user's own broadcast once they opened it on purpose", () => {
    const streams = [stream(0, ME), stream(1, "b")];

    expect(autoWatchSlot(streams, { preferred: 0, userId: ME, hasLeft: false, ownPicked: true })).toBe(0);
  });

  it("moves on when the own broadcast that was opened ends", () => {
    expect(autoWatchSlot([stream(1, "b")], { preferred: 0, userId: ME, hasLeft: false, ownPicked: true })).toBe(1);
  });

  it("stays out after the user left the live", () => {
    expect(autoWatchSlot([stream(1, "b")], { preferred: null, userId: ME, hasLeft: true })).toBeNull();
  });

  it("watches nothing with nobody live", () => {
    expect(autoWatchSlot([], { preferred: 0, userId: ME, hasLeft: false })).toBeNull();
  });
});
