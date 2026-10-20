/**
 * The pure half of the tray: what closing the window does, which notifications the
 * page may raise, and the tray icon itself. The icon is drawn in code rather than
 * shipped as image files, so idle/live variants at any DPI need no binary assets.
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

type Rgb = readonly [number, number, number];

const BLURPLE: Rgb = [0x58, 0x65, 0xf2];
const WHITE: Rgb = [0xff, 0xff, 0xff];
const LIVE_RED: Rgb = [0xf2, 0x3f, 0x43];

/** Geometry on a 32-unit grid, scaled to the requested size. */
const TILE_RADIUS = 7;
const BADGE_CENTER = 25;
const BADGE_RADIUS = 6;
/** Transparent gap around the badge so it reads against the tile. */
const BADGE_GAP = 1.5;

function insideRoundedSquare(x: number, y: number, size: number, radius: number): boolean {
  const nearestX = Math.min(Math.max(x, radius), size - radius);
  const nearestY = Math.min(Math.max(y, radius), size - radius);
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2;
}

/** The white monitor glyph: an outlined screen on a short stand. */
function onScreenGlyph(u: number, v: number): boolean {
  const inOuter = u >= 7 && u < 25 && v >= 9 && v < 21;
  const inInner = u >= 9 && u < 23 && v >= 11 && v < 19;
  const onStand = u >= 14 && u < 18 && v >= 21 && v < 23;
  const onBase = u >= 11 && u < 21 && v >= 23 && v < 25;
  return (inOuter && !inInner) || onStand || onBase;
}

/** A square BGRA bitmap for nativeImage.createFromBitmap. */
export function drawTrayIcon(size: number, live: boolean): Buffer {
  const bitmap = Buffer.alloc(size * size * 4);
  const scale = size / 32;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Pixel centers, in 32-unit grid coordinates.
      const u = (x + 0.5) / scale;
      const v = (y + 0.5) / scale;
      const badgeDistance = Math.hypot(u - BADGE_CENTER, v - BADGE_CENTER);

      let color: Rgb | null = null;
      if (live && badgeDistance <= BADGE_RADIUS) color = LIVE_RED;
      else if (live && badgeDistance <= BADGE_RADIUS + BADGE_GAP) color = null;
      else if (insideRoundedSquare(u, v, 32, TILE_RADIUS)) color = onScreenGlyph(u, v) ? WHITE : BLURPLE;

      if (!color) continue;
      const offset = (y * size + x) * 4;
      bitmap[offset] = color[2];
      bitmap[offset + 1] = color[1];
      bitmap[offset + 2] = color[0];
      bitmap[offset + 3] = 255;
    }
  }
  return bitmap;
}
