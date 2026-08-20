/**
 * Shared playback clock that keeps video locked to audio.
 *
 * Audio and video arrive as two independent streams and each used to be presented
 * against its own clock: video against `performance.now()`, audio against
 * `AudioContext.currentTime`. Both clocks re-anchor themselves whenever their stream
 * hits trouble (audio underrun, video buffer overflow), and because neither knows about
 * the other, every one of those corrections silently shifts that stream's playout
 * position *relative to the other one* -- with nothing to ever pull them back together.
 * A few network hiccups and the two are visibly apart.
 *
 * The fix is the standard one: make audio the master. Ears notice a 20ms audio glitch
 * that eyes would never catch in video, so audio is scheduled first and video is
 * presented against wherever audio actually is. This object is the handoff between the
 * two pipelines -- the audio pipeline installs a source when it starts and removes it on
 * stop, so video automatically falls back to self-clocking when a broadcast has no audio
 * at all (a window shared without "share audio", or your own broadcast, whose audio is
 * deliberately never played back to you).
 */

/** Returns the stream timestamp (µs) currently audible, or null if audio isn't playing. */
export type MediaClockSource = () => number | null;

export interface MediaClock {
  /** Installed by the audio pipeline on start, cleared with `null` on stop. */
  setSource: (source: MediaClockSource | null) => void;
  /** Stream timestamp (µs) that should be on screen now, or null when audio isn't driving. */
  currentTimestampUs: () => number | null;
}

export function createMediaClock(): MediaClock {
  let source: MediaClockSource | null = null;

  return {
    setSource: (next) => {
      source = next;
    },
    currentTimestampUs: () => source?.() ?? null,
  };
}
