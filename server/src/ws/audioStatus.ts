import type { AppAudioState, AppAudioStatus } from "@screenshare-bot/shared";

const STATES: readonly AppAudioState[] = ["ok", "covered", "quiet", "muted", "silent", "failed"];
const MAX_APPS = 32;
const MAX_EXE_LENGTH = 100;

/**
 * A presenter's per-app capture status (presenter-audio-status), checked before the
 * relay holds or forwards it: only known states, bounded in size. Null when it isn't
 * a status at all.
 */
export function sanitizeAudioStatus(value: unknown): AppAudioStatus | null {
  const apps = (value as { apps?: unknown } | null)?.apps;
  if (!Array.isArray(apps)) return null;
  return {
    apps: apps
      .filter(
        (app): app is { exe: string; state: AppAudioState } =>
          typeof app?.exe === "string" && STATES.includes(app?.state as AppAudioState),
      )
      .slice(0, MAX_APPS)
      .map(({ exe, state }) => ({ exe: exe.slice(0, MAX_EXE_LENGTH), state })),
  };
}
