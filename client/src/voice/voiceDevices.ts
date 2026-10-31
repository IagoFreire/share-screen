/**
 * Microphones and speakers for voice rooms, and which ones the user picked. Picks are
 * remembered on this device; when the picked one is unplugged, the system default
 * takes over until it comes back.
 */

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export type DeviceKind = "input" | "output";

const STORAGE_KEYS: Record<DeviceKind, string> = {
  input: "screenshare-bot:voice-input",
  output: "screenshare-bot:voice-output",
};

/** The picked device while it's plugged in, else the default entry, else the first; null with none. */
export function chooseDevice(devices: readonly AudioDevice[], savedId: string | null): string | null {
  if (savedId && devices.some((device) => device.deviceId === savedId)) return savedId;
  return devices.find((device) => device.deviceId === "default")?.deviceId ?? devices[0]?.deviceId ?? null;
}

export function savedDevice(kind: DeviceKind): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS[kind]);
  } catch {
    return null;
  }
}

export function saveDevice(kind: DeviceKind, deviceId: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS[kind], deviceId);
  } catch {
    // Not remembered: the default is used next time.
  }
}

/** Both lists; labels are only filled once the microphone has been allowed. */
export async function listAudioDevices(): Promise<Record<DeviceKind, AudioDevice[]>> {
  const all = await navigator.mediaDevices.enumerateDevices();
  const pick = (kind: MediaDeviceKind, fallback: string) =>
    all
      .filter((device) => device.kind === kind)
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `${fallback} ${index + 1}` }));
  return { input: pick("audioinput", "Microfone"), output: pick("audiooutput", "Saída") };
}

const NOISE_KEY = "screenshare-bot:voice-rnnoise";

/** RNNoise noise suppression; on unless the user switched it off. */
export function savedNoiseSuppression(): boolean {
  try {
    return localStorage.getItem(NOISE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveNoiseSuppression(on: boolean): void {
  try {
    localStorage.setItem(NOISE_KEY, on ? "on" : "off");
  } catch {
    // Not remembered.
  }
}
