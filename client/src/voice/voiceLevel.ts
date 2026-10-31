/**
 * One loudness scale for the voice UI and the microphone's gate: decibels from
 * LEVEL_FLOOR_DB (silence, 0) up to full scale (1), like Discord's input sensitivity
 * bar. A straight RMS scale would cram all of speech into its bottom tenth.
 */

export const LEVEL_FLOOR_DB = -80;

/** Quieter than this isn't sent, until the user moves the sensitivity mark. */
export const DEFAULT_SENSITIVITY_DB = -50;

/** Keeps sending this long after the voice drops below the mark, so word endings and short pauses aren't clipped. */
export const GATE_HOLD_MS = 400;

export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/** -Infinity for silence. */
export function dbOfRms(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export function levelOfDb(db: number): number {
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
}

/**
 * A seat counts as talking above this, for the speaking rings. Each sender's gate
 * already keeps their silence off the wire, so anything audible means they're talking.
 */
export const SPEAKING_LEVEL = levelOfDb(-70);

export interface VoiceGate {
  /** Whether audio this loud, at this moment, goes out. */
  pass(db: number, thresholdDb: number, nowMs: number): boolean;
}

export function createVoiceGate(holdMs = GATE_HOLD_MS): VoiceGate {
  let openUntil = -Infinity;
  return {
    pass(db, thresholdDb, nowMs) {
      if (db >= thresholdDb) openUntil = nowMs + holdMs;
      return nowMs <= openUntil;
    },
  };
}
