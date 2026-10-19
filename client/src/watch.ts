// See main.ts: the stylesheet is imported from JS so Discord's proxy can't pin a
// stale copy of a never-changing stylesheet URL.
import "./ui/app.css";
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
import { startAudioDecodePipeline, type AudioDecodePipeline } from "./playback/audioDecodePipeline.js";
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

/** Lockout after the "ao vivo" button -- see App.ts. */
const JUMP_TO_LIVE_COOLDOWN_MS = 1500;

/**
 * Entry point for watch.html -- a plain browser tab opened from inside the Activity
 * (via App.ts's "assistir numa aba do navegador" button) for watching a broadcast
 * outside Discord's iframe. Unlike the Activity, this page is NOT sandboxed, so the
 * real Fullscreen API works here instead of the CSS-only pseudo-fullscreen App.ts has
 * to fall back to. Read-only: this page never captures or presents.
 */

function getParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function main(): void {
  const statusEl = document.querySelector<HTMLParagraphElement>("#status");
  const setPageStatus = (text: string) => {
    if (statusEl) statusEl.textContent = text;
  };

  const initialRoomId = getParam("room");
  const userId = getParam("user") ?? "";
  if (!initialRoomId) {
    setPageStatus('Link invalido: falta o parametro "?room=...". Abra esta pagina pelo botao "Assistir numa aba do navegador" dentro da Activity.');
    return;
  }
  /**
   * The room being watched. An admin can hop to another room from the broadcast list
   * (see openBroadcast), so it isn't fixed for the page's lifetime.
   */
  let roomId: string = initialRoomId;
  let guildId = getParam("guild");
  /** Slot to select once a hop's "joined" lands; see openBroadcast. */
  let pendingSlot: number | null = null;
  /** The room a hop left, to go back to if the server refuses it -- see App.ts. */
  let hopFrom: { roomId: string; guildId: string | null } | null = null;

  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app root element not found.");

  document.body.classList.add("viewer");

  root.innerHTML = `
    <div class="player" id="player">
      <canvas id="viewer-canvas"></canvas>
      ${BROADCASTS_PANEL_HTML}
      <div class="idle-screen" id="idle-screen">
        <div class="idle-icon">${ICON_IDLE}</div>
        <p class="idle-title" id="idle-title">Ninguém está transmitindo</p>
        <p class="idle-subtitle" id="idle-subtitle">Assim que alguém compartilhar a tela na call, aparece aqui.</p>
        <button id="resume-btn" class="btn-primary" type="button" style="display: none">Retomar aqui</button>
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
            <input id="volume-slider" class="volume-slider" type="range" min="0" max="100" value="100" style="--fill: 100%" />
          </div>
          <button id="fullscreen-btn" class="icon-btn" type="button" title="Tela cheia">${ICON_FULLSCREEN_ENTER}</button>
        </div>
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
  const liveButton = root.querySelector<HTMLButtonElement>("#live-btn")!;
  const broadcastsButton = root.querySelector<HTMLButtonElement>("#broadcasts-btn")!;

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
  /** Which of them this tab is receiving -- exactly one at a time. */
  let selectedSlot = 0;
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
  const audioParamsForSelection = () => currentStream()?.audio ?? null;

  function render(): void {
    if (streams.length > 1) {
      statusText.textContent = `${streams.length} transmissões — ${viewerCount} espectador(es).`;
    } else if (hasPresenter()) {
      statusText.textContent = isSelf()
        ? `Sua transmissão — ${viewerCount} espectador(es).`
        : `Alguém está transmitindo — ${viewerCount} espectador(es).`;
    } else {
      statusText.textContent = `${viewerCount} pessoa(s) na sala.`;
    }

    // The broadcast list is how everyone picks what to watch (see ui/broadcastsPanel.ts).
    const showBroadcastsButton = syncBroadcastsButton(broadcastsButton, {
      isAdmin,
      streamCount: streams.length,
      isOpen: broadcastsPanel.isOpen,
    });
    if (!showBroadcastsButton) broadcastsPanel.close();

    // Being paused only matters visibly once there's actually a broadcast it's saving
    // bandwidth on -- with no presenter nothing was going to be sent either way, so
    // showing "paused" then would just be confusing for no benefit. Shown even when
    // watching your own broadcast: this tab would otherwise be a blank void with no
    // video and no explanation, since it never renders your own broadcast back to you.
    const showPausedUi = isPausedHere && hasPresenter();
    // Audio-only is its own idle-screen state, one rung below "paused" -- see App.ts.
    const showAudioOnlyUi = !showPausedUi && !isSelf() && hasPresenter() && videoDisabled;
    // Watching your own broadcast doesn't block video the way it blocks audio -- once
    // resumed this connection genuinely decodes your own stream, so the toggle is just
    // as real here as for any other viewer (just never paired with audio -- see App.ts).
    const showVideoOffSelfUi = !showPausedUi && isSelf() && videoDisabled;
    const showIdleScreen = !hasPresenter() || showPausedUi || showAudioOnlyUi || showVideoOffSelfUi;
    idleScreen.classList.toggle("is-hidden", !showIdleScreen);

    // Inline style rather than a CSS class -- see App.ts for why (an inline style can't
    // be outranked by any stylesheet rule).
    resumeButton.style.display = showPausedUi ? "" : "none";

    if (showPausedUi) {
      idleTitle.textContent = "Pausado para economizar banda";
      idleSubtitle.textContent = "Você está conectado em outra aba.";
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

    const controlsDisabled = isSelf() || isPausedHere;
    muteButton.disabled = controlsDisabled;
    volumeSlider.disabled = controlsDisabled;
    muteButton.innerHTML = controlsDisabled || Number(volumeSlider.value) === 0 ? ICON_MUTED : ICON_VOLUME;

    // Unlike audio, video isn't blocked while watching your own broadcast -- see
    // showVideoOffSelfUi above. Only actually being paused (or no presenter) means
    // there's no pipeline to toggle.
    // Admin-only, and never for your own broadcast -- see App.ts.
    const canModerateStream = isAdmin && hasPresenter() && !isSelf();
    alertButton.style.display = canModerateStream ? "" : "none";
    endStreamButton.style.display = canModerateStream ? "" : "none";

    videoToggleButton.disabled = isPausedHere || !hasPresenter();
    videoToggleButton.innerHTML = videoDisabled ? ICON_VIDEO_OFF : ICON_VIDEO;
    videoToggleButton.title = videoDisabled ? "Ativar vídeo" : "Desativar vídeo (somente áudio)";

    // Only offered while there's a video pipeline to refresh (see jumpToLive).
    liveButton.style.display = hasPresenter() && !isPausedHere && !videoDisabled ? "" : "none";
  }

  /** Switches which broadcast is received -- see App.ts for why both pipelines restart. */
  async function selectStream(slot: number): Promise<void> {
    if (slot === selectedSlot) return;
    selectedSlot = slot;
    wsClient.sendControl({ kind: "select-stream", slot });

    teardownVideoPipeline();
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    render();

    await ensureVideoPipeline();
    void ensureAudioPipeline(audioParamsForSelection());
    wsClient.sendControl({ kind: "request-keyframe" });
  }

  /**
   * Opens a broadcast picked from the list, hopping rooms when it lives elsewhere --
   * only an admin's list ever offers another room. Mirrors App.ts's openBroadcast: the
   * same socket re-joins, and the slot is selected once that join lands (pendingSlot).
   */
  async function openBroadcast(broadcast: ActiveBroadcast): Promise<void> {
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

    wsClient.sendControl({ kind: "join", roomId, userId: userId || null, guildId });
  }

  /** Goes back to the room a refused hop left -- see App.ts's returnFromFailedHop. */
  function returnFromFailedHop(): void {
    if (!hopFrom) return;
    ({ roomId, guildId } = hopFrom);
    hopFrom = null;
    pendingSlot = null;
    syncAddressToRoom();
    wsClient.sendControl({ kind: "join", roomId, userId: userId || null, guildId });
  }

  /** Keeps the address in step, so reloading this tab stays on the room now on screen. */
  function syncAddressToRoom(): void {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    if (guildId) url.searchParams.set("guild", guildId);
    else url.searchParams.delete("guild");
    history.replaceState(null, "", url);
  }

  /** "Atualizar": restarts the picture from a fresh keyframe -- see App.ts's jumpToLive. */
  async function jumpToLive(): Promise<void> {
    if (!hasPresenter() || isPausedHere || videoDisabled) return;
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

  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${window.location.host}/ws`;

  const wsClient = new WsClient(wsUrl, {
    onOpen: () => {
      setPageStatus("Conectado. Entrando na sala...");
      wsClient.sendControl({ kind: "join", roomId, userId: userId || null, guildId });
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
    if (videoDisabled || videoDecodePipeline) return;
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
        // Mirror the server's choice of default slot for a fresh connection -- unless this
        // join is a hop from the broadcast list, whose whole point was one specific slot.
        selectedSlot = streams[0]?.slot ?? 0;
        if (pendingSlot !== null) {
          const wanted = streams.find((s) => s.slot === pendingSlot);
          if (wanted) {
            selectedSlot = wanted.slot;
            wsClient.sendControl({ kind: "select-stream", slot: wanted.slot });
          }
          pendingSlot = null;
        }
        lastAudioParams = audioParamsForSelection();
        render();
        setPageStatus("");
        void ensureVideoPipeline();
        void ensureAudioPipeline(lastAudioParams);
        // The server always starts a fresh connection with video enabled -- tell it
        // about a still-active local preference carried over from before this (re)join.
        if (videoDisabled) wsClient.sendControl({ kind: "set-video-enabled", enabled: false });
        wsClient.sendControl({ kind: "request-keyframe" });
        return;

      case "viewer-count":
        viewerCount = message.count;
        render();
        return;

      case "active-broadcasts":
        broadcastsPanel.show(message.broadcasts);
        return;

      case "streams-changed": {
        streams = message.streams;
        // The watched stream may have ended; the server already moved this connection
        // to a surviving slot, so follow it instead of receiving nothing.
        if (!currentStream()) selectedSlot = streams[0]?.slot ?? selectedSlot;
        lastAudioParams = audioParamsForSelection();
        render();
        // Refresh an open list now rather than on the next poll, so it never offers a
        // broadcast that has already ended.
        broadcastsPanel.refresh();
        if (!isPausedHere) {
          void ensureAudioPipeline(lastAudioParams);
          if (hasPresenter()) wsClient.sendControl({ kind: "request-keyframe" });
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
        if (hasPresenter()) wsClient.sendControl({ kind: "request-keyframe" });
        return;

      case "room-full":
        setPageStatus("Sala cheia - não foi possível entrar.");
        returnFromFailedHop();
        return;

      case "error":
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
    volumeSlider.style.setProperty("--fill", `${volumeSlider.value}%`);
    audioDecodePipeline?.setVolume(volume);
    muteButton.innerHTML = volume === 0 ? ICON_MUTED : ICON_VOLUME;
    if (volume > 0) lastVolumeBeforeMute = volume;
  });

  muteButton.addEventListener("click", () => {
    const isMuted = Number(volumeSlider.value) === 0;
    const nextVolume = isMuted ? lastVolumeBeforeMute : 0;
    volumeSlider.value = String(Math.round(nextVolume * 100));
    volumeSlider.style.setProperty("--fill", `${volumeSlider.value}%`);
    audioDecodePipeline?.setVolume(nextVolume);
    muteButton.innerHTML = nextVolume === 0 ? ICON_MUTED : ICON_VOLUME;
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

  document.addEventListener("fullscreenchange", () => {
    fullscreenButton.innerHTML = document.fullscreenElement ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN_ENTER;
    player.classList.toggle("is-fullscreen", Boolean(document.fullscreenElement));
  });

  // Escape dismisses the list; fullscreen already handles its own Escape natively.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && broadcastsPanel.isOpen) broadcastsPanel.close();
  });

  // --- Resync after being backgrounded (see App.ts for the full rationale) ---
  function resyncToLive(): void {
    videoDecodePipeline?.resyncToLive();
    if (hasPresenter()) wsClient.sendControl({ kind: "request-keyframe" });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resyncToLive();
  });
  window.addEventListener("focus", resyncToLive);

  wsClient.connect();
}

main();
