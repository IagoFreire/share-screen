import { describe, expect, it } from "vitest";
import { ADMIN_LOBBY_ROOM_ID, voiceLiveRoomId } from "@screenshare-bot/shared";
import { canPresentIn, specialRoomAccess, type JoiningUser } from "./roomAccess.js";

const seatedIn = (roomId: string, userId: string) => (voiceRoomId: string, who: string) =>
  voiceRoomId === roomId && who === userId;

const member: JoiningUser = { userId: "u1", verified: true, isAdmin: false };
const admin: JoiningUser = { userId: "adm", verified: true, isAdmin: true };

describe("specialRoomAccess", () => {
  it("leaves Discord channels to the Discord membership check", () => {
    expect(specialRoomAccess("123456789", member, () => false)).toBeNull();
  });

  it("lets someone seated in a voice room into its lives", () => {
    expect(specialRoomAccess(voiceLiveRoomId("r1"), member, seatedIn("r1", "u1"))).toEqual({ ok: true });
  });

  it("keeps out someone seated in another voice room", () => {
    expect(specialRoomAccess(voiceLiveRoomId("r1"), member, seatedIn("r2", "u1"))).toMatchObject({ ok: false });
  });

  it("keeps out an unverified id even when that user is seated", () => {
    const claimed = { ...member, verified: false };
    expect(specialRoomAccess(voiceLiveRoomId("r1"), claimed, seatedIn("r1", "u1"))).toMatchObject({ ok: false });
  });

  it("lets an admin into any voice room's lives without sitting in it", () => {
    expect(specialRoomAccess(voiceLiveRoomId("r1"), admin, () => false)).toEqual({ ok: true });
  });

  it("keeps the lobby to admins", () => {
    expect(specialRoomAccess(ADMIN_LOBBY_ROOM_ID, admin, () => false)).toEqual({ ok: true });
    expect(specialRoomAccess(ADMIN_LOBBY_ROOM_ID, member, () => false)).toMatchObject({ ok: false });
  });

  it("rejects a bare prefix instead of treating it as a Discord channel", () => {
    expect(specialRoomAccess("voice:", member, () => true)).toMatchObject({ ok: false });
  });
});

describe("canPresentIn", () => {
  it("allows broadcasting in voice rooms and channels but never in the lobby", () => {
    expect(canPresentIn(voiceLiveRoomId("r1"))).toBe(true);
    expect(canPresentIn("123")).toBe(true);
    expect(canPresentIn(ADMIN_LOBBY_ROOM_ID)).toBe(false);
  });
});
