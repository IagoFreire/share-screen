/**
 * Decides which frames to force as keyframes, and checks that a keyframe actually came
 * out of the encoder rather than trusting that one was asked for.
 *
 * Asking is not getting. In realtime mode Chromium lets a hardware encoder drop frames
 * to hold its bitrate (video_encode_accelerator_adapter.cc sets a drop threshold for
 * LatencyMode::Realtime), and on Windows a frame dropped that way never even passes its
 * force-keyframe request on to the driver (media_foundation_video_encode_accelerator_win.cc).
 * The keyframe -- many times a normal frame -- is exactly the one a tight bitrate (Potato,
 * a busy game) drops. Some drivers also just ignore the flag. Either way the request was
 * gone for good: the relay holds a joining viewer's deltas until a keyframe, so that viewer
 * received nothing, never asked again, and sat on "Carregando a live" with the sound
 * playing; a viewer coming back to the window lost its picture the same way.
 *
 * So a forced frame is followed until it comes out: as a keyframe, it settles what was
 * owed; as a delta, or not at all (dropped -- a later frame comes out first, or nothing
 * does within KEYFRAME_ANSWER_TIMEOUT_MS), it is forced again. When keyframes someone is
 * waiting for keep failing, a new encoder is the sure way: its first frame is always one.
 */

/** A forced frame with no answer by then was dropped (a still screen sends no later frame). */
export const KEYFRAME_ANSWER_TIMEOUT_MS = 1000;
/** After a failed keyframe, the next try waits this long: the rate controller needs room. */
export const KEYFRAME_RETRY_GAP_MS = 150;
/** Failed keyframes in a row, someone waiting, before starting a new encoder for one. */
export const FAILED_KEYFRAMES_BEFORE_NEW_ENCODER = 3;

export interface KeyframeTrackerOptions {
  /**
   * A keyframe this often, whether or not anyone asks. Nobody waits on these, so one that
   * fails is only tried again an interval later: an encoder that drops forced frames would
   * otherwise lose a frame for every viewer at each retry.
   */
  intervalMs: number;
  /** Requests are served at most this soon after the last keyframe (they come in bursts). */
  requestSpacingMs: number;
}

export interface KeyframeTracker {
  /** Someone outside needs one: a viewer joining or resyncing, the upload gate. */
  request(): void;
  /** One is needed on the very next frame: a new size, a resume. */
  require(): void;
  /** Whether a frame encoded now should be forced; for the still-screen repeat, before it builds one. */
  wants(now: number): boolean;
  /** For the frame about to be encoded, stamped `timestampUs`: true to force it. Commits to following it. */
  decide(now: number, timestampUs: number): boolean;
  /** A chunk came out of the encoder. */
  onOutput(isKey: boolean, timestampUs: number, now: number): void;
  /** Keyframes someone needs keep failing: start a new encoder, then call onNewEncoder(). */
  readonly needsNewEncoder: boolean;
  /** A new encoder took over; its first frame is forced like the stream's very first. */
  onNewEncoder(): void;
}

/** The frame forced last, while its answer hasn't come out of the encoder. */
interface ForcedFrame {
  timestampUs: number;
  at: number;
}

export function createKeyframeTracker({ intervalMs, requestSpacingMs }: KeyframeTrackerOptions): KeyframeTracker {
  /** The stream's first frame, a new size, a resume, a new encoder: forced at once. */
  let required = true;
  /** The first frame forced since `required` was set: a keyframe from it on settles it. */
  let requiredFromUs: number | null = null;
  let requested = false;
  /** When a keyframe last came out of the encoder. */
  let lastKeyAt = -Infinity;
  let forced: ForcedFrame | null = null;
  let failures = 0;
  let retryAt = -Infinity;
  let periodicTriedAt = -Infinity;

  const someoneWaits = (): boolean => required || requested;

  function fail(now: number): void {
    forced = null;
    if (!someoneWaits()) return; // a periodic one: the interval tries again later
    failures += 1;
    retryAt = now + KEYFRAME_RETRY_GAP_MS;
  }

  function wants(now: number): boolean {
    if (forced && now - forced.at >= KEYFRAME_ANSWER_TIMEOUT_MS) fail(now);
    if (forced || now < retryAt) return false;
    if (required) return true;
    if (requested && now - lastKeyAt >= requestSpacingMs) return true;
    return now - lastKeyAt > intervalMs && now - periodicTriedAt >= intervalMs;
  }

  return {
    request() {
      requested = true;
    },

    require() {
      required = true;
      // Whatever was forced before this point can't serve it (an old size, say).
      requiredFromUs = null;
      forced = null;
      retryAt = -Infinity;
    },

    wants,

    decide(now, timestampUs) {
      if (!wants(now)) return false;
      forced = { timestampUs, at: now };
      if (required) requiredFromUs ??= timestampUs;
      if (!someoneWaits()) periodicTriedAt = now;
      return true;
    },

    onOutput(isKey, timestampUs, now) {
      // Chunks come out in the order frames went in: the first one at or past the forced
      // frame is its answer -- itself, or a later frame because it was dropped.
      const answersForced = forced !== null && timestampUs >= forced.timestampUs;
      if (!isKey) {
        if (answersForced) fail(now);
        return;
      }

      lastKeyAt = now;
      // Any keyframe coming out reaches the relay after a request did, so it serves it.
      requested = false;
      // `required` only by one from a frame forced since it was set -- late counts too: an
      // encoder slow to answer mustn't be pushed into retries and new encoders forever. One
      // from before doesn't: it may be the old size.
      if (required) {
        if (requiredFromUs === null || timestampUs < requiredFromUs) return;
        required = false;
      }
      forced = null;
      failures = 0;
      retryAt = -Infinity;
    },

    get needsNewEncoder() {
      return failures >= FAILED_KEYFRAMES_BEFORE_NEW_ENCODER;
    },

    onNewEncoder() {
      required = true;
      requiredFromUs = null;
      forced = null;
      failures = 0;
      retryAt = -Infinity;
    },
  };
}
