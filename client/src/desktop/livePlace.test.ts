import { describe, expect, it } from "vitest";
import { ADMIN_LOBBY_ROOM_ID, type VoiceLocation } from "@screenshare-bot/shared";
import { playerPlace, transmitPlace, whereabouts, type PlaceInput } from "./livePlace.js";

const LOCATION: VoiceLocation = { guildId: "g1", guildName: "Servidor", guildIconUrl: null, channelId: "c1", channelName: "Jogando" };

function input(overrides: Partial<PlaceInput> = {}): PlaceInput {
  return { discord: { status: "not-in-voice" }, voiceRoom: null, voiceRoomUnsettled: false, isAdmin: false, ...overrides };
}

const inDiscord = { discord: { status: "in-channel" as const, location: LOCATION } };
const inRoom = { voiceRoom: { id: "r1", name: "Resenha" } };

describe("transmitPlace", () => {
  it("broadcasts to the voice room you sit in", () => {
    expect(transmitPlace(input(inRoom))).toEqual({ kind: "voice-room", roomId: "voice:r1", guildId: null, name: "Resenha" });
  });

  it("prefers the app's voice room over the Discord channel", () => {
    expect(transmitPlace(input({ ...inDiscord, ...inRoom }))?.roomId).toBe("voice:r1");
  });

  it("falls back to the Discord channel", () => {
    expect(transmitPlace(input(inDiscord))).toEqual({ kind: "discord", roomId: "c1", guildId: "g1", name: "Jogando" });
  });

  it("has nowhere to broadcast in no call, admin or not", () => {
    expect(transmitPlace(input({ isAdmin: true }))).toBeNull();
  });
});

describe("playerPlace", () => {
  it("puts an admin in no call in the lobby", () => {
    expect(playerPlace(input({ isAdmin: true }), null)).toMatchObject({ kind: "lobby", roomId: ADMIN_LOBBY_ROOM_ID });
  });

  it("leaves anyone else in no call without a player", () => {
    expect(playerPlace(input(), null)).toBeNull();
  });

  it("waits for the first Discord answer before sending an admin to the lobby", () => {
    expect(playerPlace(input({ isAdmin: true, discord: { status: "unknown" } }), null)).toBeNull();
  });

  it("stays in the voice room while the voice socket gets back into it", () => {
    const current = playerPlace(input(inRoom), null);

    const next = playerPlace(input({ ...inDiscord, voiceRoomUnsettled: true }), current);

    expect(next).toBe(current);
  });

  it("follows the Discord channel when the voice room is left for good", () => {
    const current = playerPlace(input(inRoom), null);

    expect(playerPlace(input(inDiscord), current)?.roomId).toBe("c1");
  });
});

describe("whereabouts", () => {
  it("lists both the voice room and the Discord channel", () => {
    expect(whereabouts(input({ ...inDiscord, ...inRoom }))).toEqual({ known: true, roomIds: ["voice:r1", "c1"] });
  });

  it("is unknown while either side can't tell yet", () => {
    expect(whereabouts(input({ discord: { status: "unknown" } })).known).toBe(false);
    expect(whereabouts(input({ voiceRoomUnsettled: true })).known).toBe(false);
  });
});
