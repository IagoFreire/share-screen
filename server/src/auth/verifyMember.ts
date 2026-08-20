import { config } from "../config.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Confirms (via the optional bot token) that `userId` is currently connected to
 * `channelId` in `guildId`, so an Activity room can't be joined by someone who
 * merely obtained the room URL. If no bot token is configured, membership
 * verification is skipped entirely (treated as allowed) -- it's an optional
 * hardening step, not a hard requirement for the relay to function.
 *
 * Only a confirmed 2xx response with a mismatching (or absent) channel_id counts as
 * "not in the channel". Anything else -- a bad/expired token, the bot missing the
 * Connect permission on that specific channel, a transient 5xx, a network error --
 * can't be distinguished from "the check itself is broken", and fails open (allows
 * the join) rather than locking legitimate users out of their own room because of a
 * bot misconfiguration. Failures are logged so the real cause is diagnosable instead
 * of silently rejecting everyone.
 */
export async function isUserInVoiceChannel(
  guildId: string,
  channelId: string,
  userId: string,
): Promise<boolean> {
  if (!config.discordBotToken) return true;

  try {
    const response = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/voice-states/${userId}`, {
      headers: { Authorization: `Bot ${config.discordBotToken}` },
    });

    if (!response.ok) {
      console.warn(
        `Voice membership check got HTTP ${response.status} for user ${userId} in guild ${guildId}` +
          ` -- allowing the join. Check DISCORD_BOT_TOKEN and that the bot has "View Channels" +` +
          ` "Connect" permission on that channel. Response: ${await response.text()}`,
      );
      return true;
    }

    const voiceState = (await response.json()) as { channel_id?: string | null };
    return voiceState.channel_id === channelId;
  } catch (error) {
    console.warn("Voice membership check errored; allowing the join.", error);
    return true;
  }
}
