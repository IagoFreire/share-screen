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
