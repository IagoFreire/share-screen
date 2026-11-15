import path from "node:path";

/**
 * Windows' own "device connected" / "device disconnected" sounds, for the alert a
 * moderator can play at a presenter (see client/src/alertSounds.ts). Read from the
 * presenter's Windows rather than shipped with the app: they're Microsoft's files.
 */

const FILES: Record<string, string> = {
  "usb-in": "Windows Hardware Insert.wav",
  "usb-out": "Windows Hardware Remove.wav",
};

/** Anything bigger isn't the short system sound it should be. */
export const MAX_SYSTEM_SOUND_BYTES = 2 * 1024 * 1024;

export function systemSoundPath(sound: unknown, systemRoot: string | undefined): string | null {
  if (typeof sound !== "string" || !Object.hasOwn(FILES, sound) || !systemRoot) return null;
  return path.win32.join(systemRoot, "Media", FILES[sound]!);
}
