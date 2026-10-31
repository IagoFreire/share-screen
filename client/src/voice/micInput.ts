import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { VOICE_SAMPLE_RATE } from "@screenshare-bot/shared";
import { dbOfRms, rmsOf } from "./voiceLevel.js";

/**
 * The microphone as others will hear it: the picked device, then RNNoise (optional),
 * then the user's gain. RNNoise is the open-source neural noise suppressor from
 * Xiph/Mozilla, run as WebAssembly in an AudioWorklet, so nothing leaves the PC to be
 * cleaned; it needs a 48 kHz context. Shared by the room's capture and the mic test.
 */

export interface MicInputOptions {
  /** Null for the system default. */
  deviceId: string | null;
  noiseSuppression: boolean;
  /** 0 to 2; 1 leaves the microphone as it is. */
  gain: number;
}

export interface MicInput {
  readonly context: AudioContext;
  /** The cleaned microphone at the user's gain: connect what consumes it here. */
  readonly output: AudioNode;
  /** Whether RNNoise is actually running (it can fail to load and fall back). */
  readonly noiseSuppressed: boolean;
  setGain(gain: number): void;
  /** Loudness right now, in dB; -Infinity for silence. */
  db(): number;
  close(): void;
}

/** Smooths gain changes so dragging the slider doesn't click. */
const GAIN_RAMP_SECONDS = 0.02;

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

export async function openMicInput(options: MicInputOptions): Promise<MicInput> {
  const stream = await openMicrophone(options.deviceId, options.noiseSuppression);
  const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE, latencyHint: "interactive" });
  const close = () => {
    for (const track of stream.getTracks()) track.stop();
    context.close().catch(() => undefined);
  };

  try {
    const source = context.createMediaStreamSource(stream);
    // Microphones often arrive as two channels, and RNNoise cleans only the first while
    // passing a silent second one on: the test played in the left ear only, and the room
    // heard the mixdown 6 dB down. One channel from here on; outputs play it in both ears.
    const mono = context.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = "explicit";
    mono.channelInterpretation = "speakers";
    source.connect(mono);
    const rnnoise = options.noiseSuppression ? await addRnnoise(context, mono) : null;
    const gain = context.createGain();
    gain.gain.value = options.gain;
    (rnnoise ?? mono).connect(gain);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    gain.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    return {
      context,
      output: gain,
      noiseSuppressed: rnnoise !== null,
      setGain(value) {
        gain.gain.setTargetAtTime(value, context.currentTime, GAIN_RAMP_SECONDS);
      },
      db() {
        analyser.getFloatTimeDomainData(samples);
        return dbOfRms(rmsOf(samples));
      },
      close() {
        rnnoise?.destroy();
        close();
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
