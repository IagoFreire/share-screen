import { describe, expect, it } from "vitest";
import { VOICE_MAX_MEMBERS, VOICE_MAX_ROOMS } from "@screenshare-bot/shared";
import { VoiceRooms } from "./voiceRooms.js";

const profile = (userId: string) => ({ userId, name: `user ${userId}`, avatarUrl: null });

describe("VoiceRooms", () => {
  it("creating a room puts its creator in it, in the first seat", () => {
    const rooms = new VoiceRooms<string>();

    const result = rooms.create("  Resenha  ", "conn-a", profile("a"));

    expect(result).toMatchObject({ ok: true, slot: 0 });
    expect(rooms.list()).toEqual([
      {
        id: expect.any(String),
        name: "Resenha",
        members: [{ slot: 0, userId: "a", name: "user a", avatarUrl: null, muted: false, deafened: false }],
      },
    ]);
  });

  it("refuses a room without a name", () => {
    expect(new VoiceRooms<string>().create("   ", "conn-a", profile("a"))).toMatchObject({ ok: false });
  });

  it("cuts long names and drops control characters", () => {
    const rooms = new VoiceRooms<string>();
    rooms.create(`a\u0007b${"x".repeat(80)}`, "conn-a", profile("a"));

    expect(rooms.list()[0].name).toBe(`ab${"x".repeat(38)}`);
  });

  it("joining takes the lowest free seat", () => {
    const rooms = new VoiceRooms<string>();
    const created = rooms.create("Sala", "conn-a", profile("a"));
    if (!created.ok) throw new Error("not created");
    rooms.join(created.roomId, "conn-b", profile("b"));
    rooms.join(created.roomId, "conn-c", profile("c"));
    rooms.leave("conn-b");

    expect(rooms.join(created.roomId, "conn-d", profile("d"))).toMatchObject({ ok: true, slot: 1 });
  });

  it("a room disappears when its last member leaves", () => {
    const rooms = new VoiceRooms<string>();
    const created = rooms.create("Sala", "conn-a", profile("a"));
    if (!created.ok) throw new Error("not created");
    rooms.join(created.roomId, "conn-b", profile("b"));

    rooms.leave("conn-a");
    expect(rooms.list()).toHaveLength(1);
    rooms.leave("conn-b");
    expect(rooms.list()).toEqual([]);
  });

  it("joining another room leaves the one you were in", () => {
    const rooms = new VoiceRooms<string>();
    const first = rooms.create("Um", "conn-a", profile("a"));
    const second = rooms.create("Dois", "conn-b", profile("b"));
    if (!first.ok || !second.ok) throw new Error("not created");
    rooms.join(first.roomId, "conn-c", profile("c"));

    rooms.join(second.roomId, "conn-c", profile("c"));

    expect(rooms.list().find((room) => room.id === first.roomId)?.members.map((m) => m.userId)).toEqual(["a"]);
    expect(rooms.roomOf("conn-c")?.roomId).toBe(second.roomId);
  });

  it("the same person joining from another device moves them there", () => {
    const rooms = new VoiceRooms<string>();
    const created = rooms.create("Sala", "desktop", profile("a"));
    if (!created.ok) throw new Error("not created");
    rooms.join(created.roomId, "conn-b", profile("b"));

    const result = rooms.join(created.roomId, "laptop", profile("a"));

    expect(result).toMatchObject({ ok: true, displaced: ["desktop"] });
    expect(rooms.roomOf("desktop")).toBeNull();
    expect(rooms.list()[0].members.map((member) => member.userId)).toEqual(["b", "a"]);
  });

  it("refuses a full room", () => {
    const rooms = new VoiceRooms<string>();
    const created = rooms.create("Sala", "c0", profile("u0"));
    if (!created.ok) throw new Error("not created");
    for (let i = 1; i < VOICE_MAX_MEMBERS; i += 1) rooms.join(created.roomId, `c${i}`, profile(`u${i}`));

    expect(rooms.join(created.roomId, "extra", profile("extra"))).toMatchObject({ ok: false });
  });

  it("refuses a room that doesn't exist", () => {
    expect(new VoiceRooms<string>().join("nope", "conn-a", profile("a"))).toMatchObject({ ok: false });
  });

  it("caps how many rooms exist at once", () => {
    const rooms = new VoiceRooms<string>();
    for (let i = 0; i < VOICE_MAX_ROOMS; i += 1) rooms.create(`Sala ${i}`, `c${i}`, profile(`u${i}`));

    expect(rooms.create("Mais uma", "extra", profile("extra"))).toMatchObject({ ok: false });
  });

  it("tracks mute and deafen, and who should hear a member", () => {
    const rooms = new VoiceRooms<string>();
    const created = rooms.create("Sala", "conn-a", profile("a"));
    if (!created.ok) throw new Error("not created");
    rooms.join(created.roomId, "conn-b", profile("b"));
    rooms.join(created.roomId, "conn-c", profile("c"));

    rooms.setState("conn-c", { muted: true, deafened: true });

    expect(rooms.list()[0].members.find((member) => member.userId === "c")).toMatchObject({ muted: true, deafened: true });
    expect(rooms.listenersOf("conn-a")).toEqual(["conn-b"]);
    expect(rooms.canSpeak("conn-c")).toBe(false);
    expect(rooms.canSpeak("conn-a")).toBe(true);
  });
});
