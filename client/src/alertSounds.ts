import type { AlertSound } from "@screenshare-bot/shared";

/**
 * What a presenter hears when someone uses the alert button (play-alert): the door
 * knock, or Windows' "device connected" / "device disconnected" sounds. Inside the Janja
 * app the device sounds are the presenter's own Windows files (read by the main process),
 * so they sound exactly like a real USB plug -- and nothing of Microsoft's is shipped.
 * Elsewhere (present.html in a browser), or without those files, a two-note imitation
 * is synthesized instead.
 */

type DeviceSound = Exclude<AlertSound, "knock">;

export interface AlertPlayerDeps {
  knockUrl: string;
  /** The Windows file's bytes; absent outside the app, null when the file isn't there. */
  loadSystemSound?: (sound: DeviceSound) => Promise<Uint8Array | null>;
  playUrl(url: string): void;
  toUrl(bytes: Uint8Array): string;
  synthesize(sound: DeviceSound): void;
}

export function createAlertPlayer(deps: AlertPlayerDeps): (sound: AlertSound) => void {
  /** Per device sound: its file's URL, or null once known to be unavailable. */
  const loaded = new Map<DeviceSound, Promise<string | null>>();

  function deviceUrl(sound: DeviceSound): Promise<string | null> {
    let pending = loaded.get(sound);
    if (!pending) {
      const load = deps.loadSystemSound;
      pending = load
        ? load(sound)
            .then((bytes) => (bytes && bytes.length > 0 ? deps.toUrl(bytes) : null))
            .catch((error: unknown) => {
              console.error("Failed to load the Windows device sound:", error);
              return null;
            })
        : Promise.resolve(null);
      loaded.set(sound, pending);
    }
    return pending;
  }

  return (sound) => {
    if (sound === "knock") {
      deps.playUrl(deps.knockUrl);
      return;
    }
    void deviceUrl(sound).then((url) => (url ? deps.playUrl(url) : deps.synthesize(sound)));
  };
}

const NOTE_SECONDS = 0.09;
const PEAK_GAIN = 0.25;
const SILENT_GAIN = 0.0001;

/** Two quick notes: up for a device plugged in, down for one pulled out, like Windows. */
export function usbNotes(sound: DeviceSound): Array<{ hz: number; at: number }> {
  const [low, high] = [587.33, 880];
  const [first, second] = sound === "usb-in" ? [low, high] : [high, low];
  return [
    { hz: first, at: 0 },
    { hz: second, at: NOTE_SECONDS },
  ];
}

let context: AudioContext | null = null;

function synthesizeUsb(sound: DeviceSound): void {
  try {
    const ctx = (context ??= new AudioContext());
    void ctx.resume();
    const start = ctx.currentTime + 0.01;
    for (const note of usbNotes(sound)) {
      const at = start + note.at;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = note.hz;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, at + NOTE_SECONDS * 2.5);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + NOTE_SECONDS * 3);
    }
  } catch (error) {
    console.error("Failed to play the device sound:", error);
  }
}

/** The real thing for a page: one <audio> per URL, rewound for each alert. */
export function browserAlertPlayer(
  knockUrl: string,
  loadSystemSound?: AlertPlayerDeps["loadSystemSound"],
): (sound: AlertSound) => void {
  const elements = new Map<string, HTMLAudioElement>();
  return createAlertPlayer({
    knockUrl,
    loadSystemSound,
    playUrl(url) {
      let audio = elements.get(url);
      if (!audio) {
        audio = new Audio(url);
        elements.set(url, audio);
      }
      audio.currentTime = 0;
      audio.play().catch((error: unknown) => console.error("Failed to play alert sound:", error));
    },
    toUrl: (bytes) => URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "audio/wav" })),
    synthesize: synthesizeUsb,
  });
}
