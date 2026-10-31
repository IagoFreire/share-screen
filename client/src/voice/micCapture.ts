import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { VOICE_BITRATE_KBPS, VOICE_SAMPLE_RATE } from "@screenshare-bot/shared";

/**
 * The voice-room microphone: capture -> RNNoise (optional) -> Opus. RNNoise is the
 * open-source neural noise suppressor from Xiph/Mozilla, run as WebAssembly in an
 * AudioWorklet, so nothing leaves the PC to be cleaned. It needs a 48 kHz context.
 */

export interface MicOptions {
  /** Null for the system default. */
  deviceId: string | null;
  noiseSuppression: boolean;
  onPacket(chunk: EncodedAudioChunk): void;
}

export interface MicCapture {
  /** Whether RNNoise is actually running (it can fail to load and fall back). */
  readonly noiseSuppressed: boolean;
  setMuted(muted: boolean): void;
  /** Loudness right now, 0 to 1, after noise suppression. */
  level(): number;
  stop(): void;
}

/** Audio frames the track may hold while the page is busy (see audioEncodePipeline.ts). */
const TRACK_BUFFER_FRAMES = 100;

/** The RNNoise binary, fetched once for every room joined. */
let rnnoiseBinary: Promise<ArrayBuffer> | null = null;

async function openMicrophone(deviceId: string | null, noiseSuppression: boolean): Promise<MediaStream> {
  const constraints = (device: string | null): MediaStreamConstraints => ({
    audio: {
      ...(device ? { deviceId: { exact: device } } : {}),
      channelCount: 1,
      echoCancellation: true,
      autoGainControl: true,
      // With RNNoise on, Chromium's own suppression would only fight it.
      noiseSuppression: !noiseSuppression,
    },
  });
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(deviceId));
  } catch (error) {
    // The picked microphone was unplugged: the default one is better than silence.
    if (deviceId === null) throw error;
    return navigator.mediaDevices.getUserMedia(constraints(null));
  }
}

async function addRnnoise(context: AudioContext, source: AudioNode): Promise<RnnoiseWorkletNode | null> {
  try {
    rnnoiseBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
    await context.audioWorklet.addModule(rnnoiseWorkletUrl);
    const node = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: await rnnoiseBinary });
    source.connect(node);
    return node;
  } catch (error) {
    console.error("RNNoise unavailable; sending the microphone without it:", error);
    rnnoiseBinary = null;
    return null;
  }
}

export async function startMicCapture(options: MicOptions): Promise<MicCapture> {
  const stream = await openMicrophone(options.deviceId, options.noiseSuppression);
  const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE, latencyHint: "interactive" });
  const source = context.createMediaStreamSource(stream);
  const rnnoise = options.noiseSuppression ? await addRnnoise(context, source) : null;
  const cleaned: AudioNode = rnnoise ?? source;

  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  cleaned.connect(analyser);
  const destination = context.createMediaStreamDestination();
  destination.channelCount = 1;
  cleaned.connect(destination);

  let muted = false;
  let stopped = false;
  let configured = false;
  const encoder = new AudioEncoder({
    output: (chunk) => options.onPacket(chunk),
    error: (error) => console.error("Voice AudioEncoder error:", error),
  });
  const track = destination.stream.getAudioTracks()[0]!;
  const reader = new MediaStreamTrackProcessor<AudioData>({ track, maxBufferSize: TRACK_BUFFER_FRAMES }).readable.getReader();

  const pump = (async () => {
    while (!stopped) {
      const { done, value: data } = await reader.read();
      if (done || !data) break;
      if (muted) {
        data.close();
        continue;
      }
      if (!configured) {
        encoder.configure({
          codec: "opus",
          sampleRate: data.sampleRate,
          numberOfChannels: data.numberOfChannels,
          bitrate: VOICE_BITRATE_KBPS * 1000,
        });
        configured = true;
      }
      encoder.encode(data);
      data.close();
    }
  })();
  pump.catch((error) => console.error("Voice capture stopped unexpectedly:", error));

  const samples = new Float32Array(analyser.fftSize);
  return {
    noiseSuppressed: rnnoise !== null,
    setMuted(next) {
      muted = next;
    },
    level() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      reader.cancel().catch(() => undefined);
      if (encoder.state !== "closed") encoder.close();
      rnnoise?.destroy();
      for (const captured of stream.getTracks()) captured.stop();
      context.close().catch(() => undefined);
    },
  };
}
