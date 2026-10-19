import type { VoiceLocation } from "@screenshare-bot/shared";

/**
 * Finds which voice channel a user is sitting in, using only the bot token's REST
 * access -- the bot never holds a gateway connection, so there is no live voice-state
 * cache to read from. Discord has no "where is this user" endpoint either; the only way
 * is asking each guild the bot shares with them. The bot is in a handful of guilds, so
 * that loop stays small, and both caches below keep the desktop app's polling from
 * turning into a rate-limit problem.
 */

/** The bot's guild list barely changes; re-reading it every poll would waste requests. */
const BOT_GUILDS_TTL_MS = 5 * 60 * 1000;
/** Absorbs bursts (several windows, focus + interval) without hiding a channel switch for long. */
const USER_RESULT_TTL_MS = 5 * 1000;

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

export interface VoiceLocatorDeps {
  /** GET against the Discord API with the bot token; `path` starts after /api/v10. */
  fetchJson(path: string): Promise<{ status: number; body: unknown }>;
  now(): number;
  resolveChannelName(channelId: string): Promise<string | null>;
}

/** The lookup itself failed (rate limit, missing permission, Discord down) -- not "not in voice". */
export class VoiceLookupError extends Error {}

interface BotGuild {
  id: string;
  name: string;
  icon: string | null;
}

export interface VoiceLocator {
  locate(userId: string): Promise<VoiceLocation | null>;
}

export function createVoiceLocator(deps: VoiceLocatorDeps): VoiceLocator {
  let botGuilds: { guilds: BotGuild[]; fetchedAt: number } | null = null;
  const userResults = new Map<string, { location: VoiceLocation | null; fetchedAt: number }>();

  async function getBotGuilds(): Promise<BotGuild[]> {
    if (botGuilds && deps.now() - botGuilds.fetchedAt < BOT_GUILDS_TTL_MS) return botGuilds.guilds;

    const response = await deps.fetchJson("/users/@me/guilds");
    if (response.status !== HTTP_OK || !Array.isArray(response.body)) {
      throw new VoiceLookupError(`Bot guild list failed with HTTP ${response.status}.`);
    }
    botGuilds = { guilds: response.body as BotGuild[], fetchedAt: deps.now() };
    return botGuilds.guilds;
  }

  async function lookUp(userId: string): Promise<VoiceLocation | null> {
    for (const guild of await getBotGuilds()) {
      const response = await deps.fetchJson(`/guilds/${guild.id}/voice-states/${userId}`);
      if (response.status === HTTP_NOT_FOUND) continue;
      if (response.status !== HTTP_OK) {
        throw new VoiceLookupError(`Voice state lookup in guild ${guild.id} failed with HTTP ${response.status}.`);
      }

      const channelId = (response.body as { channel_id?: string | null }).channel_id;
      if (!channelId) continue;
      return {
        guildId: guild.id,
        guildName: guild.name ?? null,
        guildIconUrl: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null,
        channelId,
        channelName: await deps.resolveChannelName(channelId),
      };
    }
    return null;
  }

  return {
    async locate(userId) {
      const cached = userResults.get(userId);
      if (cached && deps.now() - cached.fetchedAt < USER_RESULT_TTL_MS) return cached.location;

      const location = await lookUp(userId);
      userResults.set(userId, { location, fetchedAt: deps.now() });
      return location;
    },
  };
}
