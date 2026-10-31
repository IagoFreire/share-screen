import type { UpdateStatus } from "@screenshare-bot/shared";

/**
 * The app's update state, followed from electron-updater's events -- the startup check
 * and the ones the page asks for alike -- so the title bar's update button always shows
 * where things stand. A found update downloads by itself (autoDownload), so "available"
 * goes straight to downloading.
 */

export interface UpdateTracker {
  status(): UpdateStatus;
  /** Checking or downloading: another check now would only start over. */
  isBusy(): boolean;
  checking(): void;
  available(version: string): void;
  progress(percent: number): void;
  downloaded(version: string): void;
  notAvailable(): void;
  failed(): void;
}

const CHECK_FAILED = "Não deu para procurar atualizações. Confira sua internet e tente de novo.";

export function createUpdateTracker(onChange: (status: UpdateStatus) => void): UpdateTracker {
  let current: UpdateStatus = { state: "idle" };

  function set(next: UpdateStatus): void {
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    onChange(next);
  }

  /** A downloaded update stays ready to install whatever a later check says. */
  const isReady = () => current.state === "ready";

  return {
    status: () => current,
    isBusy: () => current.state === "checking" || current.state === "downloading",
    checking() {
      if (!isReady() && current.state !== "downloading") set({ state: "checking" });
    },
    available(version) {
      if (!isReady()) set({ state: "downloading", version, percent: 0 });
    },
    progress(percent) {
      if (current.state !== "downloading") return;
      set({ ...current, percent: Math.max(0, Math.min(100, Math.round(percent))) });
    },
    downloaded(version) {
      set({ state: "ready", version });
    },
    notAvailable() {
      if (!isReady()) set({ state: "up-to-date" });
    },
    failed() {
      if (!isReady()) set({ state: "error", message: CHECK_FAILED });
    },
  };
}
