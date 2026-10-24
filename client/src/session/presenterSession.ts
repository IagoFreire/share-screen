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
  /** How far to shift the audio onto the video's clock (see capture/clockOffset.ts); 0 when absent. */
  measureAudioRebaseUs?(videoTrack: MediaStreamTrack, audioTrack: MediaStreamTrack): Promise<number>;
  presenterId: string | null;
}

export interface PresenterSession {
  readonly isPresenting: boolean;
  /**
   * `layers` (simulcast, desktop app only) is the full plan with `quality` first -- see
   * planLayers(). One encoder runs per layer; omitted or single-entry means one version.
   */
  start(quality: QualityPreset, layers?: QualityPreset[]): Promise<{ hasAudio: boolean }>;
  /** Idempotent; tells the relay only if a broadcast was actually live. */
  stop(): void;
  /**
   * Handles presenting-started, request-keyframe, request-stop-presenting and
   * audience-changed (which pauses the broadcast while nobody watches); false otherwise.
   */
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
  let audioClock = 0;
  /** One encoder per simulcast layer, index = layer (0 = best). */
  let videos: VideoEncodePipeline[] = [];
  /** Downscaled clones feeding the lower layers; ours to stop. */
  let layerTracks: MediaStreamTrack[] = [];
  let audio: AudioEncodePipeline | null = null;
  /** From audience-changed: nobody wants the picture / nobody is watching at all. */
  let videoPaused = false;
  let audioPaused = false;
  const endedListeners: Array<() => void> = [];

  function stop(): void {
    if (!isPresenting) return;
    for (const pipeline of videos) pipeline.stop();
    videos = [];
    for (const track of layerTracks) track.stop();
    layerTracks = [];
    audio?.stop();
    audio = null;
    isPresenting = false;
    videoPaused = false;
    audioPaused = false;
    deps.sendControl({ kind: "stop-presenting" });
  }

  /**
   * Follows the relay's count of who watches. The video encoders stop outright for an
   * audience that wants no picture; audio is only held back from the wire, since Opus
   * costs next to nothing to encode and its capture timeline expects every packet.
   */
  function applyAudience(watchers: number, videoWatchers: number): void {
    audioPaused = watchers === 0;
    const pauseVideo = videoWatchers === 0;
    if (pauseVideo === videoPaused) return;
    videoPaused = pauseVideo;
    for (const pipeline of videos) pipeline.setPaused(pauseVideo);
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

    async start(quality, layers) {
      const { videoTrack, audioTrack } = await deps.capture(quality);
      const plan = layers && layers.length > 1 ? layers : [quality];
      const simulcast = plan.length > 1;

      for (const [layer, preset] of plan.entries()) {
        let track = videoTrack;
        if (layer > 0) {
          // Chromium scales and drops frames on a clone for us, so each encoder receives
          // frames at its own size and rate from the one capture.
          track = videoTrack.clone();
          await track.applyConstraints({ height: { ideal: preset.height }, frameRate: { ideal: preset.framerate } });
          layerTracks.push(track);
        }
        // Per-layer sequence numbers: a viewer only ever receives one layer.
        let clock = 0;
        videos.push(
          await deps.startVideo(
            track,
            (chunk) => {
              if (videoPaused) return; // still in the encoder when the pause came
              clock += 1;
              deps.sendFrame(
                {
                  slot,
                  type: FrameType.Video,
                  timestamp: chunk.timestamp / MICROSECONDS_PER_MILLISECOND,
                  clock,
                  keyFrame: chunk.type === "key",
                  ...(simulcast ? { layer } : {}),
                },
                copyChunk(chunk),
              );
            },
            { quality: preset },
          ),
        );
      }

      if (audioTrack) {
        const timestampOffsetUs = (await deps.measureAudioRebaseUs?.(videoTrack, audioTrack)) ?? 0;
        audio = await deps.startAudio(
          audioTrack,
          (chunk) => {
            if (audioPaused) return;
            audioClock += 1;
            deps.sendFrame(
              { slot, type: FrameType.Audio, timestamp: chunk.timestamp / MICROSECONDS_PER_MILLISECOND, clock: audioClock },
              copyChunk(chunk),
            );
          },
          { timestampOffsetUs },
        );
      }

      videoTrack.addEventListener("ended", endOnItsOwn);

      deps.sendControl({
        kind: "start-presenting",
        presenterId: deps.presenterId,
        audio: audio?.params ?? null,
        ...(simulcast
          ? { layers: plan.map((preset, layer) => ({ layer, height: preset.height, framerate: preset.framerate })) }
          : {}),
      });
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
          // The relay names the layer a viewer is switching to; without one, refresh all.
          if (message.layer === undefined) for (const pipeline of videos) pipeline.requestKeyframe();
          else videos[message.layer]?.requestKeyframe();
          return true;
        case "request-stop-presenting":
          endOnItsOwn();
          return true;
        case "audience-changed":
          applyAudience(message.watchers, message.videoWatchers);
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
