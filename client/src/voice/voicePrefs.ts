import { DEFAULT_SENSITIVITY_DB, LEVEL_FLOOR_DB } from "./voiceLevel.js";

/**
 * The voice settings that are numbers, remembered on this device: the microphone's
 * gain and sensitivity, and how loud each person in a room plays for this user.
 */

/** Volumes and the microphone's gain go from 0 to 200%; 1 is unchanged. */
export const MAX_VOLUME = 2;

const GAIN_KEY = "screenshare-bot:voice-input-gain";
const SENSITIVITY_KEY = "screenshare-bot:voice-sensitivity";
const USER_VOLUME_PREFIX = "screenshare-bot:voice-volume:";

export function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_VOLUME, Math.max(0, value)) : 1;
}

export function clampSensitivity(db: number): number {
  return Number.isFinite(db) ? Math.min(0, Math.max(LEVEL_FLOOR_DB, Math.round(db))) : DEFAULT_SENSITIVITY_DB;
}

function readNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

/** Null forgets the key, so defaults stay defaults. */
function writeNumber(key: string, value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // Not remembered: the default comes back next time.
  }
}

export function savedInputGain(): number {
  return clampVolume(readNumber(GAIN_KEY) ?? 1);
}

export function saveInputGain(gain: number): void {
  writeNumber(GAIN_KEY, clampVolume(gain));
}

export function savedSensitivity(): number {
  return clampSensitivity(readNumber(SENSITIVITY_KEY) ?? DEFAULT_SENSITIVITY_DB);
}

export function saveSensitivity(db: number): void {
  writeNumber(SENSITIVITY_KEY, clampSensitivity(db));
}

export function savedUserVolume(userId: string): number {
  return clampVolume(readNumber(USER_VOLUME_PREFIX + userId) ?? 1);
}

export function saveUserVolume(userId: string, volume: number): void {
  const clamped = clampVolume(volume);
  writeNumber(USER_VOLUME_PREFIX + userId, clamped === 1 ? null : clamped);
}
