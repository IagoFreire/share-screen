import type { QualityPreset } from "@screenshare-bot/shared";
import {
  ENCODER_QUEUE_DROP_THRESHOLD,
  KEYFRAME_INTERVAL_MS,
  TARGET_VIDEO_BITRATE_KBPS_DEFAULT,
  VIDEO_FRAMERATE_DEFAULT,
} from "@screenshare-bot/shared";
import { encoderAttempts, VIDEO_CODEC_HIGH } from "./encoderChoice.js";

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
  let bitrateScale = 1;
  let failures = 0;
  let retryAt = 0;

  function noteFailure(): void {
    failures += 1;
    retryAt = performance.now() + ENCODER_RETRY_DELAY_MS;
  }

  function createEncoder(): VideoEncoder {
    return new VideoEncoder({
      output: (chunk) => onChunk(chunk),
      error: (error) => {
        console.error("VideoEncoder error:", error);
        noteFailure();
      },
    });
  }
  let encoder = createEncoder();

  // H.264 requires even dimensions.
  const toEven = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  let configuredWidth = 0;
  let configuredHeight = 0;
  let configuredBitrate = 0;

  /**
   * The encoder must be configured to the exact size of the frames being fed to it:
   * anything else gets scaled to the configured size, which stretches the picture when
   * the aspect ratios differ (very visible when sharing a browser window, which is
   * rarely 16:9). Sizes therefore come from the frames themselves rather than the
   * requested preset, and a shared window that gets resized mid-broadcast triggers a
   * reconfigure instead of silently distorting from then on.
   */
  /** The first encoder setup (see encoderAttempts) this browser supports for these settings. */
  async function supportedConfig(width: number, height: number, bitrate: number): Promise<VideoEncoderConfig> {
    const attempts = encoderAttempts({
      lowPower: options.quality?.lowPower === true,
      softwareOnly: failures >= SOFTWARE_FALLBACK_AFTER_FAILURES,
    });
    const tried: VideoEncoderConfig[] = [];
    for (const attempt of attempts) {
      const encoderConfig: VideoEncoderConfig = {
        ...attempt,
        width: toEven(width),
        height: toEven(height),
        framerate: options.quality?.framerate ?? VIDEO_FRAMERATE_DEFAULT,
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
    configuredWidth = encoderConfig.width;
    configuredHeight = encoderConfig.height;
    configuredBitrate = bitrate;
  }

  if ("contentHint" in track) {
    (track as MediaStreamTrack & { contentHint: string }).contentHint = options.contentHint ?? "motion";
  }

  const processor = new MediaStreamTrackProcessor<VideoFrame>({ track });
  const reader = processor.readable.getReader();

  let stopped = false;
  let paused = false;
  let lastKeyframeAt = -Infinity;
  /** A keyframe on the very next frame: the start, a new size, a resume, a rebuilt encoder. */
  let mustKeyframe = true;
  /** Someone outside asked for one; honoured within REQUESTED_KEYFRAME_MIN_SPACING_MS. */
  let keyframeRequested = false;

  async function encodeFrame(frame: VideoFrame): Promise<void> {
    if (encoder.state === "closed") {
      if (performance.now() < retryAt) return;
      encoder = createEncoder();
      configuredWidth = 0;
      configuredHeight = 0;
    }

    // First frame, the source changed size (e.g. the shared window was resized), or the
    // upload asked for another bitrate.
    const sizeChanged = frame.displayWidth !== configuredWidth || frame.displayHeight !== configuredHeight;
    const bitrate = Math.round(targetBitrate * bitrateScale);
    if (sizeChanged || bitrate !== configuredBitrate) {
      await configureFor(frame.displayWidth, frame.displayHeight, bitrate);
      // Viewers need a fresh keyframe to pick up the new parameter sets.
      if (sizeChanged) mustKeyframe = true;
    }

    if (encoder.encodeQueueSize > ENCODER_QUEUE_DROP_THRESHOLD) return;

    const now = performance.now();
    const keyFrame =
      mustKeyframe ||
      (keyframeRequested && now - lastKeyframeAt >= REQUESTED_KEYFRAME_MIN_SPACING_MS) ||
      now - lastKeyframeAt > KEYFRAME_INTERVAL_MS;
    if (keyFrame) {
      lastKeyframeAt = now;
      mustKeyframe = false;
      keyframeRequested = false;
    }

    encoder.encode(frame, { keyFrame });
  }

  const pump = (async () => {
    while (!stopped) {
      const { done, value: frame } = await reader.read();
      if (done || !frame) break;

      try {
        // Still read while paused, so the capture doesn't back up; just never encoded.
        if (!paused) await encodeFrame(frame);
      } catch (error) {
        console.error("Video encode failed; rebuilding the encoder:", error);
        noteFailure();
        if (encoder.state !== "closed") encoder.close();
      } finally {
        frame.close();
      }
    }
  })();
  pump.catch((error) => console.error("Video encode pump stopped unexpectedly:", error));

  return {
    requestKeyframe: () => {
      keyframeRequested = true;
    },
    setPaused: (next) => {
      // Whoever arrives needs a keyframe; nothing before the pause is any use to them.
      if (paused && !next) mustKeyframe = true;
      paused = next;
    },
    setBitrateScale: (scale) => {
      bitrateScale = Math.min(1, Math.max(0.1, scale));
    },
    stop: () => {
      stopped = true;
      reader.cancel().catch(() => undefined);
      if (encoder.state !== "closed") encoder.close();
    },
  };
}
