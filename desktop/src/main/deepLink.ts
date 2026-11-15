/**
 * `janja://transmit?room=...&guild=...`: "Compartilhar tela" in the Discord Activity
 * opening this app even when it is closed. The Activity can't launch an app itself, so
 * the browser tab it opens (present.html) tries this link first; Windows starts Janja
 * with the link on its command line, or hands it to the running copy (second-instance).
 *
 * Any web page can fire this link, so it only ever opens the transmit dialog -- going
 * live still takes the user picking a screen and clicking -- and both ids are checked
 * against the shapes the relay uses before they go anywhere.
 */

export const DEEP_LINK_SCHEME = "janja";

export interface TransmitLink {
  roomId: string;
  guildId: string | null;
}

/** Relay room ids: an Activity instance id, or a "voice:" live room. */
const ROOM_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
/** Discord snowflakes. */
const GUILD_ID_PATTERN = /^\d{1,20}$/;

/** The transmit request in `url`, or null when it isn't a valid one. */
export function parseTransmitLink(url: string): TransmitLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:` || parsed.hostname !== "transmit") return null;

  const roomId = parsed.searchParams.get("room");
  if (!roomId || !ROOM_ID_PATTERN.test(roomId)) return null;
  const guild = parsed.searchParams.get("guild");
  if (guild !== null && !GUILD_ID_PATTERN.test(guild)) return null;
  return { roomId, guildId: guild };
}

/** The transmit request among a launch's arguments (Windows passes the link as one). */
export function findTransmitLink(argv: readonly string[]): TransmitLink | null {
  for (const arg of argv) {
    if (!arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) continue;
    const link = parseTransmitLink(arg);
    if (link) return link;
  }
  return null;
}
