import { describe, expect, it } from "vitest";
import { countSpectators, listRoomPeople, type ViewerConnection } from "./viewerList.js";

function connection(overrides: Partial<ViewerConnection> = {}): ViewerConnection {
  return { userId: "7", selectedSlot: 0, isPaused: false, hidden: false, ...overrides };
}

describe("listRoomPeople", () => {
  it("lists each connected user with the broadcast they receive", () => {
    const people = listRoomPeople([connection({ userId: "1" }), connection({ userId: "2", selectedSlot: 1 })]);

    expect(people).toEqual([
      { userId: "1", slot: 0 },
      { userId: "2", slot: 1 },
    ]);
  });

  it("lists a user with several connections once", () => {
    const people = listRoomPeople([connection({ userId: "1" }), connection({ userId: "1" })]);

    expect(people).toEqual([{ userId: "1", slot: 0 }]);
  });

  it("takes the slot from the connection that actually receives, not a paused sibling tab", () => {
    const people = listRoomPeople([
      connection({ userId: "1", selectedSlot: 0, isPaused: true }),
      connection({ userId: "1", selectedSlot: 1 }),
    ]);

    expect(people).toEqual([{ userId: "1", slot: 1 }]);
  });

  it("does not let a capture-only connection hide what the same user watches", () => {
    // The desktop app's capture side joins watching nothing; its player watches slot 0.
    const people = listRoomPeople([connection({ userId: "1", selectedSlot: null }), connection({ userId: "1" })]);

    expect(people).toEqual([{ userId: "1", slot: 0 }]);
  });

  it("keeps anonymous connections apart, since nothing says they are the same person", () => {
    const people = listRoomPeople([connection({ userId: null }), connection({ userId: null, selectedSlot: null })]);

    expect(people).toEqual([
      { userId: null, slot: 0 },
      { userId: null, slot: null },
    ]);
  });
});

describe("countSpectators", () => {
  it("does not count whoever is broadcasting", () => {
    const connections = [connection({ userId: "9", selectedSlot: null }), connection({ userId: "1" })];

    expect(countSpectators(connections, ["9"])).toBe(1);
  });

  it("counts a person with several connections once", () => {
    expect(countSpectators([connection({ userId: "1" }), connection({ userId: "1" })], [])).toBe(1);
  });

  it("counts anonymous connections each", () => {
    expect(countSpectators([connection({ userId: null }), connection({ userId: null })], ["9"])).toBe(2);
  });

  it("does not count an admin watching hidden", () => {
    expect(countSpectators([connection({ userId: "1", hidden: true }), connection({ userId: "2" })], [])).toBe(1);
  });
});

describe("listRoomPeople, hidden", () => {
  it("leaves out an admin watching hidden", () => {
    const people = listRoomPeople([connection({ userId: "1", hidden: true }), connection({ userId: "2" })]);

    expect(people).toEqual([{ userId: "2", slot: 0 }]);
  });
});
