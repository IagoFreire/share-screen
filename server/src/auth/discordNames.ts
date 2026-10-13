import { config } from "../config.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Resolves guild/channel/user ids to display names for the admin's broadcast list.
 *
 * A list of raw 18-digit snowflakes tells a moderator nothing, so this trades a few
 * cached API calls for a list that can actually be read. Everything here is best-effort:
 * a failure resolves to null and the UI falls back to showing the id, because a missing
 * name must never be the reason the list itself fails to render.
 *
 * Names change rarely, so entries are cached for a good while -- that keeps a list which
 * refreshes every few seconds from turning into a steady stream of API traffic.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  name: string | null;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** In-flight requests, so a burst of lookups for the same id issues a single call. */
const inFlight = new Map<string, Promise<string | null>>();

function fetchName<T>(cacheKey: string, path: string, pick: (body: T) => string | null): Promise<string | null> {
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.name);

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const request = (async (): Promise<string | null> => {
    try {
      const response = await fetch(`${DISCORD_API_BASE}${path}`, {
        headers: { Authorization: `Bot ${config.discordBotToken}` },
      });
      if (!response.ok) {
        // Usually just means the bot isn't in that guild -- expected, not alarming.
        console.warn(`Name lookup for ${path} got HTTP ${response.status}; falling back to the id.`);
        cache.set(cacheKey, { name: null, fetchedAt: Date.now() });
        return null;
      }
      const name = pick((await response.json()) as T);
      cache.set(cacheKey, { name, fetchedAt: Date.now() });
      return name;
    } catch (error) {
      console.warn(`Name lookup for ${path} errored; falling back to the id.`, error);
      cache.set(cacheKey, { name: null, fetchedAt: Date.now() });
      return null;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, request);
  return request;
}

export function resolveGuildName(guildId: string | null): Promise<string | null> {
  if (!guildId || !config.discordBotToken) return Promise.resolve(null);
  return fetchName<{ name?: string }>(`guild:${guildId}`, `/guilds/${guildId}`, (body) => body.name ?? null);
}

export function resolveChannelName(channelId: string): Promise<string | null> {
  if (!config.discordBotToken) return Promise.resolve(null);
  return fetchName<{ name?: string }>(`channel:${channelId}`, `/channels/${channelId}`, (body) => body.name ?? null);
}

export function resolveUserName(userId: string | null): Promise<string | null> {
  if (!userId || !config.discordBotToken) return Promise.resolve(null);
  return fetchName<{ global_name?: string | null; username?: string }>(
    `user:${userId}`,
    `/users/${userId}`,
    // global_name is the current display name; username is the legacy handle.
    (body) => body.global_name ?? body.username ?? null,
  );
}
