import { VOICE_CHANNELS, VOICE_SAMPLE_RATE } from "@screenshare-bot/shared";
import { createVoiceSchedule, type VoiceSchedule } from "./voiceSchedule.js";

/**
 * Plays everyone else in the room: one Opus decoder and jitter schedule per seat, all
 * mixed in a single AudioContext whose output device can be picked. Each seat has its
 * own analyser, which is what lights up their ring while they talk.
 */

/** A conversation wants to stay close to live; 80 ms absorbs ordinary network jitter. */
const JITTER_BUFFER_SECONDS = 0.08;

export interface VoicePlayback {
  push(slot: number, timestampUs: number, data: Uint8Array): void;
  /** Loudness of that seat right now, 0 to 1. */
  levelOf(slot: number): number;
  /** Drops seats no longer in the room. */
  keepOnly(slots: readonly number[]): void;
  setDeafened(deafened: boolean): void;
  setOutputDevice(deviceId: string | null): Promise<void>;
  stop(): void;
}

interface Voice {
  decoder: AudioDecoder;
  schedule: VoiceSchedule;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
}

type SinkableContext = AudioContext & { setSinkId?(sinkId: string): Promise<void> };

export function startVoicePlayback(): VoicePlayback {
  const context: SinkableContext = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE, latencyHint: "interactive" });
  const master = context.createGain();
  master.connect(context.destination);
  const voices = new Map<number, Voice>();

  function play(voice: Voice, data: AudioData): void {
    const buffer = context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
      const samples = new Float32Array(data.numberOfFrames);
      data.copyTo(samples, { planeIndex: channel, format: "f32-planar" });
      buffer.copyToChannel(samples, channel);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(voice.analyser);
    source.start(voice.schedule.startTime(data.timestamp, context.currentTime));
    data.close();
  }

  function voiceFor(slot: number): Voice {
    const existing = voices.get(slot);
    if (existing) return existing;
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(master);
    const voice: Voice = {
      schedule: createVoiceSchedule(JITTER_BUFFER_SECONDS),
      analyser,
      samples: new Float32Array(analyser.fftSize),
      decoder: new AudioDecoder({
        output: (data) => play(voice, data),
        error: (error) => console.error("Voice AudioDecoder error:", error),
      }),
    };
    voice.decoder.configure({ codec: "opus", sampleRate: VOICE_SAMPLE_RATE, numberOfChannels: VOICE_CHANNELS });
    voices.set(slot, voice);
    return voice;
  }

  function drop(slot: number): void {
    const voice = voices.get(slot);
    if (!voice) return;
    if (voice.decoder.state !== "closed") voice.decoder.close();
    voice.analyser.disconnect();
    voices.delete(slot);
  }

  return {
    push(slot, timestampUs, data) {
      if (context.state === "suspended") void context.resume();
      const voice = voiceFor(slot);
      if (voice.decoder.state !== "configured") return;
      voice.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: timestampUs, data }));
    },
    levelOf(slot) {
      const voice = voices.get(slot);
      if (!voice) return 0;
      voice.analyser.getFloatTimeDomainData(voice.samples);
      let sum = 0;
      for (const sample of voice.samples) sum += sample * sample;
      return Math.min(1, Math.sqrt(sum / voice.samples.length) * 4);
    },
    keepOnly(slots) {
      for (const slot of [...voices.keys()]) if (!slots.includes(slot)) drop(slot);
    },
    setDeafened(deafened) {
      master.gain.value = deafened ? 0 : 1;
    },
    async setOutputDevice(deviceId) {
      // "" is the system default for setSinkId.
      await context.setSinkId?.(deviceId && deviceId !== "default" ? deviceId : "");
    },
    stop() {
      for (const slot of [...voices.keys()]) drop(slot);
      context.close().catch(() => undefined);
    },
  };
}
