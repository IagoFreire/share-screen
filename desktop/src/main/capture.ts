import type { DesktopSource } from "@screenshare-bot/shared";

/**
 * Capture-source picking. Chromium's own getDisplayMedia() picker is bypassed: the app
 * shows its own Discord-style picker (desktop.html), the page hands the chosen id here,
 * and the display-media request handler grants exactly that source on the page's next
 * getDisplayMedia() call. The existing capture code (screenCapture.ts) runs unchanged.
 */

/** The parts of Electron's DesktopCapturerSource this module reads (kept structural for tests). */
export interface CapturerSourceLike {
  id: string;
  name: string;
  thumbnail: { toDataURL(): string };
  appIcon: { toDataURL(): string; isEmpty(): boolean } | null;
}

/** Picker thumbnails; small enough to send a whole screen's worth over IPC quickly. */
export const THUMBNAIL_SIZE = { width: 320, height: 180 };

const SOURCE_ID_PATTERN = /^(screen|window):[\w:-]+$/;

export function isSourceId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_ID_PATTERN.test(value);
}

export function toDesktopSource(source: CapturerSourceLike): DesktopSource {
  const icon = source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null;
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith("screen:") ? "screen" : "window",
    thumbnailDataUrl: source.thumbnail.toDataURL(),
    iconDataUrl: icon,
  };
}

/** What the transmit modal picked: which source, and whether the live carries sound. */
export interface SourcePick {
  id: string;
  audio: boolean;
}

/**
 * The source the page picked, consumed by the next display-media request. One use only:
 * a stale pick must never silently grant a later, unrelated getDisplayMedia() call.
 */
export function createSourceSelection(): { set(pick: SourcePick): void; take(): SourcePick | null } {
  let selected: SourcePick | null = null;
  return {
    set(pick) {
      selected = pick;
    },
    take() {
      const pick = selected;
      selected = null;
      return pick;
    },
  };
}

/**
 * What to grant a display-media request: the picked source -- with system audio unless
 * the user chose a silent live -- or null to deny. Plan 2 replaces "loopback" (the whole
 * system mix) with per-app audio.
 */
export function pickDisplayMedia<S extends { id: string }>(
  pick: SourcePick | null,
  sources: S[],
): { video: S; audio?: "loopback" } | null {
  if (!pick) return null;
  const video = sources.find((source) => source.id === pick.id);
  if (!video) return null;
  return pick.audio ? { video, audio: "loopback" } : { video };
}
