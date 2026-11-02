import {
  FrameType,
  SLOT_PRESENTER,
  TARGET_AUDIO_BITRATE_KBPS_DEFAULT,
  type ControlMessage,
  type FrameHeader,
  type QualityPreset,
} from "@screenshare-bot/shared";
import type { CaptureStreams } from "../capture/screenCapture.js";
import type { startAudioEncodePipeline, AudioEncodePipeline } from "../capture/audioEncodePipeline.js";
import type { startVideoEncodePipeline, VideoEncodePipeline } from "../capture/videoEncodePipeline.js";
import {
  createBitrateController,
  createUplinkDelayWatch,
  createUplinkGate,
  UPLINK_PROBE_EVERY_MS,
  UPLINK_PROBE_FORGET_MS,
  uplinkHighWaterBytes,
  type UplinkGate,
} from "./uplinkGate.js";

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
  /** Bytes the socket still holds unsent (WebSocket.bufferedAmount); see uplinkGate.ts. */
  sendBufferedBytes?(): number;
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
   * The connection to the relay was lost and came back. The relay freed the broadcast
   * when the old socket closed, so it has to be announced again on the new one -- or
   * every frame from here on is ignored while this side still thinks it's live.
   */
  reannounce(): void;
  /**
   * Handles presenting-started, request-keyframe, request-stop-presenting,
   * audience-changed and layers-in-use (which pause what nobody receives); false
   * otherwise.
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

/** One simulcast version (index = layer, 0 = best). */
interface LayerState {
  pipeline: VideoEncodePipeline | null;
  gate: UplinkGate;
  /** Per-layer sequence number: a viewer only ever receives one layer. */
  clock: number;
  paused: boolean;
}

export function createPresenterSession(deps: PresenterSessionDeps): PresenterSession {
  let isPresenting = false;
  /** Assigned by the relay in presenting-started; SLOT_PRESENTER until then. */
  let slot = SLOT_PRESENTER;
  let audioClock = 0;
  let layers: LayerState[] = [];
  /** Downscaled clones feeding the lower layers; ours to stop. */
  let layerTracks: MediaStreamTrack[] = [];
  let audio: AudioEncodePipeline | null = null;
  /** The start-presenting sent at start, repeated by reannounce(). */
  let announcement: ControlMessage | null = null;
  /** From audience-changed: nobody wants the picture / nobody is watching at all. */
  let videoPaused = false;
  let audioPaused = false;
  /** From layers-in-use; null (everything runs) until the relay says. */
  let layersInUse: Set<number> | null = null;
  let bitrate = createBitrateController();
  /** uplink-probes awaiting their ack: id -> performance.now() when sent. */
  const probes = new Map<number, number>();
  let nextProbeId = 1;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  const uplinkDelay = createUplinkDelayWatch();
  const endedListeners: Array<() => void> = [];

  function sendProbe(): void {
    const now = performance.now();
    for (const [id, sentAt] of probes) if (now - sentAt > UPLINK_PROBE_FORGET_MS) probes.delete(id);
    probes.set(nextProbeId, now);
    deps.sendControl({ kind: "uplink-probe", id: nextProbeId });
    nextProbeId += 1;
  }

  /** A probe came back: a queue building on the upload costs bitrate before it costs the game's ping. */
  function onProbeAck(id: number): void {
    const sentAt = probes.get(id);
    if (sentAt === undefined) return;
    probes.delete(id);
    const now = performance.now();
    if (uplinkDelay.observe(sentAt, now)) applyBitrateScale(bitrate.onCongestion(now));
  }

  function stopProbing(): void {
    if (probeTimer !== null) clearInterval(probeTimer);
    probeTimer = null;
    probes.clear();
  }

  function stop(): void {
    if (!isPresenting) return;
    stopProbing();
    for (const layer of layers) layer.pipeline?.stop();
    layers = [];
    for (const track of layerTracks) track.stop();
    layerTracks = [];
    audio?.stop();
    audio = null;
    announcement = null;
    isPresenting = false;
    videoPaused = false;
    audioPaused = false;
    layersInUse = null;
    deps.sendControl({ kind: "stop-presenting" });
  }

  /**
   * Pauses each encoder nobody receives: all of them while no viewer wants the picture,
   * otherwise the simulcast layers left out of layers-in-use. Only touches an encoder
   * whose state actually changes -- resuming one forces a keyframe.
   */
  function applyPauses(): void {
    for (const [index, layer] of layers.entries()) {
      const pause = videoPaused || (layersInUse !== null && !layersInUse.has(index));
      if (pause === layer.paused) continue;
      layer.paused = pause;
      layer.pipeline?.setPaused(pause);
    }
  }

  /**
   * Follows the relay's count of who watches. The video encoders stop outright for an
   * audience that wants no picture; audio is only held back from the wire, since Opus
   * costs next to nothing to encode and its capture timeline expects every packet.
   */
  function applyAudience(watchers: number, videoWatchers: number): void {
    audioPaused = watchers === 0;
    videoPaused = videoWatchers === 0;
    applyPauses();
  }

  function applyBitrateScale(scale: number | null): void {
    if (scale === null) return;
    for (const layer of layers) layer.pipeline?.setBitrateScale(scale);
  }

  function sendVideo(layer: LayerState, index: number, simulcast: boolean, chunk: EncodedVideoChunk): void {
    if (layer.paused) return; // still in the encoder when the pause came

    const isKey = chunk.type === "key";
    const decision = layer.gate.admit(isKey, deps.sendBufferedBytes?.() ?? 0);
    const now = performance.now();
    if (decision === "congested") {
      applyBitrateScale(bitrate.onCongestion(now));
      return;
    }
    if (decision === "drop-and-request-keyframe") layer.pipeline?.requestKeyframe();
    if (decision !== "send") return;
    applyBitrateScale(bitrate.onHealthy(now));

    layer.clock += 1;
    deps.sendFrame(
      {
        slot,
        type: FrameType.Video,
        timestamp: chunk.timestamp / MICROSECONDS_PER_MILLISECOND,
        clock: layer.clock,
        keyFrame: isKey,
        ...(simulcast ? { layer: index } : {}),
      },
      copyChunk(chunk),
    );
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

    async start(quality, plannedLayers) {
      const { videoTrack, audioTrack } = await deps.capture(quality);
      const plan = plannedLayers && plannedLayers.length > 1 ? plannedLayers : [quality];
      const simulcast = plan.length > 1;
      const totalBitsPerSecond =
        plan.reduce((sum, preset) => sum + preset.bitrateKbps, 0) * 1000 + TARGET_AUDIO_BITRATE_KBPS_DEFAULT * 1000;
      const highWaterBytes = uplinkHighWaterBytes(totalBitsPerSecond);
      bitrate = createBitrateController();

      for (const [index, preset] of plan.entries()) {
        let track = videoTrack;
        if (index > 0) {
          // Chromium scales and drops frames on a clone for us, so each encoder receives
          // frames at its own size and rate from the one capture.
          track = videoTrack.clone();
          await track.applyConstraints({ height: { ideal: preset.height }, frameRate: { ideal: preset.framerate } });
          layerTracks.push(track);
        }
        const layer: LayerState = { pipeline: null, gate: createUplinkGate(highWaterBytes), clock: 0, paused: false };
        layers.push(layer);
        layer.pipeline = await deps.startVideo(track, (chunk) => sendVideo(layer, index, simulcast, chunk), {
          quality: preset,
        });
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

      announcement = {
        kind: "start-presenting",
        presenterId: deps.presenterId,
        audio: audio?.params ?? null,
        ...(simulcast
          ? { layers: plan.map((preset, layer) => ({ layer, height: preset.height, framerate: preset.framerate })) }
          : {}),
      };
      deps.sendControl(announcement);
      isPresenting = true;
      uplinkDelay.reset();
      probeTimer = setInterval(sendProbe, UPLINK_PROBE_EVERY_MS);
      return { hasAudio: audioTrack !== null };
    },

    stop,

    reannounce() {
      if (!isPresenting || !announcement) return;
      deps.sendControl(announcement);
      // A new socket: the old one's probes never come back, and its route may differ.
      probes.clear();
      uplinkDelay.reset();
      // Whoever is watching on the relay's side starts from scratch.
      for (const layer of layers) layer.pipeline?.requestKeyframe();
    },

    handleControl(message) {
      switch (message.kind) {
        case "presenting-started":
          slot = message.slot;
          return true;
        case "request-keyframe":
          // The relay names the layer a viewer is switching to; without one, refresh all.
          if (message.layer === undefined) for (const layer of layers) layer.pipeline?.requestKeyframe();
          else layers[message.layer]?.pipeline?.requestKeyframe();
          return true;
        case "request-stop-presenting":
          endOnItsOwn();
          return true;
        case "audience-changed":
          applyAudience(message.watchers, message.videoWatchers);
          return true;
        case "layers-in-use":
          layersInUse = new Set(message.layers);
          applyPauses();
          return true;
        case "uplink-probe-ack":
          onProbeAck(message.id);
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
