import {
  FrameType,
  SLOT_PRESENTER,
  type ControlMessage,
  type FrameHeader,
  type QualityPreset,
} from "@screenshare-bot/shared";
import type { CaptureStreams } from "../capture/screenCapture.js";
import type { startAudioEncodePipeline, AudioEncodePipeline } from "../capture/audioEncodePipeline.js";
import type { startVideoEncodePipeline, VideoEncodePipeline } from "../capture/videoEncodePipeline.js";

/**
 * One person's broadcast, independent of any page: capture -> encode -> frames on the
 * wire, plus the control messages the relay sends a presenter. present.html and the
 * desktop app each wrap it in their own UI; the transport and the capture are injected
 * so neither has to share the other's (the desktop picks its source in Electron first).
 */
export interface PresenterSessionDeps {
  sendFrame(header: FrameHeader, payload: Uint8Array): void;
  sendControl(message: ControlMessage): void;
  capture(quality: QualityPreset): Promise<CaptureStreams>;
  startVideo: typeof startVideoEncodePipeline;
  startAudio: typeof startAudioEncodePipeline;
  presenterId: string | null;
}

export interface PresenterSession {
  readonly isPresenting: boolean;
  start(quality: QualityPreset): Promise<{ hasAudio: boolean }>;
  /** Idempotent; tells the relay only if a broadcast was actually live. */
  stop(): void;
  /** Handles presenting-started, request-keyframe and request-stop-presenting; false otherwise. */
  handleControl(message: ControlMessage): boolean;
  /** Called when the broadcast ends without the caller asking: source closed, or the relay stopped it. */
  onEnded(listener: () => void): void;
}

/**
 * WebCodecs timestamps are microseconds; the wire format carries milliseconds.
 *
 * Frames are stamped with the chunk's own capture timestamp, NOT performance.now() at
 * send time. Send-time stamps bake in however long a frame spent being encoded, which
 * varies with scene complexity and encoder queue depth -- audio encodes far faster and
 * more consistently, so the A/V relationship would jitter by tens of milliseconds at the
 * source. Capture timestamps share one clock across the audio and video tracks, which is
 * what lets the viewer line the two back up.
 */
const MICROSECONDS_PER_MILLISECOND = 1000;

function copyChunk(chunk: EncodedVideoChunk | EncodedAudioChunk): Uint8Array {
  const payload = new Uint8Array(chunk.byteLength);
  chunk.copyTo(payload);
  return payload;
}

export function createPresenterSession(deps: PresenterSessionDeps): PresenterSession {
  let isPresenting = false;
  /** Assigned by the relay in presenting-started; SLOT_PRESENTER until then. */
  let slot = SLOT_PRESENTER;
  let videoClock = 0;
  let audioClock = 0;
  let video: VideoEncodePipeline | null = null;
  let audio: AudioEncodePipeline | null = null;
  const endedListeners: Array<() => void> = [];

  function stop(): void {
    if (!isPresenting) return;
    video?.stop();
    video = null;
    audio?.stop();
    audio = null;
    isPresenting = false;
    deps.sendControl({ kind: "stop-presenting" });
  }

  function endOnItsOwn(): void {
    if (!isPresenting) return;
    stop();
    for (const listener of endedListeners) listener();
  }

  return {
    get isPresenting() {
      return isPresenting;
    },

    async start(quality) {
      const { videoTrack, audioTrack } = await deps.capture(quality);

      video = await deps.startVideo(
        videoTrack,
        (chunk) => {
          videoClock += 1;
          deps.sendFrame(
            {
              slot,
              type: FrameType.Video,
              timestamp: chunk.timestamp / MICROSECONDS_PER_MILLISECOND,
              clock: videoClock,
              keyFrame: chunk.type === "key",
            },
            copyChunk(chunk),
          );
        },
        { quality },
      );

      if (audioTrack) {
        audio = await deps.startAudio(audioTrack, (chunk) => {
          audioClock += 1;
          deps.sendFrame(
            { slot, type: FrameType.Audio, timestamp: chunk.timestamp / MICROSECONDS_PER_MILLISECOND, clock: audioClock },
            copyChunk(chunk),
          );
        });
      }

      videoTrack.addEventListener("ended", endOnItsOwn);

      deps.sendControl({ kind: "start-presenting", presenterId: deps.presenterId, audio: audio?.params ?? null });
      isPresenting = true;
      return { hasAudio: audioTrack !== null };
    },

    stop,

    handleControl(message) {
      switch (message.kind) {
        case "presenting-started":
          slot = message.slot;
          return true;
        case "request-keyframe":
          video?.requestKeyframe();
          return true;
        case "request-stop-presenting":
          endOnItsOwn();
          return true;
        default:
          return false;
      }
    },

    onEnded(listener) {
      endedListeners.push(listener);
    },
  };
}
