/**
 * Rate-limits keyframe requests the relay raises on its own (a viewer that lost a frame
 * to backpressure). A congested link drops frames in runs, and asking for a keyframe on
 * every one would answer congestion with the most expensive frames there are.
 */
export interface KeyframeThrottle {
  /** Whether a request for `key` (room, slot and layer) may go out at `nowMs`. */
  allow(key: string, nowMs: number): boolean;
}

export function createKeyframeThrottle(minIntervalMs: number): KeyframeThrottle {
  const lastAllowed = new Map<string, number>();
  return {
    allow(key, nowMs) {
      const last = lastAllowed.get(key);
      if (last !== undefined && nowMs - last < minIntervalMs) return false;
      lastAllowed.set(key, nowMs);
      return true;
    },
  };
}
