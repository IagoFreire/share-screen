import type { ActiveBroadcast, VoiceLocation } from "@screenshare-bot/shared";

/**
 * What the desktop sidebar shows: servers, and under each the voice channels worth
 * listing -- yours (always, so you can broadcast there even when nobody is live) and any
 * other channel with someone live in it. Which broadcasts reach this list is the relay's
 * decision (an admin's spans every room, anyone else's only their own channel), so this
 * only groups and orders what it is given.
 */

export interface SidebarPresenter {
  slot: number;
  userId: string | null;
  name: string;
}

export interface SidebarChannel {
  channelId: string;
  guildId: string | null;
  name: string;
  isMine: boolean;
  presenters: SidebarPresenter[];
}

export interface SidebarServer {
  /** Null for broadcasts whose room never reported a guild. */
  guildId: string | null;
  name: string;
  iconUrl: string | null;
  channels: SidebarChannel[];
}

const FALLBACK_SERVER_NAME = "Servidor";
const FALLBACK_CHANNEL_NAME = "Canal de voz";
const FALLBACK_PRESENTER_NAME = "Alguém";

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "pt-BR");

export function buildSidebarModel(input: {
  location: VoiceLocation | null;
  broadcasts: ActiveBroadcast[];
}): SidebarServer[] {
  const { location } = input;
  const servers = new Map<string | null, SidebarServer>();
  const channels = new Map<string, SidebarChannel>();

  function serverFor(guildId: string | null, name: string | null): SidebarServer {
    let server = servers.get(guildId);
    if (!server) {
      const isMyGuild = location !== null && guildId === location.guildId;
      server = {
        guildId,
        name: name ?? (isMyGuild ? location.guildName : null) ?? FALLBACK_SERVER_NAME,
        iconUrl: isMyGuild ? location.guildIconUrl : null,
        channels: [],
      };
      servers.set(guildId, server);
    }
    return server;
  }

  function channelFor(channelId: string, guildId: string | null, name: string | null, server: SidebarServer): SidebarChannel {
    let channel = channels.get(channelId);
    if (!channel) {
      channel = {
        channelId,
        guildId,
        name: name ?? FALLBACK_CHANNEL_NAME,
        isMine: location?.channelId === channelId,
        presenters: [],
      };
      channels.set(channelId, channel);
      server.channels.push(channel);
    }
    return channel;
  }

  if (location) {
    channelFor(location.channelId, location.guildId, location.channelName, serverFor(location.guildId, location.guildName));
  }

  for (const broadcast of input.broadcasts) {
    const server = serverFor(broadcast.guildId, broadcast.guildName);
    const channel = channelFor(broadcast.roomId, broadcast.guildId, broadcast.channelName, server);
    channel.presenters.push({
      slot: broadcast.slot,
      userId: broadcast.presenterId,
      name: broadcast.presenterName ?? FALLBACK_PRESENTER_NAME,
    });
  }

  const ordered = [...servers.values()].map((server) => ({
    ...server,
    channels: [...server.channels]
      .sort((a, b) => Number(b.isMine) - Number(a.isMine) || byName(a, b))
      .map((channel) => ({ ...channel, presenters: [...channel.presenters].sort((a, b) => a.slot - b.slot) })),
  }));
  const isMine = (server: SidebarServer) => location !== null && server.guildId === location.guildId;
  return ordered.sort((a, b) => Number(isMine(b)) - Number(isMine(a)) || byName(a, b));
}
