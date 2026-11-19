import type { QualityPreset } from "@screenshare-bot/shared";
import {
  ENCODER_QUEUE_DROP_THRESHOLD,
  KEYFRAME_INTERVAL_MS,
  TARGET_VIDEO_BITRATE_KBPS_DEFAULT,
  VIDEO_FRAMERATE_DEFAULT,
  VIDEO_HEIGHT_DEFAULT,
} from "@screenshare-bot/shared";
import { encodeSizeFor } from "./encodeSize.js";
import { encoderAttempts, VIDEO_CODEC_HIGH } from "./encoderChoice.js";
import { createKeyframeTracker } from "./keyframeTracker.js";
import { createStillPicture } from "./stillPicture.js";

// H.264 High profile, Level 5.1 -- supports 1080p60. Chosen over VP9/AV1 for the widest
// hardware-decode compatibility across whatever Chromium build Discord's desktop client
// embeds (see plan risk: "browser codec support variance"). Viewers decode with this;
// Potato may encode Constrained Baseline instead, which it also plays (encoderChoice.ts).
export const VIDEO_CODEC = VIDEO_CODEC_HIGH;

export type EncodedVideoHandler = (chunk: EncodedVideoChunk) => void;

export interface VideoEncodePipelineOptions {
  /** Resolution/framerate/bitrate chosen by the presenter; defaults to 1080p60. */
  quality?: QualityPreset;
  /** 'motion' favors gaming/video content; 'text' keeps on-screen text sharper. */
  contentHint?: "motion" | "text";
}

/**
 * Keyframes asked for from outside (viewers joining or switching, a relay drop, the
 * upload gate) come at most this often. They arrive in bursts -- every viewer of a room
 * reacting to the same event -- and each is 5-15x a delta frame; a burst of them is a
 * visible quality dip and an upload spike. A joining viewer waits at most this long.
 */
const REQUESTED_KEYFRAME_MIN_SPACING_MS = 500;
/** After this many encoder failures, stop asking for the hardware encoder. */
const SOFTWARE_FALLBACK_AFTER_FAILURES = 2;
/** Wait this long before rebuilding a failed encoder, so a broken driver can't spin. */
const ENCODER_RETRY_DELAY_MS = 500;
// No captured frame is ever kept past its encode: they come from the capture's small
// buffer pool, and holding even one starved it under a fullscreen game -- the capture
// stopped delivering and the live froze for everyone while the sound played on. The
// still-screen keyframe is encoded from a canvas copy instead (stillPicture.ts).
/**
 * A keyframe that is due while the capture has sent nothing for this long is encoded
 * from the still-picture copy. Screen capture only delivers a frame when the picture
 * changes, so a viewer joining a still screen would otherwise wait for the next change.
 */
const STALLED_CAPTURE_MS = 200;
/** How often a stalled capture is checked for a keyframe that is due. */
const STALL_CHECK_EVERY_MS = 100;
/**
 * An encoder whose queue stays full this long, with nothing coming out, is stuck and is
 * replaced like a failed one. A full queue is the sign, not silence: rate control may drop
 * every frame for a while, but a dropped frame still leaves the queue -- replacing such an
 * encoder would count as a failure and push it toward the software one. A still screen
 * offers no frames, so it never fills the queue either.
 */
const ENCODER_HUNG_MS = 3000;

export interface VideoEncodePipeline {
  /** Asks for a keyframe soon (e.g. a new viewer joined); see REQUESTED_KEYFRAME_MIN_SPACING_MS. */
  requestKeyframe: () => void;
  /**
   * Skips encoding while nobody watches. The capture keeps running, so resuming is
   * immediate, and the first frame after it is a keyframe.
   */
  setPaused: (paused: boolean) => void;
  /** Encodes at this share (0-1] of the chosen bitrate, for an upload that can't keep up. */
  setBitrateScale: (scale: number) => void;
  stop: () => void;
}

/**
 * Encodes frames pulled from `track` with WebCodecs, tuned for real-time screen/game
 * capture: realtime latency mode, variable bitrate, and a hard drop of any captured
 * frame once the encoder's internal queue backs up (latency over completeness) -- the
 * same tradeoff the Jc007zZ/discord-screen reference makes.
 *
 * An encoder that fails (a GPU driver reset, a hardware session limit) is closed for
 * good by WebCodecs; this rebuilds it instead of letting the broadcast carry on with no
 * picture, and falls back to the software encoder once the hardware one keeps failing.
 */
export async function startVideoEncodePipeline(
  track: MediaStreamTrack,
  onChunk: EncodedVideoHandler,
  options: VideoEncodePipelineOptions = {},
): Promise<VideoEncodePipeline> {
  const targetBitrate = (options.quality?.bitrateKbps ?? TARGET_VIDEO_BITRATE_KBPS_DEFAULT) * 1000;
  const framerate = options.quality?.framerate ?? VIDEO_FRAMERATE_DEFAULT;
  const maxHeight = options.quality?.height ?? VIDEO_HEIGHT_DEFAULT;
  let bitrateScale = 1;
  let failures = 0;
  let retryAt = 0;

  function noteFailure(): void {
    failures += 1;
    retryAt = performance.now() + ENCODER_RETRY_DELAY_MS;
  }

  // Keyframes are followed until they come out of the encoder (see keyframeTracker.ts).
  const keyframes = createKeyframeTracker({
    intervalMs: KEYFRAME_INTERVAL_MS,
    requestSpacingMs: REQUESTED_KEYFRAME_MIN_SPACING_MS,
  });
  /** Since when every frame offered found the encoder's queue full; null while it takes them. */
  let queueFullSince: number | null = null;

  function createEncoder(): VideoEncoder {
    const created: VideoEncoder = new VideoEncoder({
      output: (chunk) => {
        // A replaced encoder has nothing more to say: its chunks would land among the new one's.
        if (created !== encoder) return;
        queueFullSince = null;
        keyframes.onOutput(chunk.type === "key", chunk.timestamp, performance.now());
        onChunk(chunk);
      },
      error: (error) => {
        console.error("VideoEncoder error:", error);
        noteFailure();
      },
    });
    return created;
  }
  let encoder = createEncoder();

  /** Size of the frames the encoder was set up for (the source, not the encoded size). */
  let sourceWidth = 0;
  let sourceHeight = 0;
  /** The capture's last size, kept when an encoder is replaced (which clears the above). */
  let lastSourceWidth = 0;
  let lastSourceHeight = 0;
  let configuredBitrate = 0;
  /** The size the encoder encodes at (encodeSize.ts); the still-picture copy is taken at it. */
  let encodeWidth = 0;
  let encodeHeight = 0;

  /**
   * The encoder is set up for the frames being fed to it: sizes come from the frames
   * themselves rather than the requested preset (a shared window is rarely 16:9), and a
   * window resized mid-broadcast triggers a reconfigure. A source larger than the chosen
   * quality -- a game going fullscreen at the monitor's native size -- is encoded smaller
   * (encodeSize.ts) with the same aspect ratio, and WebCodecs scales each frame down.
   */
  async function supportedConfig(width: number, height: number, bitrate: number): Promise<VideoEncoderConfig> {
    const attempts = encoderAttempts({
      lowPower: options.quality?.lowPower === true,
      softwareOnly: failures >= SOFTWARE_FALLBACK_AFTER_FAILURES,
    });
    const size = encodeSizeFor(width, height, maxHeight, framerate);
    const tried: VideoEncoderConfig[] = [];
    for (const attempt of attempts) {
      const encoderConfig: VideoEncoderConfig = {
        ...attempt,
        width: size.width,
        height: size.height,
        framerate,
        bitrate,
        bitrateMode: "variable",
        latencyMode: "realtime",
        // Annex B makes every keyframe self-contained (inline SPS/PPS + start codes) so the
        // relay can forward raw chunks over WS with no out-of-band description -- the default
        // "avc" (AVCC) format instead requires a separate decoderConfig.description that we
        // never captured/forwarded, which is why the decoder rejected every "keyframe" as
        // invalid ("A key frame is required after configure()"). It also lets viewers pick
        // up a mid-stream resolution change from the inline parameter sets.
        avc: { format: "annexb" },
      };
      const support = await VideoEncoder.isConfigSupported(encoderConfig);
      if (support.supported) return encoderConfig;
      tried.push(encoderConfig);
    }
    throw new Error(`VideoEncoder config not supported by this browser: ${JSON.stringify(tried)}`);
  }

  async function configureFor(width: number, height: number, bitrate: number): Promise<void> {
    const encoderConfig = await supportedConfig(width, height, bitrate);
    encoder.configure(encoderConfig);
    sourceWidth = width;
    sourceHeight = height;
    lastSourceWidth = width;
    lastSourceHeight = height;
    configuredBitrate = bitrate;
    encodeWidth = encoderConfig.width;
    encodeHeight = encoderConfig.height;
  }

  if ("contentHint" in track) {
    (track as MediaStreamTrack & { contentHint: string }).contentHint = options.contentHint ?? "motion";
  }

  const processor = new MediaStreamTrackProcessor<VideoFrame>({ track });
  const reader = processor.readable.getReader();

  let stopped = false;
  let paused = false;

  /**
   * A new encoder, set up on the next frame: after a failure, a hang, or keyframes that
   * keep not coming out. Its first frame is a keyframe, which every viewer can start on.
   */
  function replaceEncoder(): void {
    if (encoder.state !== "closed") encoder.close();
    encoder = createEncoder();
    keyframes.onNewEncoder();
    sourceWidth = 0;
    sourceHeight = 0;
    queueFullSince = null;
  }

  async function encodeFrame(frame: VideoFrame): Promise<void> {
    // stop() may land while a frame waits on a reconfigure; nothing new may start after it.
    if (stopped) return;
    if (encoder.state === "closed") {
      if (performance.now() < retryAt) return;
      replaceEncoder();
    } else if (keyframes.needsNewEncoder) {
      console.warn("The video encoder keeps not producing the keyframes asked of it; starting a new one.");
      replaceEncoder();
    }

    // First frame, the source changed size (e.g. the shared window was resized), or the
    // upload asked for another bitrate.
    const sizeChanged = frame.displayWidth !== sourceWidth || frame.displayHeight !== sourceHeight;
    const bitrate = Math.round(targetBitrate * bitrateScale);
    if (sizeChanged || bitrate !== configuredBitrate) {
      await configureFor(frame.displayWidth, frame.displayHeight, bitrate);
      // Viewers need a fresh keyframe to pick up the new parameter sets.
      if (sizeChanged) keyframes.require();
    }

    const now = performance.now();
    if (encoder.encodeQueueSize > ENCODER_QUEUE_DROP_THRESHOLD) {
      queueFullSince ??= now;
      if (now - queueFullSince > ENCODER_HUNG_MS) {
        console.warn("The video encoder stopped taking frames; starting a new one.");
        noteFailure();
        encoder.close();
      }
      return;
    }
    queueFullSince = null;

    encoder.encode(frame, { keyFrame: keyframes.decide(now, frame.timestamp) });
  }

  const still = createStillPicture();
  /** When the newest captured frame arrived, and its capture timestamp (microseconds). */
  let lastFrameAt = -Infinity;
  let lastFrameTimestamp = 0;
  /** A captured frame is being encoded (it may await a reconfigure): no repeat meanwhile. */
  let encoding = false;
  /** A new encoder being set up for a still screen; the pump waits for it. */
  let settingUp: Promise<void> | null = null;

  /**
   * A still screen whose encoder failed, or whose keyframes keep failing, gets a new encoder
   * right away, set up for the size last captured -- waiting for the next captured frame to
   * do it could take forever.
   */
  function replaceEncoderForStillScreen(): void {
    replaceEncoder();
    settingUp = configureFor(lastSourceWidth, lastSourceHeight, Math.round(targetBitrate * bitrateScale))
      .catch((error) => {
        console.error("Could not set up a new video encoder:", error);
        noteFailure();
        if (encoder.state !== "closed") encoder.close();
      })
      .finally(() => {
        settingUp = null;
      });
  }

  /** A keyframe is due but the capture went quiet: encode the still-picture copy as one. */
  function repeatIfStalled(): void {
    if (stopped || paused || encoding || settingUp) return;
    const now = performance.now();
    if (now - lastFrameAt < STALLED_CAPTURE_MS || lastSourceWidth === 0) return;
    // Only once a keyframe is wanted: nobody needs a working encoder before that.
    const failedEncoder = encoder.state === "closed" && now >= retryAt && keyframes.wants(now);
    if (keyframes.needsNewEncoder || failedEncoder) {
      replaceEncoderForStillScreen();
      return;
    }
    if (encoder.state !== "configured" || !keyframes.wants(now)) return;
    // Stamped as if captured now, on the capture's own clock, so the viewer's A/V sync
    // treats it as current rather than as a stale frame from before the stall.
    const timestamp = lastFrameTimestamp + Math.round((now - lastFrameAt) * 1000);
    const repeat = still.frameAt(encodeWidth, encodeHeight, timestamp);
    if (!repeat) return;
    try {
      if (keyframes.decide(now, timestamp)) encoder.encode(repeat, { keyFrame: true });
    } catch (error) {
      console.error("Still-screen keyframe failed:", error);
    } finally {
      repeat.close();
    }
  }
  const stallTimer = setInterval(repeatIfStalled, STALL_CHECK_EVERY_MS);

  const pump = (async () => {
    while (!stopped) {
      const { done, value: frame } = await reader.read();
      if (done || !frame) break;

      lastFrameAt = performance.now();
      lastFrameTimestamp = frame.timestamp;
      encoding = true;
      try {
        if (settingUp) await settingUp;
        // Still read while paused, so the capture doesn't back up; just never encoded.
        if (!paused) await encodeFrame(frame);
        // Copied (not kept) after the encode, so a resize has set the new encode size.
        // Also while paused: resuming on a still screen needs a picture too.
        if (encodeWidth > 0) still.remember(frame, encodeWidth, encodeHeight, lastFrameAt);
      } catch (error) {
        console.error("Video encode failed; rebuilding the encoder:", error);
        noteFailure();
        if (encoder.state !== "closed") encoder.close();
      } finally {
        encoding = false;
        frame.close();
      }
    }
  })();
  pump.catch((error) => console.error("Video encode pump stopped unexpectedly:", error));

  return {
    requestKeyframe: () => {
      keyframes.request();
    },
    setPaused: (next) => {
      // Whoever arrives needs a keyframe; nothing before the pause is any use to them.
      if (paused && !next) keyframes.require();
      paused = next;
    },
    setBitrateScale: (scale) => {
      bitrateScale = Math.min(1, Math.max(0.1, scale));
    },
    stop: () => {
      stopped = true;
      clearInterval(stallTimer);
      still.clear();
      reader.cancel().catch(() => undefined);
      if (encoder.state !== "closed") encoder.close();
    },
  };
}
