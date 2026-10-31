/**
 * When to play each received voice packet, on an AudioContext's clock. Packets are
 * placed by their own timestamps against an anchor, a short jitter buffer ahead of
 * "now", so uneven arrival doesn't reach the speakers. Running dry, or a backlog piling
 * up past MAX_LEAD_SECONDS, re-anchors to a fresh buffer instead of drifting: for a
 * conversation, staying close to live beats playing every packet.
 */

const MAX_LEAD_SECONDS = 0.4;

export interface VoiceSchedule {
  /** Context time at which the packet stamped `timestampUs` should start. */
  startTime(timestampUs: number, now: number): number;
}

export function createVoiceSchedule(bufferSeconds: number): VoiceSchedule {
  let anchorTimestampUs: number | null = null;
  let anchorTime = 0;

  return {
    startTime(timestampUs, now) {
      if (anchorTimestampUs !== null) {
        const start = anchorTime + (timestampUs - anchorTimestampUs) / 1_000_000;
        if (start >= now && start - now <= MAX_LEAD_SECONDS) return start;
      }
      anchorTimestampUs = timestampUs;
      anchorTime = now + bufferSeconds;
      return anchorTime;
    },
  };
}
