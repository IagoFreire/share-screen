/**
 * Puts real capture times back on encoded audio.
 *
 * Chromium's Opus AudioEncoder only honours the first input's timestamp: after that it
 * stamps each packet by counting samples, ignoring every later input timestamp. Any
 * correction in the capture clock -- the app-audio timeline re-anchoring, or the sound
 * card's clock drifting against the clock that stamps video -- is silently dropped, and
 * the audio on the wire stays offset from the video by the sum of those corrections
 * (54 ms after a single re-anchor, measured). Viewers lock video to the audio
 * timestamps, so that offset is exactly the lip-sync error they see.
 *
 * This remembers when each block handed to the encoder was captured, so every packet
 * coming out can be stamped with the capture time of its own first sample.
 */
export interface CaptureTimeline {
  /** `frames` samples captured starting at `timestampUs` went into the encoder. */
  record(timestampUs: number, frames: number): void;
  /** Capture time of the next packet's first sample, then moves past its `frames`; null before any input. */
  next(frames: number): number | null;
}

interface Block {
  start: number;
  timestampUs: number;
  frames: number;
}

export function createCaptureTimeline(sampleRate: number): CaptureTimeline {
  const blocks: Block[] = [];
  /** Samples recorded so far. */
  let recorded = 0;
  /** Samples already stamped onto packets. */
  let consumed = 0;

  return {
    record(timestampUs, frames) {
      blocks.push({ start: recorded, timestampUs, frames });
      recorded += frames;
    },
    next(frames) {
      // Forget blocks entirely behind the packet, keeping the last to extrapolate from.
      while (blocks.length > 1 && blocks[0]!.start + blocks[0]!.frames <= consumed) blocks.shift();
      const block = blocks[0];
      if (!block) return null;
      const timestampUs = block.timestampUs + ((consumed - block.start) * 1_000_000) / sampleRate;
      consumed += frames;
      return timestampUs;
    },
  };
}
