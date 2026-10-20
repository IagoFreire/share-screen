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

/** What the app remembers between launches after "Entrar com Discord". */
export interface StoredLogin {
  session: string;
  user: DesktopUser;
}

export interface DesktopApi {
  getSources(): Promise<DesktopSource[]>;
  /** Applies to the NEXT getDisplayMedia() call only. */
  selectSource(id: string): Promise<void>;
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
