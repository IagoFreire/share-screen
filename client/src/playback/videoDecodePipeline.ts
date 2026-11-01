import {
  AV_SYNC_PLAUSIBILITY_WINDOW_US,
  VIDEO_JITTER_BUFFER_MAX_FRAMES,
  VIDEO_JITTER_BUFFER_SECONDS,
} from "@screenshare-bot/shared";
import { VIDEO_CODEC } from "../capture/videoEncodePipeline.js";
import type { MediaClock } from "./mediaClock.js";

export interface VideoChunkInput {
  keyFrame: boolean;
  timestampUs: number;
  data: Uint8Array;
}

export interface VideoPlaybackStats {
  /** Frames dropped because playback fell behind or the queue overflowed. */
  droppedFrames: number;
  /** Decoded frames waiting for their moment on screen. */
  queuedFrames: number;
  /** Chunks inside the decoder, not decoded yet. */
  decodeQueue: number;
  /** How long the oldest chunk inside the decoder has waited, ms. */
  decodeLagMs: number;
  /** Times a backlog stuck in the decoder was dropped to get back to live. */
  catchUps: number;
  /** Times the decoder fell so far behind that its backlog was thrown away. */
  overloads: number;
  waitingForKeyframe: boolean;
}

export interface VideoDecodePipeline {
  decodeChunk: (chunk: VideoChunkInput) => void;
  /** Frames dropped because playback fell behind or the queue overflowed. */
  readonly droppedFrames: number;
  /**
   * Ignores deltas until the next keyframe: a frame went missing (see the sequence check
   * in streamReceiver.ts), and every delta after it would decode into corruption.
   */
  awaitKeyframe: () => void;
  stats: () => VideoPlaybackStats;
  /**
   * Drops every buffered frame and resets the clock so the next decoded frame is
   * presented immediately instead of the queue playing out. Call this when the tab was
   * backgrounded/unfocused for a while: browsers keep delivering and decoding frames in
   * a hidden tab while throttling rendering, so without this the viewer sees the whole
   * gap play back in fast-forward once the tab is visible again -- App.ts wires this to
   * visibility/focus regain, paired with a request-keyframe so the decoder has a clean
   * frame to resume on.
   */
  resyncToLive: () => void;
  stop: () => void;
}

interface QueuedFrame {
  frame: VideoFrame;
  timestampUs: number;
}

/**
 * Decodes incoming H.264 chunks and draws them to `canvas`.
 *
 * Decoded frames go through a jitter buffer rather than being painted the moment they
 * decode: packets arrive unevenly on a congested link, and drawing on arrival turns that
 * unevenness directly into visible stutter. Holding frames for a fixed lead and then
 * presenting them against a clock absorbs the jitter, at the cost of that much latency.
 * The lead matches AUDIO_JITTER_BUFFER_SECONDS so audio and video stay in sync.
 */
export interface VideoDecodePipelineOptions {
  /** Audio clock to present against; omitted when the broadcast carries no audio. */
  clock?: MediaClock;
  /**
   * Called when the decoder can't render anything until a fresh keyframe arrives (it
   * failed, refused a chunk, or had to drop its backlog). Without this the picture stays
   * frozen until the presenter's next periodic keyframe, KEYFRAME_INTERVAL_MS away --
   * asking on demand is what makes a long periodic interval safe.
   */
  onKeyframeNeeded?: () => void;
  /**
   * Called when this machine can't decode the stream in real time; "auto" quality then
   * steps down (see report-congestion).
   */
  onOverload?: () => void;
}

/**
 * How long the oldest chunk has waited inside the decoder is what says it fell behind
 * -- measured on the wall clock, so sparse frames (a still screen) never look late, and
 * not in queued chunks: a hardware decoder routinely holds 30+ of those while decoded
 * frames wait in the jitter buffer, and counting them killed it dozens of times a
 * minute.
 *
 * Past MAX_DECODE_WAIT_MS this machine can't keep up: the backlog is dropped and "auto"
 * is told to step down. A smaller wait that lasts (CATCH_UP_*) is a backlog stuck in
 * place -- typically left by a minimized window, after which the decoder only runs as
 * fast as frames are shown, so it never drains -- and the decoder is just restarted on
 * a fresh keyframe.
 */
const MAX_DECODE_WAIT_MS = 2000;
const CATCH_UP_WAIT_MS = 500;
const CATCH_UP_AFTER_MS = 2000;
/** Bound on the bookkeeping of chunks inside the decoder. */
const MAX_PENDING_CHUNKS = 600;
/** A typical display refresh until the real one has been measured. */
const DEFAULT_REFRESH_MS = 1000 / 60;

export async function startVideoDecodePipeline(
  canvas: HTMLCanvasElement,
  options: VideoDecodePipelineOptions = {},
): Promise<VideoDecodePipeline> {
  const { clock, onKeyframeNeeded, onOverload } = options;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");

  const decoderConfig: VideoDecoderConfig = { codec: VIDEO_CODEC, optimizeForLatency: true };
  const support = await VideoDecoder.isConfigSupported(decoderConfig);
  if (!support.supported) {
    throw new Error(`VideoDecoder config not supported by this browser: ${JSON.stringify(decoderConfig)}`);
  }

  const queue: QueuedFrame[] = [];
  let droppedFrames = 0;
  let overloads = 0;
  let stopped = false;
  let rafHandle = 0;
  /** A decoder can only start on a keyframe; true until one has been decoded. */
  let waitingForKeyframe = true;
  /** Chunks inside the decoder: stream timestamp -> performance.now() when handed in, oldest first. */
  let pending = new Map<number, number>();
  /** Since when the oldest chunk has waited longer than CATCH_UP_WAIT_MS; null when not. */
  let laggingSince: number | null = null;
  let catchUps = 0;

  // Maps stream timestamps onto local wall-clock time. Established from the first frame
  // and re-established whenever playback falls behind (see presentFrames).
  let baseTimestampUs: number | null = null;
  let basePerfMs = 0;
  /** Frames older than this are discarded on arrival; raised by resyncToLive(). */
  let minAcceptableTimestampUs = 0;
  /** Measured display refresh interval, from the animation frames themselves. */
  let refreshMs = DEFAULT_REFRESH_MS;
  let lastRafAt: number | null = null;

  function drawFrame(frame: VideoFrame): void {
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    ctx!.drawImage(frame, 0, 0, canvas.width, canvas.height);
  }

  /**
   * The stream timestamp that should be on screen right now.
   *
   * Prefers the audio clock: audio is scheduled first and can't be nudged without
   * audible damage, so video follows it. That single shared reference is what keeps the
   * two aligned through network trouble -- whenever audio re-anchors itself, video lands
   * on the new position on its very next frame instead of drifting apart silently.
   * Falls back to self-clocking when there's no audio to follow.
   */
  function dueThresholdUs(): number {
    const audioUs = clock?.currentTimestampUs() ?? null;

    // Deliberately one-sided. Audio running *ahead* of every queued frame is not a
    // broken timebase, it's video that fell behind -- a long alt-tab leaves the decoder
    // producing frames while rendering is throttled -- and the right answer there is to
    // trust the clock so the loop below discards the backlog and jumps to live. Treating
    // that as implausible is what made the picture replay the backlog from its oldest
    // frame while audio stayed current.
    //
    // The direction that genuinely has to be caught is audio far *behind* everything
    // buffered: no frame would ever come due and the picture would freeze for good.
    const plausible = audioUs !== null && audioUs >= queue[0]!.timestampUs - AV_SYNC_PLAUSIBILITY_WINDOW_US;

    if (plausible) {
      // Re-prime the fallback so it starts from live if audio later drops out.
      baseTimestampUs = null;
      return audioUs;
    }

    const nowMs = performance.now();
    if (baseTimestampUs === null) {
      baseTimestampUs = queue[0]!.timestampUs;
      basePerfMs = nowMs + VIDEO_JITTER_BUFFER_SECONDS * 1000;
    }
    return baseTimestampUs + (nowMs - basePerfMs) * 1000;
  }

  /**
   * Presents every frame whose scheduled time has arrived, drawing only the newest.
   *
   * What is drawn now reaches the screen at the next refresh, so frames are picked for
   * that moment rather than this one -- otherwise every picture shows a refresh late and
   * the sound runs a frame ahead of it.
   */
  function presentFrames(rafNow: number): void {
    rafHandle = requestAnimationFrame(presentFrames);
    if (lastRafAt !== null) {
      const interval = rafNow - lastRafAt;
      // Ignore the long gaps of a throttled or hidden window.
      if (interval > 0 && interval < 100) refreshMs += (interval - refreshMs) * 0.1;
    }
    lastRafAt = rafNow;
    if (queue.length === 0) return;

    const dueUpToUs = dueThresholdUs() + refreshMs * 1000;

    let due: QueuedFrame | undefined;
    while (queue.length > 0 && queue[0]!.timestampUs <= dueUpToUs) {
      // Anything older than the newest due frame is already stale: close it rather than
      // drawing every intermediate frame, which would only add work to catch up.
      if (due) {
        due.frame.close();
        droppedFrames += 1;
      }
      due = queue.shift();
    }

    if (due) {
      drawFrame(due.frame);
      due.frame.close();
    }
  }

  /**
   * Closes every due frame except the newest, without waiting for a paint.
   *
   * presentFrames() does the same, but only when an animation frame runs -- and none run
   * while the window is minimized or covered by another app. Held VideoFrames are the
   * hardware decoder's own output surfaces: with dozens parked here it runs out and
   * stops decoding, every chunk arriving meanwhile piles up inside it, and once visible
   * again that backlog plays out at roughly real time, leaving the live seconds behind.
   */
  function dropOverdueFrames(): void {
    if (queue.length < 2) return;
    const dueUpToUs = dueThresholdUs();
    while (queue.length > 1 && queue[1]!.timestampUs <= dueUpToUs) {
      queue.shift()!.frame.close();
      droppedFrames += 1;
    }
  }

  function onFrame(frame: VideoFrame): void {
    if (stopped) {
      frame.close();
      return;
    }
    // This chunk is out, and so is everything handed in before it.
    for (const timestampUs of pending.keys()) {
      if (timestampUs > frame.timestamp) break;
      pending.delete(timestampUs);
    }

    // Chunks handed to the decoder before a resync keep producing output afterwards,
    // so emptying the queue isn't enough on its own -- that backlog would flow right
    // back in and re-establish the delay we just dropped. Anything older than the
    // resync point is stale by definition.
    if (frame.timestamp < minAcceptableTimestampUs) {
      frame.close();
      droppedFrames += 1;
      return;
    }

    queue.push({ frame, timestampUs: frame.timestamp });

    // Bounded queue: VideoFrames hold real memory, so a stalled viewer can't be
    // allowed to accumulate them indefinitely.
    while (queue.length > VIDEO_JITTER_BUFFER_MAX_FRAMES) {
      queue.shift()!.frame.close();
      droppedFrames += 1;
      // The buffer overflowed, so the clock mapping is stale; re-prime it.
      baseTimestampUs = null;
    }

    dropOverdueFrames();
  }

  function needKeyframe(): void {
    waitingForKeyframe = true;
    onKeyframeNeeded?.();
  }

  /**
   * WebCodecs closes a decoder for good when decoding fails (verified in Chrome: the
   * state goes to "closed" and every later decode() throws), so recovering means a new
   * one -- waiting for a keyframe on the dead one froze the picture until "Atualizar".
   */
  function createDecoder(): VideoDecoder {
    const created = new VideoDecoder({
      output: onFrame,
      error: (error) => {
        console.error("VideoDecoder error:", error);
        // Mid-stream resolution changes (the presenter resizing a shared window) and
        // hardware hiccups both land here; the next chunk gets a fresh decoder.
        needKeyframe();
      },
    });
    created.configure(decoderConfig);
    return created;
  }
  let decoder = createDecoder();

  /** Throws away everything inside the decoder and restarts on the next keyframe. */
  function restartDecoder(): void {
    if (decoder.state !== "closed") decoder.close();
    decoder = createDecoder();
    pending = new Map();
    laggingSince = null;
    needKeyframe();
  }

  /** Restarts a decoder that fell behind; see MAX_DECODE_WAIT_MS. */
  function checkDecoderLag(): void {
    // A hidden window's decoder isn't judged: it would only be stepped down for nobody,
    // and coming back runs resyncToLive, which starts it fresh anyway.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      laggingSince = null;
      return;
    }
    const now = performance.now();
    const oldest = pending.values().next();
    const waitMs = oldest.done ? 0 : now - oldest.value;
    if (waitMs > MAX_DECODE_WAIT_MS) {
      restartDecoder();
      overloads += 1;
      onOverload?.();
    } else if (waitMs > CATCH_UP_WAIT_MS) {
      laggingSince ??= now;
      if (now - laggingSince >= CATCH_UP_AFTER_MS) {
        restartDecoder();
        catchUps += 1;
      }
    } else {
      laggingSince = null;
    }
  }

  rafHandle = requestAnimationFrame(presentFrames);

  return {
    decodeChunk: (chunk) => {
      if (stopped) return;
      if (decoder.state === "closed") {
        decoder = createDecoder();
        pending = new Map();
      }
      checkDecoderLag();

      // A decoder can only start on a keyframe; silently wait until one arrives
      // (e.g. right after connecting, or after a request-keyframe round-trip).
      if (waitingForKeyframe && !chunk.keyFrame) return;

      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: chunk.keyFrame ? "key" : "delta",
            timestamp: chunk.timestampUs,
            data: chunk.data,
          }),
        );
        waitingForKeyframe = false;
        pending.set(chunk.timestampUs, performance.now());
        if (pending.size > MAX_PENDING_CHUNKS) pending.delete(pending.keys().next().value!);
      } catch (error) {
        // Refused outright (e.g. "a key frame is required"): start over on a keyframe.
        console.error("Video decode refused a chunk:", error);
        needKeyframe();
      }
    },
    get droppedFrames() {
      return droppedFrames;
    },
    awaitKeyframe: () => {
      waitingForKeyframe = true;
    },
    stats: () => ({
      droppedFrames,
      queuedFrames: queue.length,
      decodeQueue: decoder.decodeQueueSize,
      decodeLagMs: (() => {
        const oldest = pending.values().next();
        return oldest.done ? 0 : Math.max(0, performance.now() - oldest.value);
      })(),
      overloads,
      catchUps,
      waitingForKeyframe,
    }),
    resyncToLive: () => {
      // Everything buffered is behind live, so the newest of it marks the cutoff: any
      // frame decoded from here on that predates it belongs to the backlog being
      // dropped, not to the stream we're resuming on.
      const newestUs = queue[queue.length - 1]?.timestampUs;
      if (newestUs !== undefined) minAcceptableTimestampUs = newestUs;

      for (const queued of queue) queued.frame.close();
      droppedFrames += queue.length;
      queue.length = 0;
      baseTimestampUs = null;
      waitingForKeyframe = true;

      // The backlog built while hidden also sits inside the decoder, where emptying the
      // queue above doesn't reach. Left there it kept the picture ~1 s behind, stuttering,
      // until the app was restarted; a fresh decoder drops it. The caller asks for the
      // keyframe it starts on.
      if (decoder.state !== "closed") decoder.close();
      decoder = createDecoder();
      pending = new Map();
      laggingSince = null;
    },
    stop: () => {
      stopped = true;
      cancelAnimationFrame(rafHandle);
      for (const queued of queue) queued.frame.close();
      queue.length = 0;
      if (decoder.state !== "closed") decoder.close();
    },
  };
}
