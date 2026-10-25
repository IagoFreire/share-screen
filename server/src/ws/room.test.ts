import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { Room } from "./room.js";

const presenterSocket = {} as WebSocket;
const LAYERS = [
  { layer: 0, height: 1080, framerate: 60 },
  { layer: 1, height: 720, framerate: 30 },
];

describe("Room simulcast layers", () => {
  it("advertises the layers a presenter sends", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null, LAYERS)!;

    expect(room.streams[0].layers).toEqual(LAYERS);
    expect(room.layerCountOf(slot)).toBe(2);
  });

  it("treats a single-version presenter as one layer", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    expect(room.streams[0].layers).toBeUndefined();
    expect(room.layerCountOf(slot)).toBe(1);
  });
});

describe("Room audiences", () => {
  it("a broadcast is not paused before its audience is known", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    expect(room.isPaused(slot)).toBe(false);
    expect(room.streams[0].paused).toBeUndefined();
  });

  it("marks a broadcast nobody watches as paused", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    room.setAudience(slot, { watchers: 0, videoWatchers: 0 });

    expect(room.isPaused(slot)).toBe(true);
    expect(room.streams[0].paused).toBe(true);
  });

  it("the presenter's own preview keeps the broadcast live", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    room.setAudience(slot, { watchers: 0, videoWatchers: 1 });

    expect(room.isPaused(slot)).toBe(false);
  });

  it("an audio-only audience keeps the broadcast live", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    room.setAudience(slot, { watchers: 1, videoWatchers: 0 });

    expect(room.isPaused(slot)).toBe(false);
  });

  it("reports whether the audience actually changed", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    expect(room.setAudience(slot, { watchers: 2, videoWatchers: 2 })).toBe(true);
    expect(room.setAudience(slot, { watchers: 2, videoWatchers: 2 })).toBe(false);
    expect(room.setAudience(slot, { watchers: 2, videoWatchers: 1 })).toBe(true);
  });
});
