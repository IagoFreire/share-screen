import type { QualityPreset } from "@screenshare-bot/shared";
import {
  ENCODER_QUEUE_DROP_THRESHOLD,
  KEYFRAME_INTERVAL_MS,
  TARGET_VIDEO_BITRATE_KBPS_DEFAULT,
  VIDEO_FRAMERATE_DEFAULT,
  VIDEO_HEIGHT_DEFAULT,
  VIDEO_WIDTH_DEFAULT,
} from "@screenshare-bot/shared";

// H.264 High profile, Level 5.1 -- supports 1080p60. Chosen over VP9/AV1 for the widest
// hardware-decode compatibility across whatever Chromium build Discord's desktop client
// embeds (see plan risk: "browser codec support variance").
export const VIDEO_CODEC = "avc1.640033";

export type EncodedVideoHandler = (chunk: EncodedVideoChunk) => void;

export interface VideoEncodePipelineOptions {
  /** Resolution/framerate/bitrate chosen by the presenter; defaults to 1080p60. */
  quality?: QualityPreset;
  /** 'motion' favors gaming/video content; 'text' keeps on-screen text sharper. */
  contentHint?: "motion" | "text";
}

export interface VideoEncodePipeline {
  /** Forces the next encoded frame to be a keyframe (e.g. when a new viewer joins). */
  requestKeyframe: () => void;
  stop: () => void;
}

/**
 * Encodes frames pulled from `track` with WebCodecs, tuned for real-time screen/game
 * capture: realtime latency mode, variable bitrate, and a hard drop of any captured
 * frame once the encoder's internal queue backs up (latency over completeness) -- the
 * same tradeoff the Jc007zZ/discord-screen reference makes.
 */
export async function startVideoEncodePipeline(
  track: MediaStreamTrack,
  onChunk: EncodedVideoHandler,
  options: VideoEncodePipelineOptions = {},
): Promise<VideoEncodePipeline> {
  const encoder = new VideoEncoder({
    output: (chunk) => onChunk(chunk),
    error: (error) => console.error("VideoEncoder error:", error),
  });

  // H.264 requires even dimensions.
  const toEven = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  let configuredWidth = 0;
  let configuredHeight = 0;

  /**
   * The encoder must be configured to the exact size of the frames being fed to it:
   * anything else gets scaled to the configured size, which stretches the picture when
   * the aspect ratios differ (very visible when sharing a browser window, which is
   * rarely 16:9). Sizes therefore come from the frames themselves rather than the
   * requested preset, and a shared window that gets resized mid-broadcast triggers a
   * reconfigure instead of silently distorting from then on.
   */
  async function configureFor(width: number, height: number): Promise<void> {
    const encoderConfig: VideoEncoderConfig = {
      codec: VIDEO_CODEC,
      width: toEven(width),
      height: toEven(height),
      framerate: options.quality?.framerate ?? VIDEO_FRAMERATE_DEFAULT,
      bitrate: (options.quality?.bitrateKbps ?? TARGET_VIDEO_BITRATE_KBPS_DEFAULT) * 1000,
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
    if (!support.supported) {
      throw new Error(`VideoEncoder config not supported by this browser: ${JSON.stringify(encoderConfig)}`);
    }

    encoder.configure(encoderConfig);
    configuredWidth = encoderConfig.width;
    configuredHeight = encoderConfig.height;
  }

  if ("contentHint" in track) {
    (track as MediaStreamTrack & { contentHint: string }).contentHint = options.contentHint ?? "motion";
  }

  const processor = new MediaStreamTrackProcessor<VideoFrame>({ track });
  const reader = processor.readable.getReader();

  let stopped = false;
  let lastKeyframeAt = 0;
  let forceKeyframeNow = true; // always start with a keyframe

  const pump = (async () => {
    while (!stopped) {
      const { done, value: frame } = await reader.read();
      if (done || !frame) break;

      // First frame, or the source changed size (e.g. the shared window was resized).
      if (frame.displayWidth !== configuredWidth || frame.displayHeight !== configuredHeight) {
        await configureFor(frame.displayWidth, frame.displayHeight);
        // Viewers need a fresh keyframe to pick up the new parameter sets.
        forceKeyframeNow = true;
      }

      if (encoder.encodeQueueSize > ENCODER_QUEUE_DROP_THRESHOLD) {
        frame.close();
        continue;
      }

      const now = performance.now();
      const keyFrame = forceKeyframeNow || now - lastKeyframeAt > KEYFRAME_INTERVAL_MS;
      if (keyFrame) {
        lastKeyframeAt = now;
        forceKeyframeNow = false;
      }

      encoder.encode(frame, { keyFrame });
      frame.close();
    }
  })();
  pump.catch((error) => console.error("Video encode pump stopped unexpectedly:", error));

  return {
    requestKeyframe: () => {
      forceKeyframeNow = true;
    },
    stop: () => {
      stopped = true;
      reader.cancel().catch(() => undefined);
      if (encoder.state !== "closed") encoder.close();
    },
  };
}
