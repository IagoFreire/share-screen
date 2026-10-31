import { FrameType, type EncodedFrame } from "@screenshare-bot/shared";
import type { AudioDecodePipeline } from "./audioDecodePipeline.js";
import type { VideoDecodePipeline } from "./videoDecodePipeline.js";

/**
 * What every player (the Activity's App.ts and the desktop/watch.html watchView.ts)
 * does with an incoming media frame, in one place:
 *
 * - drops frames of a broadcast it no longer watches (still in flight after a switch);
 * - checks the per-layer sequence numbers, so a lost video frame stops the decoder
 *   before it paints corruption, and asks for a keyframe;
 * - silences the previous broadcast's sound when another one's frames start arriving;
 * - measures how much later than usual frames arrive, and says so when it lasts --
 *   behind the Cloudflare tunnel the relay rarely sees its own send buffer fill, so the
 *   viewer is where congestion is actually visible.
 */

/** A frame queued this much later than the best recent one means a growing backlog... */
const CONGESTION_DELAY_MS = 250;
/** ...and only when that lasts this long (one late burst is just jitter). */
const CONGESTION_SUSTAIN_MS = 1000;
/** The best delay is taken over this window, so a changed route resets the baseline. */
const BASELINE_WINDOW_MS = 20_000;
const BASELINE_BUCKET_MS = 1000;
/** At most one congestion report this often; the relay needs time to switch and drain. */
const CONGESTION_REPORT_EVERY_MS = 3000;
/** At most one keyframe request of our own this often. */
const KEYFRAME_REQUEST_EVERY_MS = 500;

export interface QueueDelayReading {
  /** How much later than the best recent frame this one arrived, ms. */
  queueDelayMs: number;
  /** The delay has stayed above CONGESTION_DELAY_MS for CONGESTION_SUSTAIN_MS. */
  congested: boolean;
}

export interface QueueDelayMonitor {
  /** `captureMs` is the frame's own timestamp (sender's clock), `arrivalMs` ours. */
  observe(captureMs: number, arrivalMs: number): QueueDelayReading;
  reset(): void;
}

/**
 * Arrival minus capture time is the one-way delay plus an unknown, constant offset
 * between the two machines' clocks. Subtracting the smallest recent value cancels the
 * offset and leaves what matters: how long frames now sit in queues on the way.
 */
export function createQueueDelayMonitor(): QueueDelayMonitor {
  let buckets: Array<{ startMs: number; min: number }> = [];
  let lateSince: number | null = null;

  return {
    observe(captureMs, arrivalMs) {
      const delay = arrivalMs - captureMs;
      const last = buckets[buckets.length - 1];
      if (!last || arrivalMs - last.startMs >= BASELINE_BUCKET_MS) {
        const recent = buckets.filter((bucket) => arrivalMs - bucket.startMs < BASELINE_WINDOW_MS);
        buckets = [...recent, { startMs: arrivalMs, min: delay }];
      } else if (delay < last.min) {
        buckets = [...buckets.slice(0, -1), { ...last, min: delay }];
      }

      const baseline = Math.min(...buckets.map((bucket) => bucket.min));
      const queueDelayMs = delay - baseline;
      if (queueDelayMs <= CONGESTION_DELAY_MS) lateSince = null;
      else lateSince ??= arrivalMs;
      return { queueDelayMs, congested: lateSince !== null && arrivalMs - lateSince >= CONGESTION_SUSTAIN_MS };
    },
    reset() {
      buckets = [];
      lateSince = null;
    },
  };
}

export interface ReceiverTargets {
  /** The broadcast being watched; null for none. */
  slot: number | null;
  video: VideoDecodePipeline | null;
  audio: AudioDecodePipeline | null;
}

export interface ReceiverStats {
  queueDelayMs: number | null;
  /** Video frames found missing from the sequence. */
  gaps: number;
  congestionReports: number;
}

export interface StreamReceiverDeps {
  requestKeyframe(): void;
  reportCongestion(): void;
  /** performance.now() unless a test supplies its own. */
  now?: () => number;
}

export interface StreamReceiver {
  route(frame: EncodedFrame, targets: ReceiverTargets): void;
  /** The viewer's own machine can't keep up (see VideoDecodePipelineOptions.onOverload). */
  reportCongestion(): void;
  stats(): ReceiverStats;
}

export function createStreamReceiver(deps: StreamReceiverDeps): StreamReceiver {
  const now = deps.now ?? (() => performance.now());
  const delayMonitor = createQueueDelayMonitor();
  let lastSlot: number | null = null;
  let lastVideoClock: number | null = null;
  let lastKeyframeRequestAt = -Infinity;
  let lastCongestionReportAt = -Infinity;
  let queueDelayMs: number | null = null;
  let gaps = 0;
  let congestionReports = 0;

  function requestKeyframe(): void {
    const at = now();
    if (at - lastKeyframeRequestAt < KEYFRAME_REQUEST_EVERY_MS) return;
    lastKeyframeRequestAt = at;
    deps.requestKeyframe();
  }

  function reportCongestion(): void {
    const at = now();
    if (at - lastCongestionReportAt < CONGESTION_REPORT_EVERY_MS) return;
    lastCongestionReportAt = at;
    congestionReports += 1;
    deps.reportCongestion();
  }

  return {
    route(frame, { slot, video, audio }) {
      // Frames of the broadcast just left are still in flight after a switch.
      if (slot === null || frame.slot !== slot) return;
      if (slot !== lastSlot) {
        if (lastSlot !== null) audio?.reset();
        lastSlot = slot;
        lastVideoClock = null;
        delayMonitor.reset();
        queueDelayMs = null;
      }

      if (frame.type === FrameType.Audio) {
        audio?.decodeChunk({ timestampUs: frame.timestamp * 1000, data: frame.payload });
        return;
      }
      if (frame.type !== FrameType.Video) return;

      // A keyframe starts a fresh chain (and a layer switch restarts the numbering);
      // otherwise each frame must follow the previous one, or a reference is missing.
      if (!frame.keyFrame && lastVideoClock !== null && frame.clock !== lastVideoClock + 1) {
        gaps += 1;
        video?.awaitKeyframe();
        requestKeyframe();
      }
      lastVideoClock = frame.clock;

      const reading = delayMonitor.observe(frame.timestamp, now());
      queueDelayMs = reading.queueDelayMs;
      if (reading.congested) reportCongestion();

      video?.decodeChunk({ keyFrame: frame.keyFrame ?? false, timestampUs: frame.timestamp * 1000, data: frame.payload });
    },
    reportCongestion,
    stats: () => ({ queueDelayMs, gaps, congestionReports }),
  };
}
