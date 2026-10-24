import type { AudioQualityKey, QualityPreset } from "@screenshare-bot/shared";
import type { VoiceState } from "./voicePoller.js";

/**
 * The desktop app's "am I live?" state: starts and ends the broadcast, keeps the tray
 * in step, and -- since the app can't stop you leaving the voice channel in Discord --
 * asks once whether to end the broadcast when you do, instead of ending it behind your
 * back or leaving it running unnoticed.
 */

/** A running broadcast (connection + capture + encoders); see broadcast.ts. */
export interface BroadcastHandle {
  stop(): void;
  /** The broadcast ended without being asked to: source closed, or an admin ended it. */
  onEnded(listener: () => void): void;
}

export interface BroadcastTarget {
  roomId: string;
  guildId: string | null;
}

/**
 * What the live carries as sound: nothing, the whole system mix (only when per-app
 * capture isn't available), or every app except the ones the user switched off -- at
 * the "Qualidade do som" picked, AUDIO_QUALITY_DEFAULT when absent.
 */
export type AudioChoice =
  | { mode: "off" }
  | { mode: "system"; quality?: AudioQualityKey }
  | { mode: "apps"; exclude: string[]; quality?: AudioQualityKey };

export interface LiveControllerDeps {
  startBroadcast(
    sourceId: string,
    quality: QualityPreset,
    target: BroadcastTarget,
    audio: AudioChoice,
  ): Promise<BroadcastHandle>;
  setLive(live: boolean): void;
  /** Asked when the user leaves the channel they're broadcasting to; true ends the live. */
  confirmLeave(): Promise<boolean>;
}

export interface LiveController {
  readonly isLive: boolean;
  goLive(sourceId: string, quality: QualityPreset, target: BroadcastTarget, audio?: AudioChoice): Promise<void>;
  end(): void;
  onVoiceState(state: VoiceState): Promise<void>;
  /** Notified whenever isLive flips, so the UI can redraw. */
  onChange(listener: () => void): void;
}

export function createLiveController(deps: LiveControllerDeps): LiveController {
  let broadcast: BroadcastHandle | null = null;
  let target: BroadcastTarget | null = null;
  /** True once the current departure from the live channel has been asked about. */
  let askedAboutLeaving = false;
  const listeners: Array<() => void> = [];

  function settleEnded(): void {
    broadcast = null;
    target = null;
    askedAboutLeaving = false;
    deps.setLive(false);
    for (const listener of listeners) listener();
  }

  function end(): void {
    if (!broadcast) return;
    const running = broadcast;
    settleEnded();
    running.stop();
  }

  return {
    get isLive() {
      return broadcast !== null;
    },

    async goLive(sourceId, quality, nextTarget, audio = { mode: "system" }) {
      if (broadcast) return;
      const handle = await deps.startBroadcast(sourceId, quality, nextTarget, audio);
      broadcast = handle;
      target = nextTarget;
      askedAboutLeaving = false;
      handle.onEnded(() => {
        if (broadcast === handle) settleEnded();
      });
      deps.setLive(true);
      for (const listener of listeners) listener();
    },

    end,

    async onVoiceState(state) {
      if (!broadcast || !target) return;
      const stillThere = state.status === "in-channel" && state.location.channelId === target.roomId;
      // "unknown" only happens before the first poll; it says nothing about leaving.
      if (stillThere || state.status === "unknown") {
        askedAboutLeaving = false;
        return;
      }
      if (askedAboutLeaving) return;
      askedAboutLeaving = true;
      if (await deps.confirmLeave()) end();
    },

    onChange(listener) {
      listeners.push(listener);
    },
  };
}
