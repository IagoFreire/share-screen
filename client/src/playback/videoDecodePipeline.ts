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

export interface VideoDecodePipeline {
  decodeChunk: (chunk: VideoChunkInput) => void;
  /** Frames dropped because playback fell behind or the queue overflowed. */
  readonly droppedFrames: number;
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
   * Called when the decoder has hit an error and can't render anything until a fresh
   * keyframe arrives. Without this the picture stays frozen until the presenter's next
   * periodic keyframe, so the recovery gap is exactly KEYFRAME_INTERVAL_MS long -- which
   * is precisely the interval we want to raise for quality's sake. Asking on demand is
   * what makes a long periodic interval safe.
   */
  onKeyframeNeeded?: () => void;
}

export async function startVideoDecodePipeline(
  canvas: HTMLCanvasElement,
  options: VideoDecodePipelineOptions = {},
): Promise<VideoDecodePipeline> {
  const { clock, onKeyframeNeeded } = options;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");

  const decoderConfig: VideoDecoderConfig = { codec: VIDEO_CODEC, optimizeForLatency: true };
  const support = await VideoDecoder.isConfigSupported(decoderConfig);
  if (!support.supported) {
    throw new Error(`VideoDecoder config not supported by this browser: ${JSON.stringify(decoderConfig)}`);
  }

  const queue: QueuedFrame[] = [];
  let droppedFrames = 0;
  let stopped = false;
  let rafHandle = 0;

  // Maps stream timestamps onto local wall-clock time. Established from the first frame
  // and re-established whenever playback falls behind (see presentFrames).
  let baseTimestampUs: number | null = null;
  let basePerfMs = 0;
  /** Frames older than this are discarded on arrival; raised by resyncToLive(). */
  let minAcceptableTimestampUs = 0;

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

  /** Presents every frame whose scheduled time has arrived, drawing only the newest. */
  function presentFrames(): void {
    rafHandle = requestAnimationFrame(presentFrames);
    if (queue.length === 0) return;

    const dueUpToUs = dueThresholdUs();

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

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (stopped) {
        frame.close();
        return;
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
    },
    error: (error) => {
      console.error("VideoDecoder error:", error);
      // Resync on the next keyframe rather than staying broken. Mid-stream resolution
      // changes (the presenter resizing a shared window) can upset the decoder, and the
      // encoder emits a keyframe right after any such change.
      waitingForKeyframe = true;
      // Don't wait out the periodic interval for one -- ask now.
      onKeyframeNeeded?.();
    },
  });
  decoder.configure(decoderConfig);

  let waitingForKeyframe = true;
  rafHandle = requestAnimationFrame(presentFrames);

  return {
    decodeChunk: (chunk) => {
      if (decoder.state !== "configured") return;

      // A decoder can only start on a keyframe; silently wait until one arrives
      // (e.g. right after connecting, or after a request-keyframe round-trip).
      if (waitingForKeyframe && !chunk.keyFrame) return;
      waitingForKeyframe = false;

      decoder.decode(
        new EncodedVideoChunk({
          type: chunk.keyFrame ? "key" : "delta",
          timestamp: chunk.timestampUs,
          data: chunk.data,
        }),
      );
    },
    get droppedFrames() {
      return droppedFrames;
    },
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
