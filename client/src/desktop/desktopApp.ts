import type { ActiveBroadcast, DesktopApi, StoredLogin } from "@screenshare-bot/shared";
import { mountWatchView, type WatchView } from "../watchView.js";
import { h } from "./dom.js";
import { buildSidebarModel, type SidebarChannel } from "./sidebarModel.js";
import { createVoicePoller, VOICE_POLL_INTERVAL_MS, type VoiceState } from "./voicePoller.js";
import { emptyState, renderChannels, renderMainHeader, renderRail, renderUserPanel } from "./views/shell.js";

/**
 * The logged-in desktop window: voice-channel tracking, the sidebar, and the embedded
 * player. The player connection follows the user's voice channel -- joining another
 * channel in Discord moves the app there on the next poll.
 */

/** How often the sidebar's broadcast list is refreshed while a channel is open. */
const BROADCASTS_POLL_INTERVAL_MS = 5000;

interface AppState {
  voice: VoiceState;
  broadcasts: ActiveBroadcast[];
  selectedGuildId: string | null;
  watching: { roomId: string; slot: number } | null;
}

export interface DesktopAppHooks {
  /** Wired by the go-live controller (transmit modal); null until then. */
  onTransmit: (() => void) | null;
  isLive: () => boolean;
  viewerCount: () => number | null;
  /** Runs before logging out (which reloads the page), so a live broadcast ends cleanly. */
  beforeLogout: () => void;
}

export interface DesktopApp {
  voice(): VoiceState;
  /** Re-renders the user panel after the live state changed. */
  refreshUserPanel(): void;
  onVoiceChange(listener: (voice: VoiceState) => void): void;
}

/** The relay's WebSocket on the same origin desktop.html was served from. */
export function relayWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}

export function startDesktopApp(root: HTMLElement, api: DesktopApi, login: StoredLogin, hooks: DesktopAppHooks): DesktopApp {
  let state: AppState = { voice: { status: "unknown" }, broadcasts: [], selectedGuildId: null, watching: null };
  let watchView: WatchView | null = null;
  let watchedRoomId: string | null = null;
  let broadcastsTimer: ReturnType<typeof setInterval> | null = null;
  const voiceListeners: Array<(voice: VoiceState) => void> = [];

  const rail = h("nav", { class: "desk-rail", "aria-label": "Servidores" });
  const sidebarHead = h("div", { class: "desk-sidebar-head" });
  const channelList = h("div", { class: "desk-channels" });
  const userPanel = h("section", { class: "desk-userpanel", "aria-label": "Sua conta" });
  const mainHead = h("header", { class: "desk-main-head" });
  const playerHost = h("div", { class: "desk-player" });
  const overlay = h("div", { class: "desk-stage-overlay" });

  root.replaceChildren(
    h(
      "div",
      { class: "desk-body" },
      rail,
      h("aside", { class: "desk-sidebar" }, sidebarHead, channelList, userPanel),
      h("main", { class: "desk-main" }, mainHead, h("div", { class: "desk-stage" }, playerHost, overlay)),
    ),
  );

  async function logOut(): Promise<void> {
    hooks.beforeLogout();
    await api.logout();
    window.location.reload();
  }

  function setState(patch: Partial<AppState>): void {
    state = { ...state, ...patch };
    render();
  }

  function currentLocation() {
    return state.voice.status === "in-channel" ? state.voice.location : null;
  }

  function render(): void {
    const servers = buildSidebarModel({ location: currentLocation(), broadcasts: state.broadcasts });
    const selectedGuildId = servers.some((server) => server.guildId === state.selectedGuildId)
      ? state.selectedGuildId
      : (servers[0]?.guildId ?? null);
    const selected = servers.find((server) => server.guildId === selectedGuildId) ?? null;

    renderRail(rail, servers, selectedGuildId, (guildId) => setState({ selectedGuildId: guildId }));
    renderChannels(sidebarHead, channelList, selected, { watching: state.watching, onPick: pickBroadcast });
    renderUserPanel(userPanel, {
      user: login.user,
      voice: state.voice,
      isLive: hooks.isLive(),
      viewerCount: hooks.viewerCount(),
      onTransmit: () => hooks.onTransmit?.(),
      onLogout: () => void logOut(),
    });

    const watched = state.watching
      ? state.broadcasts.find((b) => b.roomId === state.watching?.roomId && b.slot === state.watching.slot)
      : undefined;
    renderMainHeader(mainHead, state.voice, watched ? (watched.presenterName ?? "Alguém") : null);
    renderOverlay();
  }

  function renderOverlay(): void {
    if (state.voice.status === "not-in-voice") {
      overlay.replaceChildren(
        emptyState(
          "Você não está em um canal de voz",
          "Entre em um canal de voz de um servidor onde o bot está para ver e transmitir lives.",
        ),
      );
    } else if (state.voice.status === "unknown") {
      overlay.replaceChildren(emptyState("Procurando seu canal de voz…", "Isso leva só alguns segundos."));
    } else {
      overlay.replaceChildren();
    }
    overlay.classList.toggle("is-visible", state.voice.status !== "in-channel");
  }

  function pickBroadcast(channel: SidebarChannel, slot: number): void {
    const broadcast = state.broadcasts.find((b) => b.roomId === channel.channelId && b.slot === slot);
    if (!broadcast || !watchView) return;
    void watchView.openBroadcast(broadcast);
    setState({ watching: { roomId: broadcast.roomId, slot } });
  }

  function unmountPlayer(): void {
    if (broadcastsTimer) clearInterval(broadcastsTimer);
    broadcastsTimer = null;
    watchView?.destroy();
    watchView = null;
    watchedRoomId = null;
  }

  function mountPlayerFor(voice: VoiceState): void {
    const location = voice.status === "in-channel" ? voice.location : null;
    if (location?.channelId === watchedRoomId) return;

    unmountPlayer();
    if (!location) {
      setState({ broadcasts: [], watching: null });
      return;
    }

    watchedRoomId = location.channelId;
    watchView = mountWatchView({
      root: playerHost,
      wsUrl: relayWsUrl(),
      roomId: location.channelId,
      userId: login.user.id,
      guildId: location.guildId,
      session: login.session,
      embedded: true,
      onActiveBroadcasts: (broadcasts) => setState({ broadcasts }),
      onJoined: () => watchView?.requestBroadcasts(),
      onSessionInvalid: () => void logOut(),
    });
    broadcastsTimer = setInterval(() => watchView?.requestBroadcasts(), BROADCASTS_POLL_INTERVAL_MS);
    setState({ watching: null, selectedGuildId: location.guildId });
  }

  const poller = createVoicePoller({
    fetchVoice: () => fetch("/api/desktop/voice", { headers: { Authorization: `Bearer ${login.session}` } }),
    intervalMs: VOICE_POLL_INTERVAL_MS,
    onChange: (voice) => {
      setState({ voice });
      mountPlayerFor(voice);
      for (const listener of voiceListeners) listener(voice);
    },
    onSessionInvalid: () => void logOut(),
  });

  render();
  poller.start();

  return {
    voice: () => state.voice,
    refreshUserPanel: render,
    onVoiceChange: (listener) => voiceListeners.push(listener),
  };
}
