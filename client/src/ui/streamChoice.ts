import type { StreamInfo } from "@screenshare-bot/shared";

/**
 * Which broadcast a player that never shows its user their own live should be on (the
 * desktop app's -- see skipOwnBroadcast in watchView.ts). Watching yourself goes out to
 * the relay and straight back, which costs the presenter download for nothing.
 */

/** True for the user's own broadcast; never when the user is unknown (""). */
export function isOwnStream(stream: Pick<StreamInfo, "presenterId">, userId: string): boolean {
  return userId !== "" && stream.presenterId === userId;
}

/**
 * The broadcast to be on: `preferred` (what the player was on) while it is still live
 * and not the user's own -- unless they opened their own on purpose (`ownPicked`) --
 * else the first one that isn't theirs, else none. A user who left the live ("Sair da
 * live") stays out until they pick one.
 */
export function autoWatchSlot(
  streams: StreamInfo[],
  options: { preferred: number | null; userId: string; hasLeft: boolean; ownPicked?: boolean },
): number | null {
  if (options.hasLeft) return null;
  if (options.ownPicked && streams.some((stream) => stream.slot === options.preferred)) return options.preferred;
  const watchable = streams.filter((stream) => !isOwnStream(stream, options.userId));
  const kept = watchable.find((stream) => stream.slot === options.preferred);
  return (kept ?? watchable[0])?.slot ?? null;
}
