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

export interface AudioDecodePipeline {
  decodeChunk: (chunk: AudioChunkInput) => void;
  /** Number of times the jitter buffer ran dry (playback gaps). */
  readonly underruns: number;
  /** 0 (silent) to 1 (full volume). */
  setVolume: (volume: number) => void;
  stop: () => void;
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
 * Playback is scheduled through a small jitter buffer (see AUDIO_JITTER_BUFFER_SECONDS)
 * so packets arriving irregularly on a congested link still play back gaplessly.
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

  // Context time at which the packet after the last scheduled one should start, used
  // only to keep contiguous packets exactly flush (see AUDIO_CONTINUITY_TOLERANCE_SECONDS).
  let nextStartTime = 0;
  // Maps stream time onto AudioContext time: the packet stamped `anchorTimestampUs`
  // begins playing at `anchorContextTime`. Every packet is then placed by its own
  // timestamp relative to this anchor, rather than simply appended after its
  // predecessor. That distinction is what stops a dropped packet from pulling all
  // later audio permanently earlier -- appending makes the stream lose exactly that
  // packet's duration against video, every time, and the error accumulates for as long
  // as the session runs. It also gives video something to synchronise against.
  let anchorTimestampUs: number | null = null;
  let anchorContextTime = 0;
  // Counts how often playback ran dry. Exposed so the UI can tell a genuinely bad
  // connection apart from a one-off hiccup.
  let underruns = 0;

  const decoder = new AudioDecoder({
    output: (audioData) => {
      // Read before close() below: a closed AudioData reports 0 for most of its
      // attributes, and a zeroed timestamp here would silently anchor playback to the
      // wrong place instead of failing loudly.
      const timestampUs = audioData.timestamp;

      // Trust the decoded frame's own shape rather than the negotiated params: a
      // mismatch here throws inside copyTo and kills playback entirely.
      const frameChannels = audioData.numberOfChannels;
      const buffer = audioContext.createBuffer(
        frameChannels,
        audioData.numberOfFrames,
        audioData.sampleRate,
      );

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
      audioData.close();

      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(gainNode);

      // Jitter buffer: schedule playback a fixed lead ahead of the playback cursor
      // instead of "as soon as it arrives". Without the lead, any packet that arrives
      // even slightly late lands in the past and becomes an audible gap/click, which is
      // what makes audio break up on a jittery connection.
      const now = audioContext.currentTime;

      // Where this packet belongs according to its own capture timestamp.
      let startTime =
        anchorTimestampUs === null
          ? now + AUDIO_JITTER_BUFFER_SECONDS
          : anchorContextTime + (timestampUs - anchorTimestampUs) / 1_000_000;

      // Snap flush against the previous packet when the timestamp already agrees to
      // within rounding error, so ordinary contiguous playback stays sample-exact.
      if (nextStartTime > 0 && Math.abs(startTime - nextStartTime) < AUDIO_CONTINUITY_TOLERANCE_SECONDS) {
        startTime = nextStartTime;
      }

      if (startTime < now || startTime - now > AUDIO_MAX_DRIFT_SECONDS) {
        // Either the buffer ran dry (playback fell behind and this would land in the
        // past, i.e. never be heard) or a burst of backlog pushed it too far ahead --
        // either way, stop trying to catch up gradually and re-anchor to a fresh lead
        // over live. Video follows automatically, since it reads this same anchor.
        startTime = now + AUDIO_JITTER_BUFFER_SECONDS;
        anchorTimestampUs = timestampUs;
        anchorContextTime = startTime;
        underruns += 1;
      } else if (anchorTimestampUs === null) {
        anchorTimestampUs = timestampUs;
        anchorContextTime = startTime;
      }

      source.start(startTime);
      nextStartTime = startTime + buffer.duration;
    },
    error: (error) => console.error("AudioDecoder error:", error),
  });

  decoder.configure({ codec: "opus", sampleRate, numberOfChannels: channels });

  // Become the master clock for video playback (see mediaClock.ts).
  clock?.setSource(() => {
    if (anchorTimestampUs === null) return null;
    // A suspended context's currentTime is frozen. Reporting it would stall video on a
    // still frame until the user clicks to unlock audio, so hand playback back to
    // video's own clock until this context is actually running.
    if (audioContext.state !== "running") return null;

    // currentTime is where the context has *scheduled* to, which leads what the
    // speakers are actually emitting by the output buffer depth. Subtracting that
    // matters well beyond nitpicking: on Bluetooth headphones outputLatency routinely
    // runs 100-200ms, which is squarely in visible lip-sync territory.
    const audibleContextTime = audioContext.currentTime - (audioContext.outputLatency || 0);
    return anchorTimestampUs + (audibleContextTime - anchorContextTime) * 1_000_000;
  });

  return {
    decodeChunk: (chunk) => {
      if (decoder.state !== "configured") return;
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: chunk.timestampUs, data: chunk.data }));
    },
    get underruns() {
      return underruns;
    },
    setVolume: (volume) => {
      gainNode.gain.value = Math.min(1, Math.max(0, volume));
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
