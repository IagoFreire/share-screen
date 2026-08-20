import type { QualityPreset } from "@screenshare-bot/shared";
import {
  VIDEO_FRAMERATE_DEFAULT,
  VIDEO_HEIGHT_DEFAULT,
  VIDEO_WIDTH_DEFAULT,
} from "@screenshare-bot/shared";

export interface CaptureStreams {
  stream: MediaStream;
  videoTrack: MediaStreamTrack;
  audioTrack: MediaStreamTrack | null;
}

/**
 * Captures the presenter's screen via getDisplayMedia(). Requests tab/system audio
 * only (not the microphone) so Discord's own voice-channel audio doesn't loop back
 * into the relay -- matches the Jc007zZ/discord-screen reference's design choice.
 */
export async function startScreenCapture(quality?: QualityPreset): Promise<CaptureStreams> {
  // `ideal` rather than `exact`: the browser picks the closest the chosen source can
  // actually produce, so requesting 1080p from a 900p window degrades gracefully
  // instead of failing outright with OverconstrainedError.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      // Height caps the quality tier; width is left unconstrained so the source keeps
      // its native aspect ratio (see applyConstraints below).
      height: { ideal: quality?.height ?? VIDEO_HEIGHT_DEFAULT },
      frameRate: { ideal: quality?.framerate ?? VIDEO_FRAMERATE_DEFAULT },
    },
    // Explicitly disable the voice-oriented DSP Chrome otherwise applies by default.
    // Echo cancellation, noise suppression and AGC are tuned for microphone speech and
    // audibly wreck music and game audio (pumping, muffled highs, level swings) -- a
    // classic cause of "screen share audio sounds bad". Stereo at 48kHz is requested
    // for the same reason; the browser falls back if the source can't provide it.
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
    },
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error("getDisplayMedia() returned no video track.");
  }

  // The picker often ignores the initial constraints (it hands back the source's
  // native size), so re-apply them to the live track to actually downscale to the
  // requested preset. Best-effort: some sources refuse, and the encoder reads the
  // real dimensions back from the track either way.
  if (quality) {
    try {
      // Height + framerate only, deliberately no width: a shared window is rarely 16:9,
      // and pinning both dimensions makes the browser letterbox or stretch the source
      // to fit. Constraining height alone caps the quality tier while width follows the
      // source's own aspect ratio.
      await videoTrack.applyConstraints({
        height: { ideal: quality.height },
        frameRate: { ideal: quality.framerate },
      });
    } catch (error) {
      console.warn("Could not apply quality constraints to the capture track:", error);
    }
  }

  return {
    stream,
    videoTrack,
    audioTrack: stream.getAudioTracks()[0] ?? null,
  };
}
