import type { AudioParams } from "@screenshare-bot/shared";
import {
  AUDIO_CONTINUITY_TOLERANCE_SECONDS,
  AUDIO_JITTER_BUFFER_SECONDS,
  AUDIO_MAX_DRIFT_SECONDS,
} from "@screenshare-bot/shared";
import type { MediaClock } from "./mediaClock.js";

export interface AudioChunkInput {
  timestampUs: number;
  data: Uint8Array;
}

export interface AudioPlaybackStats {
  /** How far ahead of the speakers sound is scheduled, ms. */
  leadMs: number;
  /** Times the buffer ran dry (an audible gap). */
  underruns: number;
  /** Times a backlog had to be skipped to get back to live. */
  catchUps: number;
  /** Current playback rate; 1 except while gently steering the lead. */
  playbackRate: number;
}

export interface AudioDecodePipeline {
  decodeChunk: (chunk: AudioChunkInput) => void;
  /** Number of times the jitter buffer ran dry (playback gaps). */
  readonly underruns: number;
  stats: () => AudioPlaybackStats;
  /** 0 (silent) to MAX_VOLUME; 1 is the broadcast as sent. */
  setVolume: (volume: number) => void;
  /**
   * Silences everything scheduled and starts over on the next packet -- for a switch to
   * another broadcast, whose timestamps have nothing to do with this one's.
   */
  reset: () => void;
  stop: () => void;
}

/** Viewers may boost a quiet broadcast up to 200%, as with a voice user's volume. */
export const MAX_VOLUME = 2;

/**
 * The lead is steered with the playback rate instead of jumps: within this of the
 * target nothing changes; beyond it, the rate moves by RATE_GAIN per second of error, up
 * to MAX_RATE_DEVIATION (0.2% is ~3.5 cents of pitch, which nobody hears). That absorbs
 * the two sound cards' clocks drifting apart and slow lead creep, which used to end in
 * an underrun or a jump every so often.
 */
const RATE_DEADBAND_SECONDS = 0.03;
const RATE_GAIN = 0.02;
const MAX_RATE_DEVIATION = 0.002;
/** Scheduled packets are remembered this long after they end, for the video clock. */
const HISTORY_SECONDS = 1;

/** One packet handed to the AudioContext. */
interface Scheduled {
  source: AudioBufferSourceNode;
  /** Context time it starts and ends playing. */
  start: number;
  end: number;
  /** Stream time of its first sample. */
  timestampUs: number;
  /** Stream seconds per context second (its playbackRate). */
  rate: number;
}

/**
 * Decodes incoming Opus chunks and plays them back via Web Audio, routed through a
 * GainNode so the UI's volume slider/mute toggle can control playback level.
 *
 * `params` must be the presenter's real capture parameters (relayed over the control
 * channel), not assumed defaults: the encoder configures itself from the captured
 * track, so hardcoding 48kHz stereo silently breaks playback whenever the source is
 * mono -- which is the common case for Windows system/tab audio.
 *
 * Packets play back to back, sample-continuous, a jitter-buffer lead ahead of the
 * speakers (see AUDIO_JITTER_BUFFER_SECONDS); timestamps only decide where a real hole
 * goes (see AUDIO_CONTINUITY_TOLERANCE_SECONDS). Video is then shown against the
 * timestamp of the sound actually playing, read from what was scheduled -- so drift,
 * holes, rate steering and catch-ups all keep lip sync.
 */
export function startAudioDecodePipeline(params: AudioParams, clock?: MediaClock): AudioDecodePipeline {
  const { sampleRate, channels } = params;

  const audioContext = new AudioContext({ sampleRate });
  const gainNode = audioContext.createGain();
  gainNode.connect(audioContext.destination);

  // Browsers suspend new AudioContexts until a user gesture; the viewer's audio
  // pipeline starts automatically on "joined" with no click involved, so unlock
  // on the first interaction anywhere on the page instead of requiring a specific button.
  const resumeOnGesture = () => void audioContext.resume();
  document.addEventListener("pointerdown", resumeOnGesture, { once: true });
  document.addEventListener("keydown", resumeOnGesture, { once: true });

  /** What is scheduled (and what played within HISTORY_SECONDS), in start order. */
  let scheduled: Scheduled[] = [];
  /** Context time / stream time right after the last scheduled packet; null before any. */
  let nextStartTime: number | null = null;
  let nextTimestampUs = 0;
  let underruns = 0;
  let catchUps = 0;
  let playbackRate = 1;

  /** Stops everything from context time `cut` on, so a jump never plays over old sound. */
  function cutFrom(cut: number): void {
    scheduled = scheduled.flatMap((entry) => {
      if (entry.start >= cut) {
        entry.source.stop(); // before its start: it never plays
        return [];
      }
      if (entry.end <= cut) return [entry];
      entry.source.stop(cut);
      return [{ ...entry, end: cut }];
    });
  }

  function rateForLead(lead: number): number {
    const error = lead - AUDIO_JITTER_BUFFER_SECONDS;
    if (Math.abs(error) < RATE_DEADBAND_SECONDS) return 1;
    return 1 + Math.max(-MAX_RATE_DEVIATION, Math.min(MAX_RATE_DEVIATION, error * RATE_GAIN));
  }

  function toAudioBuffer(audioData: AudioData): AudioBuffer {
    // Trust the decoded frame's own shape rather than the negotiated params: a
    // mismatch here throws inside copyTo and kills playback entirely.
    const frameChannels = audioData.numberOfChannels;
    const buffer = audioContext.createBuffer(frameChannels, audioData.numberOfFrames, audioData.sampleRate);
    const isPlanar = audioData.format?.endsWith("-planar") ?? true;

    if (isPlanar) {
      for (let channel = 0; channel < frameChannels; channel += 1) {
        const channelData = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(channelData, { planeIndex: channel, format: "f32-planar" });
        buffer.copyToChannel(channelData, channel);
      }
    } else {
      // Interleaved: one plane holding frames * channels samples, de-interleaved here.
      const interleaved = new Float32Array(audioData.numberOfFrames * frameChannels);
      audioData.copyTo(interleaved, { planeIndex: 0, format: "f32" });
      for (let channel = 0; channel < frameChannels; channel += 1) {
        const channelData = new Float32Array(audioData.numberOfFrames);
        for (let i = 0; i < audioData.numberOfFrames; i += 1) {
          channelData[i] = interleaved[i * frameChannels + channel]!;
        }
        buffer.copyToChannel(channelData, channel);
      }
    }
    return buffer;
  }

  /** Where the next packet starts: flush after the last, or after a real hole. */
  function placementFor(timestampUs: number): number {
    if (nextStartTime === null) return audioContext.currentTime + AUDIO_JITTER_BUFFER_SECONDS;
    const missingSeconds = (timestampUs - nextTimestampUs) / 1_000_000;
    return missingSeconds >= AUDIO_CONTINUITY_TOLERANCE_SECONDS ? nextStartTime + missingSeconds : nextStartTime;
  }

  function play(audioData: AudioData): void {
    // Read before close() below: a closed AudioData reports 0 for most of its
    // attributes, and a zeroed timestamp here would silently misplace the packet.
    const timestampUs = audioData.timestamp;
    const buffer = toAudioBuffer(audioData);
    audioData.close();

    const now = audioContext.currentTime;
    scheduled = scheduled.filter((entry) => entry.end >= now - HISTORY_SECONDS);

    let start = placementFor(timestampUs);
    if (start < now) {
      // The buffer ran dry: this would land in the past and never be heard.
      start = now + AUDIO_JITTER_BUFFER_SECONDS;
      underruns += 1;
    } else if (start - now > AUDIO_MAX_DRIFT_SECONDS) {
      // A burst of backlog (a network hiccup delivered all at once) put the sound too far
      // behind live. Skip what is queued past the lead -- never overlap it -- and resume
      // live from here.
      start = now + AUDIO_JITTER_BUFFER_SECONDS;
      cutFrom(start);
      catchUps += 1;
    }

    playbackRate = rateForLead(start - now);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    source.connect(gainNode);
    source.start(start);

    const end = start + buffer.duration / playbackRate;
    scheduled.push({ source, start, end, timestampUs, rate: playbackRate });
    nextStartTime = end;
    nextTimestampUs = timestampUs + buffer.duration * 1_000_000;
  }

  function createDecoder(): AudioDecoder {
    const created = new AudioDecoder({
      output: play,
      // WebCodecs closes a decoder that fails; decodeChunk builds a new one.
      error: (error) => console.error("AudioDecoder error:", error),
    });
    created.configure({ codec: "opus", sampleRate, numberOfChannels: channels });
    return created;
  }
  let decoder = createDecoder();

  /**
   * Context time the speakers are emitting right now. getOutputTimestamp() pairs the
   * output position with a performance.now() moment, so it can be carried forward
   * smoothly; currentTime only moves once per audio callback (~10 ms steps on Windows),
   * which showed up as uneven frame pacing in video locked to it.
   */
  function audibleContextTime(): number {
    const now = audioContext.currentTime;
    const stamp = audioContext.getOutputTimestamp?.();
    if (stamp?.contextTime && stamp.performanceTime) {
      const audible = stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000;
      if (audible <= now && audible > now - 1) return audible;
    }
    // On Bluetooth headphones outputLatency routinely runs 100-200 ms, squarely in
    // visible lip-sync territory.
    return now - (audioContext.outputLatency || 0);
  }

  // Become the master clock for video playback (see mediaClock.ts).
  clock?.setSource(() => {
    const first = scheduled[0];
    if (!first) return null;
    // A suspended context's time is frozen. Reporting it would stall video on a still
    // frame until the user clicks to unlock audio, so hand playback back to video's own
    // clock until this context is actually running.
    if (audioContext.state !== "running") return null;

    const audible = audibleContextTime();
    for (let i = scheduled.length - 1; i >= 0; i -= 1) {
      const entry = scheduled[i]!;
      // Past an entry's end (a hole, an underrun) the clock keeps running from it.
      if (entry.start <= audible) return entry.timestampUs + (audible - entry.start) * entry.rate * 1_000_000;
    }
    // Still inside the jitter lead, before the first packet plays.
    return first.timestampUs - (first.start - audible) * 1_000_000;
  });

  return {
    decodeChunk: (chunk) => {
      if (decoder.state === "closed") decoder = createDecoder();
      try {
        decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: chunk.timestampUs, data: chunk.data }));
      } catch (error) {
        console.error("Audio decode failed:", error);
      }
    },
    get underruns() {
      return underruns;
    },
    stats: () => ({
      leadMs: nextStartTime === null ? 0 : Math.max(0, (nextStartTime - audioContext.currentTime) * 1000),
      underruns,
      catchUps,
      playbackRate,
    }),
    setVolume: (volume) => {
      gainNode.gain.value = Math.min(MAX_VOLUME, Math.max(0, volume));
    },
    reset: () => {
      for (const entry of scheduled) entry.source.stop();
      scheduled = [];
      nextStartTime = null;
      nextTimestampUs = 0;
    },
    stop: () => {
      clock?.setSource(null); // video self-clocks again from here
      document.removeEventListener("pointerdown", resumeOnGesture);
      document.removeEventListener("keydown", resumeOnGesture);
      if (decoder.state !== "closed") decoder.close();
      audioContext.close().catch(() => undefined);
    },
  };
}
