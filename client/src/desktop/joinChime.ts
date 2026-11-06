import type { LiveAudience } from "./broadcast.js";

/**
 * The sound a presenter hears when someone starts watching their live, as in Discord.
 * It follows the audience the relay reports (audience-changed's shown counts), so a
 * hidden admin never sets it off, and neither does opening your own preview.
 */

/** A burst of people opening the live at once (or someone flicking between lives) chimes once. */
export const JOIN_CHIME_MIN_INTERVAL_MS = 1500;

export interface JoinChimeDeps {
  now(): number;
  play(): void;
}

export interface JoinChime {
  /** Feed every audience report in order; chimes when the number of watchers went up. */
  onAudience(next: LiveAudience): void;
  /** A new live starts counting from nobody. */
  reset(): void;
}

export function createJoinChime(deps: JoinChimeDeps): JoinChime {
  let watchers = 0;
  let lastPlayed = Number.NEGATIVE_INFINITY;

  return {
    onAudience(next) {
      const joined = next.watchers > watchers;
      watchers = next.watchers;
      if (!joined) return;
      const now = deps.now();
      if (now - lastPlayed < JOIN_CHIME_MIN_INTERVAL_MS) return;
      lastPlayed = now;
      deps.play();
    },
    reset() {
      watchers = 0;
    },
  };
}

/** Two quick rising notes; quiet, so it never covers what the live itself sounds like. */
const NOTES_HZ = [660, 990];
const NOTE_SECONDS = 0.11;
const PEAK_GAIN = 0.12;
const ATTACK_SECONDS = 0.015;
const SILENT_GAIN = 0.0001;

let context: AudioContext | null = null;

/** Plays the chime on the default output; synthesized, so there is no file to load. */
export function playJoinChime(): void {
  try {
    const ctx = (context ??= new AudioContext());
    void ctx.resume();
    const start = ctx.currentTime + 0.01;
    NOTES_HZ.forEach((frequency, index) => {
      const at = start + index * NOTE_SECONDS;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + ATTACK_SECONDS);
      gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, at + NOTE_SECONDS * 1.8);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + NOTE_SECONDS * 2);
    });
  } catch (error) {
    console.error("Failed to play the join chime:", error);
  }
}
