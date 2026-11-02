/**
 * An admin's "assistir oculto" (see set-hidden in the protocol), remembered on this
 * device so it holds across reconnects, room hops and restarts. Only the choice is kept
 * here; whether it counts is the server's call, which ignores it for anyone not an admin.
 */

type HiddenStorage = Pick<Storage, "getItem" | "setItem">;

const KEY = "screenshare-bot:watch-hidden";

export interface HiddenWatch {
  isHidden(): boolean;
  setHidden(hidden: boolean): void;
}

/** Without usable storage (blocked, private window) the choice lasts until the page closes. */
export function createHiddenWatch(storage: HiddenStorage | null): HiddenWatch {
  let hidden = false;
  try {
    hidden = storage?.getItem(KEY) === "1";
  } catch {
    // Starts seen; the admin can hide again.
  }
  return {
    isHidden: () => hidden,
    setHidden(next) {
      hidden = next;
      try {
        storage?.setItem(KEY, next ? "1" : "0");
      } catch {
        // Kept for this page only.
      }
    },
  };
}

/** The page's own storage; in the desktop app it outlives restarts (see desktop/main.ts). */
export function browserHiddenWatch(): HiddenWatch {
  try {
    return createHiddenWatch(window.localStorage);
  } catch {
    return createHiddenWatch(null);
  }
}
