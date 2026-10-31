import { VOICE_CHANNELS, VOICE_SAMPLE_RATE } from "@screenshare-bot/shared";
import { routeToOutput } from "./audioOutput.js";
import { dbOfRms, levelOfDb, rmsOf } from "./voiceLevel.js";
import { createVoiceSchedule, type VoiceSchedule } from "./voiceSchedule.js";

/**
 * Plays everyone else in the room: one Opus decoder and jitter schedule per seat, all
 * mixed in a single AudioContext whose output device can be picked. Each seat has its
 * own analyser, which lights up their ring while they talk, and its own volume (up to
 * 200%), which the analyser doesn't see: the ring shows how they talk, not how loud
 * this user turned them.
 */

/** A conversation wants to stay close to live; 80 ms absorbs ordinary network jitter. */
const JITTER_BUFFER_SECONDS = 0.08;

export interface VoicePlayback {
  push(slot: number, timestampUs: number, data: Uint8Array): void;
  /** Loudness of that seat right now, 0 to 1 on voiceLevel.ts's scale. */
  levelOf(slot: number): number;
  /** 0 to 2; kept for the seat even before its first packet. */
  setVolume(slot: number, volume: number): void;
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
  volume: GainNode;
  samples: Float32Array<ArrayBuffer>;
}

export function startVoicePlayback(): VoicePlayback {
  const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE, latencyHint: "interactive" });
  const master = context.createGain();
  // Several voices turned up to 200% would clip; this only touches peaks near full scale.
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  master.connect(limiter).connect(context.destination);
  const voices = new Map<number, Voice>();
  const volumes = new Map<number, number>();

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
    const volume = context.createGain();
    volume.gain.value = volumes.get(slot) ?? 1;
    analyser.connect(volume).connect(master);
    const voice: Voice = {
      schedule: createVoiceSchedule(JITTER_BUFFER_SECONDS),
      analyser,
      volume,
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
    volumes.delete(slot);
    const voice = voices.get(slot);
    if (!voice) return;
    if (voice.decoder.state !== "closed") voice.decoder.close();
    voice.volume.disconnect();
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
      return levelOfDb(dbOfRms(rmsOf(voice.samples)));
    },
    setVolume(slot, volume) {
      volumes.set(slot, volume);
      voices.get(slot)?.volume.gain.setTargetAtTime(volume, context.currentTime, 0.02);
    },
    keepOnly(slots) {
      for (const slot of new Set([...voices.keys(), ...volumes.keys()])) if (!slots.includes(slot)) drop(slot);
    },
    setDeafened(deafened) {
      master.gain.value = deafened ? 0 : 1;
    },
    setOutputDevice: (deviceId) => routeToOutput(context, deviceId),
    stop() {
      for (const slot of [...voices.keys()]) drop(slot);
      context.close().catch(() => undefined);
    },
  };
}
