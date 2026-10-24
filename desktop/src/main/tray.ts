/**
 * The pure half of the tray: what closing the window does, which notifications the
 * page may raise, and the "ao vivo" badge drawn over the app icon (static/janja.png),
 * so the live variant needs no second image.
 */

export type CloseAction = "hide-to-tray" | "close";

/** Closing the window mid-broadcast keeps it running from the tray; "Sair" really quits. */
export function decideCloseAction(state: { live: boolean; quitting: boolean }): CloseAction {
  return state.live && !state.quitting ? "hide-to-tray" : "close";
}

const MAX_TITLE_LENGTH = 100;
const MAX_BODY_LENGTH = 300;

export function isNotification(title: unknown, body: unknown): boolean {
  return (
    typeof title === "string" &&
    typeof body === "string" &&
    title.length <= MAX_TITLE_LENGTH &&
    body.length <= MAX_BODY_LENGTH
  );
}

const LIVE_RED = [0xf2, 0x3f, 0x43] as const;

/** Geometry on a 32-unit grid, scaled to the icon's size. */
const BADGE_CENTER = 25;
const BADGE_RADIUS = 6;
/** Transparent gap around the badge so it reads against the icon. */
const BADGE_GAP = 1.5;

/**
 * A copy of `icon` (square BGRA, as nativeImage.toBitmap() gives on Windows) with the
 * red "ao vivo" dot in its bottom-right corner when `live`; an unchanged copy otherwise.
 */
export function withLiveBadge(icon: Buffer, size: number, live: boolean): Buffer {
  const bitmap = Buffer.from(icon);
  if (!live) return bitmap;
  const scale = size / 32;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Pixel centers, in 32-unit grid coordinates.
      const distance = Math.hypot((x + 0.5) / scale - BADGE_CENTER, (y + 0.5) / scale - BADGE_CENTER);
      if (distance > BADGE_RADIUS + BADGE_GAP) continue;
      const offset = (y * size + x) * 4;
      if (distance <= BADGE_RADIUS) bitmap.set([LIVE_RED[2], LIVE_RED[1], LIVE_RED[0], 255], offset);
      else bitmap.fill(0, offset, offset + 4);
    }
  }
  return bitmap;
}
