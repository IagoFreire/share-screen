import { describe, expect, it } from "vitest";
import type { RoomViewer, StreamInfo } from "@screenshare-bot/shared";
import { viewerEntries } from "./viewersMenu.js";

const stream = (slot: number, presenterId: string): StreamInfo => ({ slot, presenterId, audio: null });

function viewer(userId: string | null, name: string | null, slot: number | null = 0): RoomViewer {
  return { userId, name, slot };
}

describe("viewerEntries", () => {
  it("names each person and says what they are doing", () => {
    const entries = viewerEntries([viewer("1", "Ana"), viewer("2", "Bia", null)], {
      streams: [stream(0, "9")],
      selectedSlot: 0,
      userId: "",
    });

    expect(entries.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "Ana", detail: "Assistindo" },
      { name: "Bia", detail: "Não está assistindo" },
    ]);
  });

  it("puts whoever is broadcasting first", () => {
    const entries = viewerEntries([viewer("1", "Ana"), viewer("9", "Zé", null)], {
      streams: [stream(0, "9")],
      selectedSlot: 0,
      userId: "",
    });

    expect(entries.map(({ name, detail }) => `${name}: ${detail}`)).toEqual(["Zé: Transmitindo", "Ana: Assistindo"]);
  });

  it("tells this live's audience from another's when the room has several", () => {
    const entries = viewerEntries([viewer("1", "Ana", 0), viewer("2", "Bia", 1)], {
      streams: [stream(0, "8"), stream(1, "9")],
      selectedSlot: 0,
      userId: "",
    });

    expect(entries.map((entry) => entry.detail)).toEqual(["Assistindo esta live", "Assistindo outra live"]);
  });

  it("does not call anyone a watcher while nobody is live", () => {
    // The relay keeps a viewer on its default slot even when that slot carries nothing.
    const [entry] = viewerEntries([viewer("1", "Ana", 0)], { streams: [], selectedSlot: 0, userId: "" });

    expect(entry?.detail).toBe("Não está assistindo");
  });

  it("marks the user's own entry", () => {
    const [entry] = viewerEntries([viewer("1", "Ana")], { streams: [stream(0, "9")], selectedSlot: 0, userId: "1" });

    expect(entry?.name).toBe("Ana (você)");
  });

  it("falls back to a short id, or to nobody in particular, when there is no name", () => {
    const entries = viewerEntries([viewer("123456789", null), viewer(null, null)], {
      streams: [],
      selectedSlot: null,
      userId: "",
    });

    expect(entries.map((entry) => entry.name)).toEqual(["…6789", "Anônimo"]);
  });
});
