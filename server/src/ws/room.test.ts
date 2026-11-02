import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { PresenterAudience } from "./audience.js";
import { Room } from "./room.js";

const presenterSocket = {} as WebSocket;

/** An audience with nobody watching hidden: what the presenter is shown is all of it. */
function seen(watchers: number, videoWatchers: number): PresenterAudience {
  return { watchers, videoWatchers, shown: { watchers, videoWatchers } };
}
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

    room.setAudience(slot, seen(0, 0));

    expect(room.isPaused(slot)).toBe(true);
    expect(room.streams[0].paused).toBe(true);
  });

  it("the presenter's own preview keeps the broadcast live", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    room.setAudience(slot, seen(0, 1));

    expect(room.isPaused(slot)).toBe(false);
  });

  it("an audio-only audience keeps the broadcast live", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    room.setAudience(slot, seen(1, 0));

    expect(room.isPaused(slot)).toBe(false);
  });

  it("reports whether the audience actually changed", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    expect(room.setAudience(slot, seen(2, 2))).toBe(true);
    expect(room.setAudience(slot, seen(2, 2))).toBe(false);
    expect(room.setAudience(slot, seen(2, 1))).toBe(true);
  });

  it("shows a broadcast only an admin watches hidden as paused, though it keeps sending", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    room.setAudience(slot, { watchers: 1, videoWatchers: 1, shown: { watchers: 0, videoWatchers: 0 } });

    expect(room.isPaused(slot)).toBe(true);
  });

  it("counts an admin going hidden as a change", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;
    room.setAudience(slot, seen(1, 1));

    expect(room.setAudience(slot, { watchers: 1, videoWatchers: 1, shown: { watchers: 0, videoWatchers: 0 } })).toBe(true);
  });
});

describe("Room stream gain", () => {
  it("lists no gain for a broadcast played as sent", () => {
    const room = new Room("c1", 10);
    room.allocateSlot(presenterSocket, "42", null);

    expect(room.streams[0].gain).toBeUndefined();
  });

  it("carries an admin's gain in the stream list, and says whether it changed", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null)!;

    expect(room.setGain(slot, 4)).toBe(true);
    expect(room.setGain(slot, 4)).toBe(false);
    expect(room.streams[0].gain).toBe(4);
  });

  it("has no gain to set on a slot nobody broadcasts on", () => {
    expect(new Room("c1", 10).setGain(3, 2)).toBe(false);
  });
});

describe("Room layers in use", () => {
  it("reports whether the set of layers in use actually changed", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null, LAYERS)!;

    expect(room.setLayersInUse(slot, [0])).toBe(true);
    expect(room.setLayersInUse(slot, [0])).toBe(false);
    expect(room.setLayersInUse(slot, [0, 1])).toBe(true);
  });

  it("forgets what it told a presenter that re-registers", () => {
    const room = new Room("c1", 10);
    const slot = room.allocateSlot(presenterSocket, "42", null, LAYERS)!;
    room.setLayersInUse(slot, [1]);

    room.allocateSlot(presenterSocket, "42", null, LAYERS);

    expect(room.setLayersInUse(slot, [1])).toBe(true);
  });
});
