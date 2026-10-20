import type { VoiceLocation } from "@screenshare-bot/shared";

/**
 * Keeps track of which voice channel the logged-in user is in, by asking the relay
 * (GET /api/desktop/voice) on an interval and whenever the window regains focus. The
 * bot has no live gateway feed, so polling is the only way to notice a channel switch.
 */

export type VoiceState =
  | { status: "unknown" }
  | { status: "in-channel"; location: VoiceLocation }
  | { status: "not-in-voice" };

/** How often the app re-checks the user's voice channel. */
export const VOICE_POLL_INTERVAL_MS = 15_000;

const HTTP_UNAUTHORIZED = 401;

export interface VoicePollerDeps {
  fetchVoice(): Promise<Response>;
  intervalMs: number;
  /** Called only when the state actually changes. */
  onChange(state: VoiceState): void;
  onSessionInvalid(): void;
}

export interface VoicePoller {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

export function createVoicePoller(deps: VoicePollerDeps): VoicePoller {
  let lastKey = JSON.stringify({ status: "unknown" });
  let timer: ReturnType<typeof setInterval> | null = null;

  function publish(state: VoiceState): void {
    const key = JSON.stringify(state);
    if (key === lastKey) return;
    lastKey = key;
    deps.onChange(state);
  }

  async function refresh(): Promise<void> {
    let response: Response;
    try {
      response = await deps.fetchVoice();
    } catch {
      return; // Network blip: keep showing the last known channel.
    }

    if (response.status === HTTP_UNAUTHORIZED) {
      deps.onSessionInvalid();
      return;
    }
    // A failed lookup (503) says nothing about where the user is -- see desktopRoutes.ts.
    if (!response.ok) return;

    try {
      const body = (await response.json()) as { location?: VoiceLocation | null };
      publish(body.location ? { status: "in-channel", location: body.location } : { status: "not-in-voice" });
    } catch {
      // Malformed body: same as a failed lookup.
    }
  }

  const onFocus = () => void refresh();

  return {
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), deps.intervalMs);
      window.addEventListener("focus", onFocus);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener("focus", onFocus);
    },
    refresh,
  };
}
