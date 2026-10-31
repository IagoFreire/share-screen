import type { SendResult } from "./backpressure.js";

/**
 * "Automático" in the viewer's quality menu. The relay is the one place that sees a
 * viewer's connection falling behind for real -- frames it has to drop because the
 * socket's buffer is full (backpressure.ts) -- so the simulcast layer is picked here:
 * step down fast when frames keep dropping, step back up slowly once the link has been
 * clean for a while. Layer 0 is the best.
 */

/** Drops counted over this window... */
const DOWN_WINDOW_MS = 2000;
/** ...and this many of them inside it means the link can't keep up. */
const DOWN_DROP_THRESHOLD = 5;
/** A clean stretch this long earns one step back up. */
const UP_QUIET_MS = 15_000;
/**
 * After stepping down on a viewer's report, ignore further reports this long: what is
 * already queued for the old layer still arrives late, and judging the new layer by it
 * would skip straight past it.
 */
const CONGESTION_COOLDOWN_MS = 3000;

export interface AutoLayer {
  readonly layer: number;
  /** Feed every video send result; returns the new layer when it changes, else null. */
  report(result: SendResult, nowMs: number): number | null;
  /**
   * The viewer says frames arrive later and later (see report-congestion). Behind a
   * proxy that buffers on the relay's behalf, the send results above stay "sent" long
   * after the link fell behind, so this is often the only sign. Returns the new layer
   * when it changes, else null.
   */
  congested(nowMs: number): number | null;
}

export function createAutoLayer(layerCount: number, nowMs: number): AutoLayer {
  const lightest = Math.max(0, layerCount - 1);
  let layer = 0;
  let recentDrops: number[] = [];
  /** Start of the current clean stretch: the last drop or the last change. */
  let quietSince = nowMs;
  let lastCongestionStepAt = -Infinity;

  return {
    get layer() {
      return layer;
    },

    congested(now) {
      quietSince = now;
      if (layer >= lightest || now - lastCongestionStepAt < CONGESTION_COOLDOWN_MS) return null;
      layer += 1;
      lastCongestionStepAt = now;
      recentDrops = [];
      return layer;
    },

    report(result, now) {
      if (result !== "sent") {
        quietSince = now;
        recentDrops = [...recentDrops.filter((at) => now - at < DOWN_WINDOW_MS), now];
        if (recentDrops.length >= DOWN_DROP_THRESHOLD && layer < lightest) {
          layer += 1;
          recentDrops = [];
          return layer;
        }
        return null;
      }

      if (layer > 0 && now - quietSince >= UP_QUIET_MS) {
        layer -= 1;
        quietSince = now;
        return layer;
      }
      return null;
    },
  };
}
