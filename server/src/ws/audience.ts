/**
 * Who is actually receiving a broadcast. A presenter nobody watches stops encoding and
 * sending (see "audience-changed" in the protocol), so this is what decides whether a
 * live costs its presenter upload at all.
 */

/** What the relay knows about one viewer connection, as far as counting goes. */
export interface ViewerSelection {
  userId: string | null;
  /** The broadcast it receives; null when it chose to watch none. */
  selectedSlot: number | null;
  /** Paused because the same user watches from another tab, so it receives nothing. */
  isPaused: boolean;
  /** Audio-only: wants the sound but not the picture. */
  videoDisabled: boolean;
}

export interface Audience {
  /** Viewers receiving the broadcast at all. */
  watchers: number;
  /** Those of them that also want its video; the rest only listen. */
  videoWatchers: number;
}

/**
 * Counts the viewers of the broadcast on `slot`. The presenter's own preview is left
 * out: it would otherwise keep every broadcast running just so its presenter can watch
 * themselves, which is exactly the upload this exists to save.
 */
export function countAudience(viewers: Iterable<ViewerSelection>, slot: number, presenterId: string | null): Audience {
  let watchers = 0;
  let videoWatchers = 0;
  for (const viewer of viewers) {
    if (viewer.isPaused || viewer.selectedSlot !== slot) continue;
    if (presenterId !== null && viewer.userId === presenterId) continue;
    watchers += 1;
    if (!viewer.videoDisabled) videoWatchers += 1;
  }
  return { watchers, videoWatchers };
}
