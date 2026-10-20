import type { AudioParams } from "@screenshare-bot/shared";
import { TARGET_AUDIO_BITRATE_KBPS_DEFAULT } from "@screenshare-bot/shared";
import { createCaptureTimeline } from "./captureTimeline.js";

export type EncodedAudioHandler = (chunk: EncodedAudioChunk) => void;

export interface AudioEncodePipeline {
  /** The parameters actually negotiated with the capture track, relayed to viewers
   *  so their decoder is configured identically. */
  params: AudioParams;
  stop: () => void;
}

/**
 * Encodes the presenter's tab/system audio track as Opus via WebCodecs. Kept as a
 * plain track-processor pump (no jitter handling needed on the encode side).
 */
export interface AudioEncodeOptions {
  /** Added to every timestamp to put the audio on the video's clock (see clockOffset.ts). */
  timestampOffsetUs?: number;
}

export async function startAudioEncodePipeline(
  track: MediaStreamTrack,
  onChunk: EncodedAudioHandler,
  options: AudioEncodeOptions = {},
): Promise<AudioEncodePipeline> {
  const settings = track.getSettings();
  // Mirror the track exactly. Forcing stereo on a mono source (typical for Windows
  // system audio) makes the encoder and the viewer's decoder disagree, which
  // manifests as silence rather than an error.
  const params: AudioParams = {
    sampleRate: settings.sampleRate ?? 48000,
    channels: settings.channelCount ?? 2,
  };
  const encoderConfig: AudioEncoderConfig = {
    codec: "opus",
    sampleRate: params.sampleRate,
    numberOfChannels: params.channels,
    bitrate: TARGET_AUDIO_BITRATE_KBPS_DEFAULT * 1000,
    opus: {
      // Max encoder effort. For audio this costs very little CPU (unlike video) and
      // buys real quality at a given bitrate.
      complexity: 10,
      // DTX stops transmitting during silence. It saves bandwidth on speech but chops
      // quiet passages of music and adds artifacts on re-entry, so it stays off.
      usedtx: false,
      // Deliberately NOT enabling useinbandfec: forward error correction spends bitrate
      // on redundancy to survive lost packets, and this stream runs over a WebSocket
      // (TCP), where packets are retransmitted rather than lost. It would cost quality
      // for no benefit here.
    },
  };

  const support = await AudioEncoder.isConfigSupported(encoderConfig);
  if (!support.supported) {
    throw new Error(`AudioEncoder config not supported by this browser: ${JSON.stringify(encoderConfig)}`);
  }

  // The encoder stamps packets by counting samples; put the real capture times back.
  const timeline = createCaptureTimeline(params.sampleRate, options.timestampOffsetUs ?? 0);
  function restamp(chunk: EncodedAudioChunk): EncodedAudioChunk {
    const frames = Math.round(((chunk.duration ?? 0) * params.sampleRate) / 1_000_000);
    const timestamp = frames > 0 ? timeline.next(frames) : null;
    if (timestamp === null) return chunk;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    return new EncodedAudioChunk({
      type: chunk.type,
      timestamp: Math.round(timestamp),
      duration: chunk.duration ?? undefined,
      data,
    });
  }

  const encoder = new AudioEncoder({
    output: (chunk) => onChunk(restamp(chunk)),
    error: (error) => console.error("AudioEncoder error:", error),
  });
  encoder.configure(encoderConfig);

  const processor = new MediaStreamTrackProcessor<AudioData>({ track });
  const reader = processor.readable.getReader();

  let stopped = false;
  const pump = (async () => {
    while (!stopped) {
      const { done, value: data } = await reader.read();
      if (done || !data) break;
      timeline.record(data.timestamp, Math.round((data.numberOfFrames * params.sampleRate) / data.sampleRate));
      encoder.encode(data);
      data.close();
    }
  })();
  pump.catch((error) => console.error("Audio encode pump stopped unexpectedly:", error));

  return {
    params,
    stop: () => {
      stopped = true;
      reader.cancel().catch(() => undefined);
      if (encoder.state !== "closed") encoder.close();
    },
  };
}
