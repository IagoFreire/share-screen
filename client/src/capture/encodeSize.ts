/**
 * The size a captured frame is encoded at.
 *
 * The capture's height is only an `ideal` (screenCapture.ts): a shared window that goes
 * fullscreen hands back the monitor's native size -- 1440p, 4K, ultrawide, or a stretched
 * 4:3 mode -- whatever quality the presenter picked. Encoded as-is, that can exceed
 * H.264 Level 5.1, which is what every viewer opens its decoder as; some viewers'
 * hardware decoders then refuse every keyframe, and anyone joining sits on "Carregando a
 * live…" for good while viewers with a stronger GPU see it fine.
 *
 * So the encoder is configured at most this big and WebCodecs scales each frame down.
 * The aspect ratio is kept, so nothing is stretched.
 */

export interface EncodeSize {
  width: number;
  height: number;
}

/** H.264 Level 5.1 (avc1.xx0033): largest frame, in 16x16 macroblocks. */
export const LEVEL_51_MAX_FRAME_MACROBLOCKS = 36_864;
/** H.264 Level 5.1: macroblocks per second. */
export const LEVEL_51_MAX_MACROBLOCKS_PER_SECOND = 983_040;
/** Each shrink step while rounding pushes a size back over the limit. */
const SHRINK_STEP = 0.98;

const toEven = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
const macroblocks = (width: number, height: number): number => Math.ceil(width / 16) * Math.ceil(height / 16);

/**
 * The size to encode a `sourceWidth` x `sourceHeight` frame at: no taller than
 * `maxHeight`, within Level 5.1 at `framerate`, never larger than the source, even
 * dimensions (H.264 needs them), same aspect ratio.
 */
export function encodeSizeFor(
  sourceWidth: number,
  sourceHeight: number,
  maxHeight: number,
  framerate: number,
): EncodeSize {
  const maxMacroblocks = Math.min(
    LEVEL_51_MAX_FRAME_MACROBLOCKS,
    Math.floor(LEVEL_51_MAX_MACROBLOCKS_PER_SECOND / Math.max(1, framerate)),
  );
  const levelScale = Math.sqrt((maxMacroblocks * 256) / (sourceWidth * sourceHeight));
  let scale = Math.min(1, maxHeight / sourceHeight, levelScale);

  let width = toEven(sourceWidth * scale);
  let height = toEven(sourceHeight * scale);
  while (macroblocks(width, height) > maxMacroblocks) {
    scale *= SHRINK_STEP;
    width = toEven(sourceWidth * scale);
    height = toEven(sourceHeight * scale);
  }
  return { width, height };
}
