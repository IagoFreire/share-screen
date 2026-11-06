import type { ActiveBroadcast, DesktopApi, StoredLogin } from "@screenshare-bot/shared";
import { mountWatchView, type WatchView } from "../watchView.js";
import type { LiveAudience } from "./broadcast.js";
import { h } from "./dom.js";
import { playerPlace, transmitPlace, whereabouts, type LivePlace, type PlaceInput, type Whereabouts } from "./livePlace.js";
import { buildSidebarModel, type SidebarChannel } from "./sidebarModel.js";
import { createVoicePoller, VOICE_POLL_INTERVAL_MS, type VoiceState } from "./voicePoller.js";
import { emptyState, renderChannels, renderMainHeader, renderRail, renderUserPanel } from "./views/shell.js";
import type { VoiceUi } from "./views/voiceUi.js";
import type { VoiceSession } from "../voice/voiceSession.js";

/**
 * The logged-in desktop window: voice-channel tracking, the sidebar, and the embedded
 * player. The player connection follows where the user is (livePlace.ts): the app's
 * voice room they sit in, else their Discord voice channel -- joining another channel
 * in Discord moves the app there on the next poll -- else, for an admin, the lobby.
 */

/** A voice room the server hasn't listed yet (the seat arrived first). */
const UNLISTED_ROOM_NAME = "Sala de voz";

/** How often the sidebar's broadcast list is refreshed while a channel is open. */
const BROADCASTS_POLL_INTERVAL_MS = 5000;

interface AppState {
  voice: VoiceState;
  broadcasts: ActiveBroadcast[];
  selectedGuildId: string | null;
  watching: { roomId: string; slot: number } | null;
  /** Where the player is connected; null when it isn't. */
  place: LivePlace | null;
}

export interface DesktopAppHooks {
  /** Wired by the go-live controller (transmit modal); null until then. */
  onTransmit: (() => void) | null;
  isLive: () => boolean;
  /** Who receives your live; null while not live or before the relay says. */
  audience: () => LiveAudience | null;
  /** Runs before logging out (which reloads the page), so a live broadcast ends cleanly. */
  beforeLogout: () => void;
  /** The voice rooms' sidebar section and dock (views/voiceUi.ts); the app places them and feeds them the lives. */
  voiceRooms: Pick<VoiceUi, "roomsSection" | "dock" | "showLives">;
  /** Which voice room the user sits in, and whether they are an admin. */
  voiceSession: Pick<VoiceSession, "state" | "onChange">;
}

export interface DesktopApp {
  /** Where "Transmitir" would send a live right now. */
  transmitPlace(): LivePlace | null;
  /** Re-renders the user panel after the live state changed. */
  refreshUserPanel(): void;
  /** Every change of where the user is (Discord channel or voice room). */
  onWhereabouts(listener: (where: Whereabouts) => void): void;
  logOut(): void;
}

/** The relay's WebSocket on the same origin desktop.html was served from. */
export function relayWsUrl(): string {
  return sameOriginWsUrl("/ws");
}

/** The voice rooms' WebSocket (server/src/voice), next to the relay's. */
export function voiceWsUrl(): string {
  return sameOriginWsUrl("/voice");
}

function sameOriginWsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${path}`;
}

export function startDesktopApp(root: HTMLElement, api: DesktopApi, login: StoredLogin, hooks: DesktopAppHooks): DesktopApp {
  let state: AppState = { voice: { status: "unknown" }, broadcasts: [], selectedGuildId: null, watching: null, place: null };
  let watchView: WatchView | null = null;
  let broadcastsTimer: ReturnType<typeof setInterval> | null = null;
  const whereaboutsListeners: Array<(where: Whereabouts) => void> = [];
  let lastWhereabouts = "";

  const rail = h("nav", { class: "desk-rail", "aria-label": "Servidores" });
  const sidebarHead = h("div", { class: "desk-sidebar-head" });
  const channelList = h("div");
  const userPanel = h("section", { class: "desk-userpanel", "aria-label": "Sua conta" });
  const mainHead = h("header", { class: "desk-main-head" });
  const playerHost = h("div", { class: "desk-player" });
  const overlay = h("div", { class: "desk-stage-overlay" });

  root.replaceChildren(
    h(
      "div",
      { class: "desk-body" },
      rail,
      h(
        "aside",
        { class: "desk-sidebar" },
        sidebarHead,
        // The voice rooms scroll with the channels but sit outside what renderChannels
        // redraws, so a room name being typed survives the broadcast refreshes.
        h("div", { class: "desk-channels" }, channelList, hooks.voiceRooms.roomsSection),
        hooks.voiceRooms.dock,
        userPanel,
      ),
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

  function placeInput(): PlaceInput {
    const voice = hooks.voiceSession.state();
    const room = voice.roomId ? voice.rooms.find((candidate) => candidate.id === voice.roomId) : undefined;
    return {
      discord: state.voice,
      voiceRoom: voice.roomId ? { id: voice.roomId, name: room?.name ?? UNLISTED_ROOM_NAME } : null,
      voiceRoomUnsettled: !voice.connected || voice.rejoining,
      isAdmin: voice.isAdmin,
    };
  }

  function render(): void {
    const servers = buildSidebarModel({ location: currentLocation(), broadcasts: state.broadcasts });
    const selectedGuildId = servers.some((server) => server.guildId === state.selectedGuildId)
      ? state.selectedGuildId
      : (servers[0]?.guildId ?? null);
    const selected = servers.find((server) => server.guildId === selectedGuildId) ?? null;

    renderRail(rail, servers, selectedGuildId, (guildId) => setState({ selectedGuildId: guildId }));
    renderChannels(sidebarHead, channelList, selected, {
      watching: state.watching,
      selfUserId: login.user.id,
      onPick: pickBroadcast,
    });
    renderUserPanel(userPanel, {
      user: login.user,
      voice: state.voice,
      place: transmitPlace(placeInput()),
      isLive: hooks.isLive(),
      audience: hooks.audience(),
      onTransmit: () => hooks.onTransmit?.(),
      onLogout: () => void logOut(),
    });

    const watched = state.watching
      ? state.broadcasts.find((b) => b.roomId === state.watching?.roomId && b.slot === state.watching.slot)
      : undefined;
    renderMainHeader(
      mainHead,
      state.place,
      watched ? { name: watched.presenterName ?? "Alguém", onLeave: () => watchView?.stopWatching() } : null,
    );
    renderOverlay();
    hooks.voiceRooms.showLives({
      broadcasts: state.broadcasts,
      watching: state.watching,
      onPick: (broadcast) => void watchView?.openBroadcast(broadcast),
    });
  }

  function renderOverlay(): void {
    const lobbyIdle = state.place?.kind === "lobby" && state.watching === null;
    if (lobbyIdle) {
      overlay.replaceChildren(
        emptyState("Você não está em nenhuma call", "Como admin, você pode abrir qualquer live ativa pela barra lateral."),
      );
    } else if (state.place) {
      overlay.replaceChildren();
    } else if (state.voice.status === "not-in-voice") {
      overlay.replaceChildren(
        emptyState(
          "Você não está em um canal de voz",
          "Entre em uma sala de voz aqui ou em um canal de voz de um servidor onde o bot está para ver e transmitir lives.",
        ),
      );
    } else if (state.voice.status === "unknown") {
      overlay.replaceChildren(emptyState("Procurando seu canal de voz…", "Isso leva só alguns segundos."));
    } else {
      overlay.replaceChildren();
    }
    overlay.classList.toggle("is-visible", lobbyIdle || state.place === null);
  }

  function pickBroadcast(channel: SidebarChannel, slot: number): void {
    const broadcast = state.broadcasts.find((b) => b.roomId === channel.channelId && b.slot === slot);
    if (!broadcast || !watchView) return;
    // `watching` follows through onWatchingChange, like every other change of broadcast.
    void watchView.openBroadcast(broadcast);
  }

  function unmountPlayer(): void {
    if (broadcastsTimer) clearInterval(broadcastsTimer);
    broadcastsTimer = null;
    watchView?.destroy();
    watchView = null;
  }

  /** Moves the player to where the user is now, and tells listeners if that changed. */
  function followPlace(): void {
    const input = placeInput();
    const next = playerPlace(input, state.place);
    if (next?.roomId !== state.place?.roomId) mountPlayer(next);
    else if (next !== state.place) setState({ place: next }); // same room, maybe renamed
    else render();

    const where = whereabouts(input);
    const key = JSON.stringify(where);
    if (key === lastWhereabouts) return;
    lastWhereabouts = key;
    for (const listener of whereaboutsListeners) listener(where);
  }

  function mountPlayer(place: LivePlace | null): void {
    unmountPlayer();
    if (!place) {
      setState({ broadcasts: [], watching: null, place: null });
      return;
    }

    watchView = mountWatchView({
      root: playerHost,
      wsUrl: relayWsUrl(),
      roomId: place.roomId,
      userId: login.user.id,
      guildId: place.guildId,
      session: login.session,
      embedded: true,
      // Your own live never plays back to you here: it would cost you its download too.
      skipOwnBroadcast: true,
      onActiveBroadcasts: (broadcasts) => setState({ broadcasts }),
      onJoined: () => watchView?.requestBroadcasts(),
      onSessionInvalid: () => void logOut(),
      // The sidebar and header show what the player really receives: the relay's
      // default pick on joining, a fallback after a live ends, or nothing.
      onWatchingChange: (watching) => setState({ watching }),
    });
    broadcastsTimer = setInterval(() => watchView?.requestBroadcasts(), BROADCASTS_POLL_INTERVAL_MS);
    setState({
      watching: null,
      broadcasts: [],
      place,
      selectedGuildId: place.kind === "discord" ? place.guildId : state.selectedGuildId,
    });
  }

  const poller = createVoicePoller({
    fetchVoice: () => fetch("/api/desktop/voice", { headers: { Authorization: `Bearer ${login.session}` } }),
    intervalMs: VOICE_POLL_INTERVAL_MS,
    onChange: (voice) => {
      state = { ...state, voice };
      followPlace();
    },
    onSessionInvalid: () => void logOut(),
  });

  hooks.voiceSession.onChange(followPlace);
  render();
  poller.start();

  return {
    transmitPlace: () => transmitPlace(placeInput()),
    refreshUserPanel: render,
    onWhereabouts: (listener) => whereaboutsListeners.push(listener),
    logOut: () => void logOut(),
  };
}
