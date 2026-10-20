import type { DesktopUser } from "./protocol.js";

/**
 * The bridge the desktop app's preload exposes as `window.desktop` to desktop.html.
 * Lives in shared/ because both ends need it: the Electron preload implements it, the
 * page (served by the relay like any other client page) consumes it.
 */

/** A screen or window the user can broadcast, as the picker shows it. */
export interface DesktopSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
  iconDataUrl: string | null;
}

/** An app currently playing sound, for the "Áudio da live" list. */
export interface AudioApp {
  /** Executable name, e.g. "Discord.exe" -- what exclusions are keyed by. */
  exe: string;
  name: string;
  /** Current level, 0..1, for the meter. */
  peak: number;
}

/** Per-app audio: Windows process loopback through the bundled audio helper. */
export interface DesktopAppAudio {
  listApps(): Promise<AudioApp[]>;
  /** Starts the mix of every app except `exclude` (and the ScreenShare app itself). */
  start(exclude: string[]): Promise<void>;
  stop(): void;
  /** 10 ms blocks of 48 kHz stereo interleaved float32. Returns an unsubscribe function. */
  onBlock(listener: (pcm: Float32Array) => void): () => void;
  /** The helper died mid-live. */
  onEnded(listener: () => void): void;
}

/** What the app remembers between launches after "Entrar com Discord". */
export interface StoredLogin {
  session: string;
  user: DesktopUser;
}

export interface DesktopApi {
  getSources(): Promise<DesktopSource[]>;
  /** Applies to the NEXT getDisplayMedia() call only. `audio: false` makes a silent live. */
  selectSource(id: string, options?: { audio: boolean }): Promise<void>;
  /** Rejects with an Error whose message is ready to show (pt-BR). */
  login(): Promise<StoredLogin>;
  /** Gives up on a login still waiting for the browser; the pending login() rejects. */
  cancelLogin(): Promise<void>;
  getStoredLogin(): Promise<StoredLogin | null>;
  logout(): Promise<void>;
  /** Tells the tray whether a broadcast is live. */
  setLive(live: boolean): void;
  /** A Windows notification, for when the window is hidden or minimized. */
  notify(title: string, body: string): void;
  /** The tray's "Encerrar transmissão" was clicked. */
  onEndLiveRequested(listener: () => void): void;
  appAudio: DesktopAppAudio;
  windowControls: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
  };
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}
