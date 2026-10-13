import type { QualityPreset } from "@screenshare-bot/shared";
import { VIDEO_FRAMERATE_DEFAULT, VIDEO_HEIGHT_DEFAULT } from "@screenshare-bot/shared";

/** Which kind of source the user picked in the browser's capture dialog. */
export type DisplaySurface = "monitor" | "window" | "browser";

/** Why a captured audio track was dropped instead of being broadcast. */
export type AudioDropReason = "system-loopback";

export interface CaptureStreams {
  stream: MediaStream;
  videoTrack: MediaStreamTrack;
  audioTrack: MediaStreamTrack | null;
  /** What the user shared, when the browser reports it (Chromium always does). */
  displaySurface: DisplaySurface | null;
  /** Set when audio *was* captured but deliberately stopped rather than sent. */
  audioDropped: AudioDropReason | null;
}

export interface ScreenCaptureOptions {
  /** Resolution/framerate/bitrate chosen by the presenter; defaults to 1080p60. */
  quality?: QualityPreset;
  /**
   * Broadcast system audio even when the shared source is a whole screen or window.
   * Off by default -- see the loopback note on `dropsSystemAudio` below.
   */
  allowSystemAudioLoopback?: boolean;
}

/**
 * Whether audio captured from `surface` would carry the system mix (and therefore
 * Discord's own output) rather than just one tab.
 *
 * Sharing a whole screen or a window hands back everything the machine is playing,
 * Discord's voice output included -- so the call hears itself back, in a loop that
 * gets worse with every participant. There is no API to subtract one process from
 * that mix: audio is captured per process and the mapping to a window isn't
 * one-to-one. What *is* knowable is the surface the user picked, and that's enough:
 * "browser" means the audio of that one tab and nothing else.
 *
 * `restrictOwnAudio` (requested below) only removes what this page itself plays, which
 * covers a presenter watching in another tab of the same browser -- not the Discord
 * desktop client, which is a separate process entirely.
 */
function dropsSystemAudio(surface: DisplaySurface | null): boolean {
  return surface !== "browser";
}

/**
 * Captures the presenter's screen via getDisplayMedia(). Requests tab/system audio
 * only (never the microphone), and by default refuses to broadcast audio that would
 * loop the call back on itself -- see dropsSystemAudio().
 */
export async function startScreenCapture(options: ScreenCaptureOptions = {}): Promise<CaptureStreams> {
  const { quality, allowSystemAudioLoopback = false } = options;

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
      // Chromium-only (see types/display-capture-extra.d.ts).
      systemAudio: "include",
      restrictOwnAudio: true,
    },
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error("getDisplayMedia() returned no video track.");
  }

  // Not in every lib.dom.d.ts, and narrower than the `string` some versions declare.
  const displaySurface = (videoTrack.getSettings() as { displaySurface?: string }).displaySurface;
  const surface: DisplaySurface | null =
    displaySurface === "monitor" || displaySurface === "window" || displaySurface === "browser"
      ? displaySurface
      : null;

  let audioTrack: MediaStreamTrack | null = stream.getAudioTracks()[0] ?? null;
  let audioDropped: AudioDropReason | null = null;

  if (audioTrack && dropsSystemAudio(surface) && !allowSystemAudioLoopback) {
    // Stopped here, at the source, rather than merely skipped further down the
    // pipeline: the capture indicator should stop claiming this tab is listening to
    // the machine when nothing is going to be sent.
    audioTrack.stop();
    stream.removeTrack(audioTrack);
    audioTrack = null;
    audioDropped = "system-loopback";
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

  return { stream, videoTrack, audioTrack, displaySurface: surface, audioDropped };
}
