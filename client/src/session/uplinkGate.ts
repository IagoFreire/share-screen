import { createQueueDelayMonitor } from "../playback/streamReceiver.js";

/**
 * Keeps the presenter's upload from queueing without bound.
 *
 * WebSocket.send() never refuses data: on an upload slower than the encoders, the
 * browser just buffers, and every viewer drifts further behind live -- audio included,
 * since it shares the socket. The gate drops video once the send buffer holds more than
 * about half a second, then waits for the buffer to drain and restarts the picture on a
 * keyframe (the deltas in between reference frames that never left). The controller
 * lowers the encoders' bitrate while that keeps happening, so the drops stop.
 */

/** How much of the broadcast may sit in the send buffer before video is dropped. */
const UPLINK_QUEUE_SECONDS = 0.6;
/** On top of that: a single keyframe can be several times a second's average frame. */
const UPLINK_QUEUE_SLACK_BYTES = 256 * 1024;

/** The send-buffer size (bytes) past which video is dropped, for a total bitrate in bps. */
export function uplinkHighWaterBytes(totalBitsPerSecond: number): number {
  return Math.round((totalBitsPerSecond * UPLINK_QUEUE_SECONDS) / 8) + UPLINK_QUEUE_SLACK_BYTES;
}

/**
 * "congested": dropped because the socket is backed up (the bitrate should come down);
 * "drop": dropped while waiting for a keyframe to restart on.
 */
export type UplinkDecision = "send" | "congested" | "drop" | "drop-and-request-keyframe";

export interface UplinkGate {
  /** What to do with the next video frame of this layer, given the socket's backlog. */
  admit(isKeyframe: boolean, bufferedBytes: number): UplinkDecision;
}

/** One per simulcast layer: each has its own reference chain. */
export function createUplinkGate(highWaterBytes: number): UplinkGate {
  const lowWaterBytes = highWaterBytes / 2;
  let waitingForKeyframe = false;
  let requested = false;

  return {
    admit(isKeyframe, bufferedBytes) {
      if (bufferedBytes > highWaterBytes) {
        waitingForKeyframe = true;
        requested = false;
        return "congested";
      }
      if (!waitingForKeyframe) return "send";
      if (isKeyframe) {
        waitingForKeyframe = false;
        return "send";
      }
      if (!requested && bufferedBytes < lowWaterBytes) {
        requested = true;
        return "drop-and-request-keyframe";
      }
      return "drop";
    },
  };
}

/**
 * Never encode below this share of the chosen bitrate. Low enough that a slow upload
 * (720p30 lands near 1.3 Mbps in all) still fits under the link instead of keeping the
 * router's queue -- and the presenter's ping in game -- full.
 */
const MIN_SCALE = 0.3;
const STEP_DOWN = 0.8;
const STEP_UP = 1.15;
/** A change needs this long to show in the send buffer before the next one. */
const SETTLE_MS = 2000;
/** Clean for this long before trying more bitrate again... */
const HEALTHY_AFTER_MS = 10_000;
/** ...and then at most one step up this often. */
const STEP_UP_EVERY_MS = 5000;

export interface BitrateController {
  /** Video was dropped; returns the new bitrate scale when it changes, else null. */
  onCongestion(nowMs: number): number | null;
  /** A frame went out fine; returns the new bitrate scale when it changes, else null. */
  onHealthy(nowMs: number): number | null;
}

export function createBitrateController(): BitrateController {
  let scale = 1;
  let lastChangeAt = -Infinity;
  let lastCongestionAt = -Infinity;

  function change(next: number, now: number): number | null {
    if (next === scale) return null;
    scale = next;
    lastChangeAt = now;
    return scale;
  }

  return {
    onCongestion(now) {
      lastCongestionAt = now;
      if (now - lastChangeAt < SETTLE_MS) return null;
      return change(Math.max(MIN_SCALE, scale * STEP_DOWN), now);
    },
    onHealthy(now) {
      if (scale >= 1 || now - lastCongestionAt < HEALTHY_AFTER_MS || now - lastChangeAt < STEP_UP_EVERY_MS) return null;
      return change(Math.min(1, scale * STEP_UP), now);
    },
  };
}

/** How often the presenter sends an uplink-probe. */
export const UPLINK_PROBE_EVERY_MS = 250;
/** A probe the relay never answered (the connection changed) is forgotten after this. */
export const UPLINK_PROBE_FORGET_MS = 10_000;
/**
 * Queueing above the best recent round trip that counts as a filling upload. Every ms
 * of it is added to the presenter's ping in game, so this sits well below where the
 * send buffer (and the gate above) would notice anything.
 */
const UPLINK_QUEUE_LIMIT_MS = 80;
/** ...once it lasts this long: a single keyframe is a short spike, not a full link. */
const UPLINK_QUEUE_SUSTAIN_MS = 500;

export interface UplinkDelayWatch {
  /** A probe sent at `sentMs` came back at `ackMs`; true while the upload stays queued up. */
  observe(sentMs: number, ackMs: number): boolean;
  /** A new connection: its route, and so its round trip, may differ. */
  reset(): void;
}

/**
 * Tells a filling upload from its round trips. An upload near its limit queues in the
 * home router long before WebSocket.bufferedAmount grows, and everything else on that
 * link -- the presenter's game included -- waits in the same queue. Probes sent through
 * the broadcast's own socket wait behind its frames, so their round trip minus the best
 * recent one is that queue.
 */
export function createUplinkDelayWatch(): UplinkDelayWatch {
  let monitor = createQueueDelayMonitor();
  let queuedSince: number | null = null;

  return {
    observe(sentMs, ackMs) {
      const { queueDelayMs } = monitor.observe(sentMs, ackMs);
      if (queueDelayMs <= UPLINK_QUEUE_LIMIT_MS) {
        queuedSince = null;
        return false;
      }
      queuedSince ??= ackMs;
      return ackMs - queuedSince >= UPLINK_QUEUE_SUSTAIN_MS;
    },
    reset() {
      monitor = createQueueDelayMonitor();
      queuedSince = null;
    },
  };
}
