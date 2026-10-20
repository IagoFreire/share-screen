import { describe, expect, it } from "vitest";
import type { ActiveBroadcast, VoiceLocation } from "@screenshare-bot/shared";
import { buildSidebarModel } from "./sidebarModel.js";

const MY_LOCATION: VoiceLocation = {
  guildId: "g1",
  guildName: "Servidor dos Amigos",
  guildIconUrl: "https://cdn/icon.png",
  channelId: "c-mine",
  channelName: "Jogando",
};

function broadcast(overrides: Partial<ActiveBroadcast>): ActiveBroadcast {
  return {
    roomId: "c-mine",
    guildId: "g1",
    guildName: "Servidor dos Amigos",
    channelName: "Jogando",
    slot: 0,
    presenterId: "u1",
    presenterName: "Luana",
    viewerCount: 3,
    ...overrides,
  };
}

describe("buildSidebarModel", () => {
  it("shows your own channel even with nobody live", () => {
    expect(buildSidebarModel({ location: MY_LOCATION, broadcasts: [] })).toEqual([
      {
        guildId: "g1",
        name: "Servidor dos Amigos",
        iconUrl: "https://cdn/icon.png",
        channels: [{ channelId: "c-mine", guildId: "g1", name: "Jogando", isMine: true, presenters: [] }],
      },
    ]);
  });

  it("groups presenters under their channel, ordered by slot", () => {
    const model = buildSidebarModel({
      location: MY_LOCATION,
      broadcasts: [
        broadcast({ slot: 1, presenterId: "u2", presenterName: "Iago" }),
        broadcast({ slot: 0, presenterId: "u1", presenterName: "Luana" }),
      ],
    });

    expect(model[0].channels[0].presenters).toEqual([
      { slot: 0, userId: "u1", name: "Luana" },
      { slot: 1, userId: "u2", name: "Iago" },
    ]);
  });

  it("lists other live channels after yours, and servers after your own", () => {
    const model = buildSidebarModel({
      location: MY_LOCATION,
      broadcasts: [
        broadcast({ roomId: "c-z", guildId: "g2", guildName: "Alpha", channelName: "Zona", presenterName: "Rafa" }),
        broadcast({ roomId: "c-a", channelName: "AFK", presenterName: "Pedro" }),
      ],
    });

    expect(model.map((server) => server.name)).toEqual(["Servidor dos Amigos", "Alpha"]);
    expect(model[0].channels.map((channel) => channel.name)).toEqual(["Jogando", "AFK"]);
    expect(model[1].iconUrl).toBeNull();
  });

  it("falls back to placeholder names when Discord names are missing", () => {
    const model = buildSidebarModel({
      location: null,
      broadcasts: [broadcast({ guildName: null, channelName: null, presenterName: null })],
    });

    expect(model[0].name).toBe("Servidor");
    expect(model[0].channels[0]).toMatchObject({ name: "Canal de voz", isMine: false });
    expect(model[0].channels[0].presenters[0].name).toBe("Alguém");
  });
});
