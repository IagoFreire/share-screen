import {
  FrameType,
  type ActiveBroadcast,
  type AudioParams,
  type ControlMessage,
  type EncodedFrame,
  type StreamInfo,
} from "@screenshare-bot/shared";
import { WsClient } from "./net/wsClient.js";
import { startVideoDecodePipeline, type VideoDecodePipeline } from "./playback/videoDecodePipeline.js";
import { MAX_VOLUME, startAudioDecodePipeline, type AudioDecodePipeline } from "./playback/audioDecodePipeline.js";
import { createMediaClock } from "./playback/mediaClock.js";
import {
  ICON_BELL,
  ICON_END_STREAM,
  ICON_FULLSCREEN_ENTER,
  ICON_FULLSCREEN_EXIT,
  ICON_IDLE,
  ICON_LIST,
  ICON_MUTED,
  ICON_REFRESH,
  ICON_VIDEO,
  ICON_VIDEO_OFF,
  ICON_VOLUME,
} from "./ui/icons.js";
import { BROADCASTS_PANEL_HTML, createBroadcastsPanel, syncBroadcastsButton } from "./ui/broadcastsPanel.js";
import { createQualityMenu, type QualityChoice } from "./ui/qualityMenu.js";
import { autoWatchSlot, isOwnStream } from "./ui/streamChoice.js";

/** Lockout after the "ao vivo" button -- see App.ts. */
const JUMP_TO_LIVE_COOLDOWN_MS = 1500;

export interface WatchViewOptions {
  root: HTMLElement;
  wsUrl: string;
  roomId: string;
  userId: string | null;
  guildId: string | null;
  /** Signed desktop login, sent with every join (see server/src/ws/joinIdentity.ts). */
  session?: string | null;
  /**
   * Hosted inside the desktop app: its sidebar lists broadcasts, so the in-player list
   * and its button stay hidden, and the window has no address bar to keep in step.
   */
  embedded?: boolean;
  /** Connection/join progress text; watch.html shows it under the player. */
  onStatus?: (text: string) => void;
  onActiveBroadcasts?: (broadcasts: ActiveBroadcast[]) => void;
  onJoined?: (info: { isAdmin: boolean; roomId: string }) => void;
  /** The relay refused the session; the view stops reconnecting with it. */
  onSessionInvalid?: () => void;
  /** The broadcast being received changed, including to none ("Sair da live"). */
  onWatchingChange?: (watching: { roomId: string; slot: number } | null) => void;
  /**
   * Never receive the user's own broadcast (the desktop app): a preview through the
   * relay costs the presenter download for nothing. The player then picks for itself
   * which broadcast to be on -- see ui/streamChoice.ts.
   */
  skipOwnBroadcast?: boolean;
}

export interface WatchView {
  openBroadcast(broadcast: ActiveBroadcast): Promise<void>;
  /** "Sair da live": receives nothing until a broadcast is picked again. */
  stopWatching(): void;
  requestBroadcasts(): void;
  /** Closes the socket, stops both pipelines and drops every document/window listener. */
  destroy(): void;
}

/**
 * The broadcast player: one WebSocket viewer connection plus its decode pipelines and
 * controls. watch.html mounts it as a whole page (a plain browser tab opened from the
 * Activity, where -- unlike Discord's sandboxed iframe -- the real Fullscreen API
 * works); the desktop app mounts it inside its own window. Read-only: it never
 * captures or presents.
 */
export function mountWatchView(options: WatchViewOptions): WatchView {
  const setPageStatus = (text: string) => options.onStatus?.(text);
  const userId = options.userId ?? "";
  const isEmbedded = options.embedded ?? false;
  const skipOwn = options.skipOwnBroadcast ?? false;
  /** Whose broadcast "Voltar a assistir" may not go back to: nobody's unless skipOwn. */
  const ownUserId = skipOwn ? userId : "";

  /**
   * The room being watched. An admin can hop to another room from the broadcast list
   * (see openBroadcast), so it isn't fixed for the view's lifetime.
   */
  let roomId: string = options.roomId;
  let guildId = options.guildId;
  /** Slot to select once a hop's "joined" lands; see openBroadcast. */
  let pendingSlot: number | null = null;
  /** The room a hop left, to go back to if the server refuses it -- see App.ts. */
  let hopFrom: { roomId: string; guildId: string | null } | null = null;

  const root = options.root;

  root.innerHTML = `
    <div class="player" id="player">
      <canvas id="viewer-canvas"></canvas>
      ${BROADCASTS_PANEL_HTML}
      <div class="idle-screen" id="idle-screen">
        <div class="idle-icon">${ICON_IDLE}</div>
        <p class="idle-title" id="idle-title">Ninguém está transmitindo</p>
        <p class="idle-subtitle" id="idle-subtitle">Assim que alguém compartilhar a tela na call, aparece aqui.</p>
        <button id="resume-btn" class="btn-primary" type="button" style="display: none">Retomar aqui</button>
        <button id="rewatch-btn" class="btn-primary" type="button" style="display: none">Voltar a assistir</button>
      </div>
      <div class="controls-zone">
        <div class="overlay-bar">
          <span id="status-text" class="status-text"></span>
          <div class="spacer"></div>
          <button id="live-btn" class="icon-btn" type="button" title="Atualizar: voltar ao ao vivo" style="display: none">${ICON_REFRESH}</button>
          <button id="broadcasts-btn" class="icon-btn" type="button" title="Escolher transmissão" style="display: none">${ICON_LIST}</button>
          <button id="alert-btn" class="icon-btn" type="button" title="Tocar um alerta para quem está transmitindo" style="display: none">${ICON_BELL}</button>
          <button id="end-stream-btn" class="icon-btn is-danger" type="button" title="Encerrar esta transmissão" style="display: none">${ICON_END_STREAM}</button>
          <button id="video-toggle-btn" class="icon-btn" type="button" title="Desativar vídeo (somente áudio)">${ICON_VIDEO}</button>
          <div class="volume-group">
            <button id="mute-btn" class="icon-btn" type="button" title="Mudo">${ICON_VOLUME}</button>
            <input id="volume-slider" class="volume-slider" type="range" min="0" max="${MAX_VOLUME * 100}" value="100" title="Volume: 100%" style="--fill: ${100 / MAX_VOLUME}%" />
          </div>
          <button id="fullscreen-btn" class="icon-btn" type="button" title="Tela cheia">${ICON_FULLSCREEN_ENTER}</button>        </div>
      </div>
    </div>
  `;

  const player = root.querySelector<HTMLDivElement>("#player")!;
  const statusText = root.querySelector<HTMLSpanElement>("#status-text")!;
  const alertButton = root.querySelector<HTMLButtonElement>("#alert-btn")!;
  const endStreamButton = root.querySelector<HTMLButtonElement>("#end-stream-btn")!;
  const videoToggleButton = root.querySelector<HTMLButtonElement>("#video-toggle-btn")!;
  const muteButton = root.querySelector<HTMLButtonElement>("#mute-btn")!;
  const volumeSlider = root.querySelector<HTMLInputElement>("#volume-slider")!;
  const fullscreenButton = root.querySelector<HTMLButtonElement>("#fullscreen-btn")!;
  const canvas = root.querySelector<HTMLCanvasElement>("#viewer-canvas")!;
  const idleScreen = root.querySelector<HTMLDivElement>("#idle-screen")!;
  const idleTitle = root.querySelector<HTMLParagraphElement>("#idle-title")!;
  const idleSubtitle = root.querySelector<HTMLParagraphElement>("#idle-subtitle")!;
  const resumeButton = root.querySelector<HTMLButtonElement>("#resume-btn")!;
  const rewatchButton = root.querySelector<HTMLButtonElement>("#rewatch-btn")!;
  const liveButton = root.querySelector<HTMLButtonElement>("#live-btn")!;
  const broadcastsButton = root.querySelector<HTMLButtonElement>("#broadcasts-btn")!;

  /** Simulcast: what the viewer picked, and the layer the relay is actually sending. */
  let layerChoice: QualityChoice = "auto";
  let currentLayer = 0;
  const qualityMenu = createQualityMenu((choice) => {
    layerChoice = choice;
    wsClient.sendControl({ kind: "select-layer", layer: choice });
    render();
  });
  liveButton.before(qualityMenu.element);

  // Same list as in the Activity (see ui/broadcastsPanel.ts). Everything it reads is
  // looked up lazily, so it can be built before the state and socket declared below.
  const broadcastsPanel = createBroadcastsPanel({
    panel: root.querySelector<HTMLDivElement>("#broadcasts-panel")!,
    context: () => ({ roomId, selectedSlot, isAdmin, userId }),
    requestList: () => wsClient.sendControl({ kind: "request-active-broadcasts" }),
    onPick: (broadcast) => void openBroadcast(broadcast),
    onOpenChange: () => render(),
  });
  broadcastsButton.addEventListener("click", () => broadcastsPanel.toggle());

  // Shared between the two decode pipelines so video plays against audio's clock rather
  // than its own -- see playback/mediaClock.ts. Outlives both, since they're torn down
  // and rebuilt independently (pause/resume, audio-only toggle, audio param changes).
  const mediaClock = createMediaClock();

  let videoDecodePipeline: VideoDecodePipeline | null = null;
  let audioDecodePipeline: AudioDecodePipeline | null = null;
  let currentAudioParams: AudioParams | null = null;
  /** Server's last-known audio params for the room, tracked independent of whether a
   *  pipeline currently exists, so resuming after a pause knows what to (re)create. */
  let lastAudioParams: AudioParams | null = null;
  let viewerCount = 0;
  /** Every broadcast live in this room. A room can carry several at once. */
  let streams: StreamInfo[] = [];
  /**
   * Which of them this tab is receiving -- exactly one at a time, or none (null) after
   * "Sair da live", which sticks across reconnects and new broadcasts until the viewer
   * picks one: someone who left shouldn't be dragged back in by the next live.
   */
  let selectedSlot: number | null = 0;
  /** What "Voltar a assistir" goes back to, while that broadcast is still live. */
  let lastLeftSlot: number | null = null;
  /** "Sair da live" was used and nothing picked since; skipOwn's own picks stay off. */
  let hasLeft = false;
  /**
   * The user opened their own broadcast on purpose (it never opens by itself, see
   * skipOwnBroadcast): it stays on until they pick another, and the relay keeps its
   * picture flowing for them (select-stream `preview`).
   */
  let ownPicked = false;
  /** Whether the join just sent asked to start on no broadcast (see sendJoin). */
  let joinWatchesNothing = false;
  /** Last value given to onWatchingChange, as "room:slot" ("" for none). */
  let notifiedWatching = "";
  let lastVolumeBeforeMute = 1;
  /** True while the server has paused this connection because the same user has
   *  another tab (the Activity, or yet another external tab) already receiving it. */
  let isPausedHere = false;
  /** True while this viewer chose to stop receiving video (audio-only, e.g. to listen
   *  along to music without watching). Purely a local preference sent to the server. */
  let videoDisabled = false;
  /** Set by the server at join: may this user end other people's broadcasts? */
  let isAdmin = false;
  /**
   * Bumped by every call that decides what the video pipeline should be (join, resume,
   * toggle). `startVideoDecodePipeline()` is async (it awaits `isConfigSupported()`), so
   * two calls can race -- e.g. two quick clicks of the toggle button, or a toggle racing
   * a reconnect's "joined". Whichever call's generation is no longer current when its
   * await resolves lost the race and must stop the pipeline it just built instead of
   * assigning it, or that decoder and its render loop would leak forever.
   */
  let videoPipelineGeneration = 0;

  const currentStream = (): StreamInfo | undefined => streams.find((s) => s.slot === selectedSlot);
  /** True when the stream being watched is this user's own broadcast. */
  const isSelf = () => userId !== "" && currentStream()?.presenterId === userId;
  const hasPresenter = () => streams.length > 0;
  /** Receiving a live broadcast -- false with nobody live, or after "Sair da live". */
  const isWatching = () => currentStream() !== undefined;
  const audioParamsForSelection = () => currentStream()?.audio ?? null;

  function render(): void {
    // Your own broadcast isn't decoded back with a choice of versions; hide the picker.
    qualityMenu.update(isSelf() ? undefined : currentStream()?.layers, layerChoice, currentLayer);

    if (streams.length > 1) {
      statusText.textContent = `${streams.length} transmissões — ${viewerCount} espectador(es).`;
    } else if (hasPresenter()) {
      statusText.textContent = isSelf()
        ? `Sua transmissão — ${viewerCount} espectador(es).`
        : `Alguém está transmitindo — ${viewerCount} espectador(es).`;
    } else {
      statusText.textContent = `${viewerCount} pessoa(s) na sala.`;
    }

    // The broadcast list is how everyone picks what to watch (see ui/broadcastsPanel.ts)
    // -- except embedded, where the desktop app's sidebar already is that list.
    const showBroadcastsButton =
      !isEmbedded &&
      syncBroadcastsButton(broadcastsButton, {
        isAdmin,
        streamCount: streams.length,
        isOpen: broadcastsPanel.isOpen,
      });
    if (isEmbedded) broadcastsButton.style.display = "none";
    if (!showBroadcastsButton) broadcastsPanel.close();

    // Being paused only matters visibly once there's actually a broadcast it's saving
    // bandwidth on -- with no presenter nothing was going to be sent either way, so
    // showing "paused" then would just be confusing for no benefit. Shown even when
    // watching your own broadcast: this tab would otherwise be a blank void with no
    // video and no explanation, since it never renders your own broadcast back to you.
    const showPausedUi = isPausedHere && hasPresenter();
    // "Sair da live" with something still on: say so, and offer the way back.
    const showNotWatchingUi = !showPausedUi && selectedSlot === null && rewatchSlot() !== null;
    // skipOwn with only your own broadcast on: there's nothing here to watch.
    const showOwnLiveOnlyUi = !showPausedUi && selectedSlot === null && hasPresenter() && rewatchSlot() === null;
    // Your own broadcast with nobody else watching sends nothing (see audience-changed
    // in the protocol), so the preview would just freeze without this.
    const showSelfPausedUi = !showPausedUi && isSelf() && currentStream()?.paused === true;
    // Audio-only is its own idle-screen state, one rung below "paused" -- see App.ts.
    const showAudioOnlyUi = !showPausedUi && !isSelf() && isWatching() && videoDisabled;
    // Watching your own broadcast doesn't block video the way it blocks audio -- once
    // resumed this connection genuinely decodes your own stream, so the toggle is just
    // as real here as for any other viewer (just never paired with audio -- see App.ts).
    const showVideoOffSelfUi = !showPausedUi && !showSelfPausedUi && isSelf() && videoDisabled;
    const showIdleScreen =
      !hasPresenter() ||
      showPausedUi ||
      showNotWatchingUi ||
      showOwnLiveOnlyUi ||
      showSelfPausedUi ||
      showAudioOnlyUi ||
      showVideoOffSelfUi;
    idleScreen.classList.toggle("is-hidden", !showIdleScreen);

    // Inline style rather than a CSS class -- see App.ts for why (an inline style can't
    // be outranked by any stylesheet rule).
    resumeButton.style.display = showPausedUi ? "" : "none";
    rewatchButton.style.display = showNotWatchingUi ? "" : "none";
    rewatchButton.textContent = rewatchSlot() === lastLeftSlot ? "Voltar a assistir" : "Assistir";

    if (showPausedUi) {
      idleTitle.textContent = "Pausado para economizar banda";
      idleSubtitle.textContent = "Você está conectado em outra aba.";
    } else if (showNotWatchingUi) {
      idleTitle.textContent = "Você não está assistindo nenhuma live";
      idleSubtitle.textContent = isEmbedded
        ? "Escolha uma transmissão na barra lateral para assistir."
        : "Escolha uma transmissão para assistir.";
    } else if (showOwnLiveOnlyUi) {
      idleTitle.textContent = "Você está transmitindo";
      idleSubtitle.textContent =
        "Sua live não abre sozinha aqui, para não gastar sua internet. Se quiser ver, clique nela na barra lateral.";
    } else if (showSelfPausedUi) {
      idleTitle.textContent = "Sua live está pausada";
      idleSubtitle.textContent = "Ninguém está assistindo, então ela não gasta sua internet. Volta sozinha quando alguém abrir.";
    } else if (showAudioOnlyUi) {
      idleTitle.textContent = "Somente áudio";
      idleSubtitle.textContent = "O vídeo está desativado. Clique no ícone de câmera para reativar.";
    } else if (showVideoOffSelfUi) {
      idleTitle.textContent = "Vídeo desativado";
      idleSubtitle.textContent = "Sua prévia está oculta. Clique no ícone de câmera para mostrar de novo.";
    } else if (!hasPresenter()) {
      idleTitle.textContent = "Ninguém está transmitindo";
      idleSubtitle.textContent = "Assim que alguém compartilhar a tela na call, aparece aqui.";
    }

    const controlsDisabled = isSelf() || isPausedHere || !isWatching();
    muteButton.disabled = controlsDisabled;
    volumeSlider.disabled = controlsDisabled;
    syncMuteButton();

    // Unlike audio, video isn't blocked while watching your own broadcast -- see
    // showVideoOffSelfUi above. Only actually being paused (or watching nothing) means
    // there's no pipeline to toggle.
    // Admin-only, and never for your own broadcast -- see App.ts.
    const canModerateStream = isAdmin && isWatching() && !isSelf();
    alertButton.style.display = canModerateStream ? "" : "none";
    endStreamButton.style.display = canModerateStream ? "" : "none";

    videoToggleButton.disabled = isPausedHere || !isWatching();
    videoToggleButton.innerHTML = videoDisabled ? ICON_VIDEO_OFF : ICON_VIDEO;
    videoToggleButton.classList.toggle("is-off", videoDisabled);
    videoToggleButton.title = videoDisabled ? "Ativar vídeo" : "Desativar vídeo (somente áudio)";

    // Only offered while there's a video pipeline to refresh (see jumpToLive).
    liveButton.style.display = isWatching() && !isPausedHere && !videoDisabled ? "" : "none";

    notifyWatching();
  }

  function notifyWatching(): void {
    const stream = currentStream();
    const key = stream ? `${roomId}:${stream.slot}` : "";
    if (key === notifiedWatching) return;
    notifiedWatching = key;
    options.onWatchingChange?.(stream ? { roomId, slot: stream.slot } : null);
  }

  /** "Voltar a assistir": the broadcast left, if it's still on, else the first one. */
  function rewatchSlot(): number | null {
    return autoWatchSlot(streams, { preferred: lastLeftSlot, userId: ownUserId, hasLeft: false });
  }

  /**
   * skipOwn: moves off the user's own broadcast, or onto someone's when there was
   * nothing, after the list changed. True when it switched (selectStream did the rest).
   */
  function followAutoChoice(): boolean {
    if (!skipOwn) return false;
    const slot = autoWatchSlot(streams, { preferred: selectedSlot, userId, hasLeft, ownPicked });
    if (slot === selectedSlot) return false;
    void selectStream(slot);
    return true;
  }

  const isOwnSlot = (slot: number | null) =>
    slot !== null && streams.some((s) => s.slot === slot && isOwnStream(s, userId));

  /** select-stream, flagged as a deliberate preview when it's the live the user opened of their own. */
  function selectStreamMessage(slot: number | null): ControlMessage {
    return ownPicked && isOwnSlot(slot) ? { kind: "select-stream", slot, preview: true } : { kind: "select-stream", slot };
  }

  /**
   * Switches which broadcast is received, or (null) stops receiving any -- see App.ts
   * for why both pipelines restart.
   */
  async function selectStream(slot: number | null): Promise<void> {
    if (slot === selectedSlot) return;
    selectedSlot = slot;
    if (!isOwnSlot(slot)) ownPicked = false;
    wsClient.sendControl(selectStreamMessage(slot));

    teardownVideoPipeline();
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    lastAudioParams = audioParamsForSelection();
    render();

    await ensureVideoPipeline();
    void ensureAudioPipeline(lastAudioParams);
    if (slot !== null) wsClient.sendControl({ kind: "request-keyframe" });
  }

  function stopWatching(): void {
    if (selectedSlot === null) return;
    lastLeftSlot = selectedSlot;
    hasLeft = true;
    void selectStream(null);
  }

  /**
   * Opens a broadcast picked from the list, hopping rooms when it lives elsewhere --
   * only an admin's list ever offers another room. Mirrors App.ts's openBroadcast: the
   * same socket re-joins, and the slot is selected once that join lands (pendingSlot).
   */
  async function openBroadcast(broadcast: ActiveBroadcast): Promise<void> {
    hasLeft = false;
    ownPicked = isOwnStream(broadcast, userId);
    if (broadcast.roomId === roomId) {
      await selectStream(broadcast.slot);
      return;
    }

    hopFrom = { roomId, guildId };
    roomId = broadcast.roomId;
    guildId = broadcast.guildId;
    pendingSlot = broadcast.slot;
    syncAddressToRoom();

    teardownVideoPipeline();
    audioDecodePipeline?.stop();
    audioDecodePipeline = null;
    currentAudioParams = null;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    streams = [];
    render();
    setPageStatus("Entrando na transmissão...");

    sendJoin();
  }

  function sendJoin(): void {
    // Left the live before this (re)connect, or skipOwn, which picks for itself once
    // joined rather than risk the relay's default being the user's own broadcast. A
    // hop is a pick, so it always watches.
    joinWatchesNothing = pendingSlot === null && (selectedSlot === null || skipOwn);
    wsClient.sendControl({
      kind: "join",
      roomId,
      userId: userId || null,
      guildId,
      session: options.session ?? null,
      watchNothing: joinWatchesNothing,
    });
  }

  /** Goes back to the room a refused hop left -- see App.ts's returnFromFailedHop. */
  function returnFromFailedHop(): void {
    if (!hopFrom) return;
    ({ roomId, guildId } = hopFrom);
    hopFrom = null;
    pendingSlot = null;
    syncAddressToRoom();
    sendJoin();
  }

  /** Keeps the address in step, so reloading this tab stays on the room now on screen. */
  function syncAddressToRoom(): void {
    if (isEmbedded) return;
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    if (guildId) url.searchParams.set("guild", guildId);
    else url.searchParams.delete("guild");
    history.replaceState(null, "", url);
  }

  /** "Atualizar": restarts the picture from a fresh keyframe -- see App.ts's jumpToLive. */
  async function jumpToLive(): Promise<void> {
    if (!isWatching() || isPausedHere || videoDisabled) return;
    teardownVideoPipeline();
    await ensureVideoPipeline();
    wsClient.sendControl({ kind: "request-keyframe" });
  }

  liveButton.addEventListener("click", () => {
    if (liveButton.disabled) return;
    void jumpToLive();
    liveButton.disabled = true;
    setTimeout(() => {
      liveButton.disabled = false;
    }, JUMP_TO_LIVE_COOLDOWN_MS);
  });

  const wsClient = new WsClient(options.wsUrl, {
    onOpen: () => {
      setPageStatus("Conectado. Entrando na sala...");
      sendJoin();
    },
    onClose: () => setPageStatus("Desconectado. Tentando reconectar..."),
    onControl: (message) => void handleControl(message),
    onFrame: (frame) => handleFrame(frame),
  });

  async function ensureAudioPipeline(params: AudioParams | null): Promise<void> {
    // Never decode your own broadcast back to yourself if you also opened this tab.
    if (isSelf()) params = null;

    const unchanged =
      params &&
      currentAudioParams &&
      params.sampleRate === currentAudioParams.sampleRate &&
      params.channels === currentAudioParams.channels;
    if (unchanged) return;

    audioDecodePipeline?.stop();
    audioDecodePipeline = null;
    currentAudioParams = params;

    if (!params) return;

    audioDecodePipeline = startAudioDecodePipeline(params, mediaClock);
    audioDecodePipeline.setVolume(Number(volumeSlider.value) / 100);
  }

  /** Starts the video pipeline if one isn't already running, guarding against the race
   *  described where `videoPipelineGeneration` is declared. */
  async function ensureVideoPipeline(): Promise<void> {
    if (videoDisabled || videoDecodePipeline || selectedSlot === null) return;
    const generation = ++videoPipelineGeneration;
    const pipeline = await startVideoDecodePipeline(canvas, {
      clock: mediaClock,
      onKeyframeNeeded: () => wsClient.sendControl({ kind: "request-keyframe" }),
    });
    if (generation !== videoPipelineGeneration) {
      // Superseded by a later join/resume/toggle while the decoder was starting up.
      pipeline.stop();
      return;
    }
    videoDecodePipeline = pipeline;
  }

  function teardownVideoPipeline(): void {
    videoPipelineGeneration++; // invalidates any in-flight ensureVideoPipeline() call
    videoDecodePipeline?.stop();
    videoDecodePipeline = null;
  }

  /**
   * Which broadcast a fresh connection is on, once "joined" lands. Mirrors the relay's
   * choice -- none for a join with watchNothing (see sendJoin), else the lowest live
   * one -- unless this join is a hop from the broadcast list, whose whole point was one
   * specific slot. skipOwn then picks for itself: back to what it was on, or someone
   * else's live.
   */
  function settleJoinedSelection(): void {
    const previous = selectedSlot;
    const hop = pendingSlot;
    pendingSlot = null;
    selectedSlot = joinWatchesNothing ? null : (streams[0]?.slot ?? 0);

    let wanted = hop !== null && streams.some((s) => s.slot === hop) ? hop : selectedSlot;
    if (skipOwn) wanted = autoWatchSlot(streams, { preferred: hop ?? previous, userId, hasLeft, ownPicked });
    if (wanted === selectedSlot) return;
    selectedSlot = wanted;
    wsClient.sendControl(selectStreamMessage(wanted));
  }

  async function handleControl(message: ControlMessage): Promise<void> {
    switch (message.kind) {
      case "joined":
        // See App.ts: a "joined" always means a brand-new, unpaused ConnectionState on
        // the server -- including after a silent WS reconnect -- so any leftover pause
        // flag from before the reconnect must be cleared here, or the UI gets stuck
        // showing "Retomar aqui" forever over a feed that's actually flowing fine.
        isPausedHere = false;
        hopFrom = null; // any hop in flight landed
        isAdmin = message.isAdmin;
        viewerCount = message.viewerCount;
        streams = message.streams;
        settleJoinedSelection();
        lastAudioParams = audioParamsForSelection();
        render();
        setPageStatus("");
        options.onJoined?.({ isAdmin, roomId });
        void ensureVideoPipeline();
        void ensureAudioPipeline(lastAudioParams);
        // The server always starts a fresh connection with video enabled -- tell it
        // about a still-active local preference carried over from before this (re)join.
        if (videoDisabled) wsClient.sendControl({ kind: "set-video-enabled", enabled: false });
        // Same for a fixed quality choice: a fresh connection starts on "auto".
        currentLayer = 0;
        if (layerChoice !== "auto") wsClient.sendControl({ kind: "select-layer", layer: layerChoice });
        wsClient.sendControl({ kind: "request-keyframe" });
        return;

      case "viewer-count":
        viewerCount = message.count;
        render();
        return;

      case "layer-changed":
        currentLayer = message.layer;
        render();
        return;

      case "active-broadcasts":
        options.onActiveBroadcasts?.(message.broadcasts);
        if (!isEmbedded) broadcastsPanel.show(message.broadcasts);
        return;

      case "streams-changed": {
        streams = message.streams;
        // The watched stream may have ended; the server already moved this connection
        // to a surviving slot, so follow it instead of receiving nothing. Someone who
        // left the live stays out -- the server keeps them on no slot too.
        if (selectedSlot !== null && !currentStream()) selectedSlot = streams[0]?.slot ?? selectedSlot;
        // Refresh an open list now rather than on the next poll, so it never offers a
        // broadcast that has already ended.
        broadcastsPanel.refresh();
        // skipOwn: the user just went live on the slot this player was on, the relay's
        // fallback was their own broadcast, or someone else started while there was nothing.
        if (followAutoChoice()) return;
        lastAudioParams = audioParamsForSelection();
        render();
        if (!isPausedHere) {
          void ensureAudioPipeline(lastAudioParams);
          if (isWatching()) wsClient.sendControl({ kind: "request-keyframe" });
        }
        return;
      }

      // Another tab for this same user is now receiving the stream -- tear down our
      // own pipelines here so it isn't sent to us twice.
      case "viewing-paused":
        isPausedHere = true;
        teardownVideoPipeline();
        audioDecodePipeline?.stop();
        audioDecodePipeline = null;
        currentAudioParams = null;
        render();
        return;

      case "viewing-resumed":
        isPausedHere = false;
        render();
        void ensureVideoPipeline();
        void ensureAudioPipeline(lastAudioParams);
        if (isWatching()) wsClient.sendControl({ kind: "request-keyframe" });
        return;

      case "room-full":
        setPageStatus("Sala cheia - não foi possível entrar.");
        returnFromFailedHop();
        return;

      case "error":
        // Reconnecting would only present the same rejected session again, forever.
        if (message.code === "invalid-session") {
          wsClient.close();
          options.onSessionInvalid?.();
          return;
        }
        setPageStatus(`Erro: ${message.message}`);
        returnFromFailedHop();
        return;

      default:
        return;
    }
  }

  function handleFrame(frame: EncodedFrame): void {
    if (frame.type === FrameType.Video && videoDecodePipeline) {
      videoDecodePipeline.decodeChunk({
        keyFrame: frame.keyFrame ?? false,
        timestampUs: frame.timestamp * 1000,
        data: frame.payload,
      });
    } else if (frame.type === FrameType.Audio && audioDecodePipeline) {
      audioDecodePipeline.decodeChunk({ timestampUs: frame.timestamp * 1000, data: frame.payload });
    }
  }

  resumeButton.addEventListener("click", () => {
    wsClient.sendControl({ kind: "resume-viewing" });
  });

  rewatchButton.addEventListener("click", () => {
    const slot = rewatchSlot();
    if (slot === null) return;
    hasLeft = false;
    void selectStream(slot);
  });

  // Brief lockout after each chime -- see App.ts.
  alertButton.addEventListener("click", () => {
    const stream = currentStream();
    if (!stream || alertButton.disabled) return;

    wsClient.sendControl({ kind: "play-alert", slot: stream.slot });
    alertButton.disabled = true;
    setTimeout(() => {
      alertButton.disabled = false;
    }, 2000);
  });

  // Single click, no confirmation -- matches the Activity (see App.ts for why
  // window.confirm() can't be used there).
  endStreamButton.addEventListener("click", () => {
    const stream = currentStream();
    if (!stream) return;
    wsClient.sendControl({ kind: "request-stop-presenting", slot: stream.slot });
  });

  videoToggleButton.addEventListener("click", () => void toggleVideoDisabled());

  async function toggleVideoDisabled(): Promise<void> {
    videoDisabled = !videoDisabled;
    wsClient.sendControl({ kind: "set-video-enabled", enabled: !videoDisabled });
    render();
    if (videoDisabled) {
      teardownVideoPipeline();
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    } else {
      await ensureVideoPipeline();
    }
  }

  // --- Volume / mute ---
  volumeSlider.addEventListener("input", () => {
    const volume = Number(volumeSlider.value) / 100;
    syncVolumeFill();
    audioDecodePipeline?.setVolume(volume);
    syncMuteButton();
    if (volume > 0) lastVolumeBeforeMute = volume;
  });

  /** The slider's value is a percentage up to MAX_VOLUME * 100; its fill spans the whole track. */
  function syncVolumeFill(): void {
    volumeSlider.style.setProperty("--fill", `${Number(volumeSlider.value) / MAX_VOLUME}%`);
    volumeSlider.title = `Volume: ${volumeSlider.value}%`;
  }

  /** Muted icon while there's no sound to hear; flagged "off" only when the user muted it. */
  function syncMuteButton(): void {
    const isMuted = Number(volumeSlider.value) === 0;
    muteButton.innerHTML = muteButton.disabled || isMuted ? ICON_MUTED : ICON_VOLUME;
    muteButton.classList.toggle("is-off", !muteButton.disabled && isMuted);
  }

  muteButton.addEventListener("click", () => {
    const isMuted = Number(volumeSlider.value) === 0;
    const nextVolume = isMuted ? lastVolumeBeforeMute : 0;
    volumeSlider.value = String(Math.round(nextVolume * 100));
    syncVolumeFill();
    audioDecodePipeline?.setVolume(nextVolume);
    syncMuteButton();
  });

  // --- Real fullscreen (this page isn't sandboxed inside Discord's iframe) ---
  fullscreenButton.addEventListener("click", () => void toggleFullscreen());

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await player.requestFullscreen();
      }
    } catch (error) {
      console.error("Fullscreen toggle failed:", error);
    }
  }

  function onFullscreenChange(): void {
    fullscreenButton.innerHTML = document.fullscreenElement ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN_ENTER;
    player.classList.toggle("is-fullscreen", Boolean(document.fullscreenElement));
  }

  // Escape dismisses the list; fullscreen already handles its own Escape natively.
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && broadcastsPanel.isOpen) broadcastsPanel.close();
  }

  // --- Resync after being backgrounded (see App.ts for the full rationale) ---
  function resyncToLive(): void {
    videoDecodePipeline?.resyncToLive();
    if (isWatching()) wsClient.sendControl({ kind: "request-keyframe" });
  }
  function onVisibilityChange(): void {
    if (document.visibilityState === "visible") resyncToLive();
  }

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", resyncToLive);

  wsClient.connect();

  return {
    openBroadcast,
    stopWatching,
    requestBroadcasts: () => wsClient.sendControl({ kind: "request-active-broadcasts" }),
    destroy() {
      wsClient.close();
      teardownVideoPipeline();
      audioDecodePipeline?.stop();
      audioDecodePipeline = null;
      broadcastsPanel.close();
      qualityMenu.close();
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", resyncToLive);
      root.innerHTML = "";
    },
  };
}
