import { VOICE_BITRATE_KBPS } from "@screenshare-bot/shared";
import { openMicInput, type MicInputOptions } from "./micInput.js";
import { createVoiceGate, dbOfRms, levelOfDb, rmsOf } from "./voiceLevel.js";

/**
 * The voice-room microphone: micInput.ts's cleaned, gained microphone -> the
 * sensitivity gate -> Opus. Below the user's sensitivity nothing is encoded or sent,
 * like Discord's voice activity; muting does the same.
 */

export interface MicOptions extends MicInputOptions {
  sensitivityDb: number;
  onPacket(chunk: EncodedAudioChunk): void;
}

export interface MicCapture {
  /** Whether RNNoise is actually running (it can fail to load and fall back). */
  readonly noiseSuppressed: boolean;
  setMuted(muted: boolean): void;
  setGain(gain: number): void;
  setSensitivity(db: number): void;
  /** Loudness 0-1 on voiceLevel.ts's scale, sent or not: the sensitivity meter. */
  inputLevel(): number;
  /** Whether the voice is going out right now: unmuted and above the sensitivity. */
  transmitting(): boolean;
  stop(): void;
}

/** Audio frames the track may hold while the page is busy (see audioEncodePipeline.ts). */
const TRACK_BUFFER_FRAMES = 100;

export async function startMicCapture(options: MicOptions): Promise<MicCapture> {
  const input = await openMicInput(options);
  const destination = input.context.createMediaStreamDestination();
  destination.channelCount = 1;
  input.output.connect(destination);

  let muted = false;
  let stopped = false;
  let configured = false;
  let sending = false;
  let sensitivityDb = options.sensitivityDb;
  const gate = createVoiceGate();
  const encoder = new AudioEncoder({
    output: (chunk) => options.onPacket(chunk),
    error: (error) => console.error("Voice AudioEncoder error:", error),
  });
  const track = destination.stream.getAudioTracks()[0]!;
  const reader = new MediaStreamTrackProcessor<AudioData>({ track, maxBufferSize: TRACK_BUFFER_FRAMES }).readable.getReader();

  const pump = (async () => {
    let samples = new Float32Array(0);
    while (!stopped) {
      const { done, value: data } = await reader.read();
      if (done || !data) break;
      // The gate judges the very audio it lets through, timed by the audio's own clock.
      if (samples.length !== data.numberOfFrames) samples = new Float32Array(data.numberOfFrames);
      data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
      const open = gate.pass(dbOfRms(rmsOf(samples)), sensitivityDb, data.timestamp / 1000);
      sending = open && !muted;
      if (!sending) {
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

  return {
    noiseSuppressed: input.noiseSuppressed,
    setMuted(next) {
      muted = next;
      if (muted) sending = false;
    },
    setGain: (gain) => input.setGain(gain),
    setSensitivity(db) {
      sensitivityDb = db;
    },
    inputLevel: () => levelOfDb(input.db()),
    transmitting: () => sending,
    stop() {
      if (stopped) return;
      stopped = true;
      reader.cancel().catch(() => undefined);
      if (encoder.state !== "closed") encoder.close();
      input.close();
    },
  };
}
