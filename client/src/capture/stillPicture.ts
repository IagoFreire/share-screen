/**
 * A copy of the latest captured picture, for the keyframe a viewer needs while the
 * screen is still.
 *
 * Screen capture only delivers a frame when the picture changes. A viewer joining a
 * still screen (a paused game, a desktop nobody touches) -- or coming back to the window
 * and asking for a fresh keyframe -- would wait for the next change, forever on a screen
 * that doesn't move: sound plays, the picture stays on "Carregando a live…".
 *
 * The copy is drawn into a canvas of our own, NOT kept as a VideoFrame: a captured frame
 * (or its clone) belongs to the capture's small buffer pool, and holding even one starved
 * it under a fullscreen game -- the capture stopped delivering and the live froze. A
 * canvas copy holds nothing of the pool. It is taken at the encoded size and at most
 * every SNAPSHOT_EVERY_MS, so a 60 fps game costs a few small GPU copies a second.
 */

/** At most one copy this often; a still screen is what matters, not every frame. */
export const SNAPSHOT_EVERY_MS = 100;

export interface StillPicture {
  /** Copies `frame` (scaled to width x height) unless one was taken less than SNAPSHOT_EVERY_MS ago. */
  remember(frame: VideoFrame, width: number, height: number, now: number): void;
  /** A new frame of the copy, stamped `timestamp`; null when there is none at this size. Caller closes it. */
  frameAt(width: number, height: number, timestamp: number): VideoFrame | null;
  clear(): void;
}

export function createStillPicture(): StillPicture {
  let canvas: OffscreenCanvas | null = null;
  let context: OffscreenCanvasRenderingContext2D | null = null;
  let hasPicture = false;
  let lastSnapshotAt = -Infinity;
  let failed = false;

  return {
    remember(frame, width, height, now) {
      if (failed || now - lastSnapshotAt < SNAPSHOT_EVERY_MS) return;
      try {
        if (!canvas || !context) {
          canvas = new OffscreenCanvas(width, height);
          context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("OffscreenCanvas 2D context unavailable");
        }
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        context.drawImage(frame, 0, 0, width, height);
        hasPicture = true;
        lastSnapshotAt = now;
      } catch (error) {
        // Without copies a still screen just waits for its next change, as before.
        console.warn("Could not keep a copy of the screen for still-screen keyframes:", error);
        failed = true;
        hasPicture = false;
      }
    },

    frameAt(width, height, timestamp) {
      if (!hasPicture || !canvas || canvas.width !== width || canvas.height !== height) return null;
      return new VideoFrame(canvas, { timestamp });
    },

    clear() {
      hasPicture = false;
      canvas = null;
      context = null;
      lastSnapshotAt = -Infinity;
    },
  };
}
