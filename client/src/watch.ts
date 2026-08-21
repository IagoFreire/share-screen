// See main.ts: the stylesheet is imported from JS so Discord's proxy can't pin a
// stale copy of a never-changing stylesheet URL.
import "./ui/app.css";
import {
  FrameType,
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
  ICON_END_STREAM,
  ICON_FULLSCREEN_ENTER,
  ICON_FULLSCREEN_EXIT,
  ICON_IDLE,
  ICON_MUTED,
  ICON_VIDEO,
  ICON_VIDEO_OFF,
  ICON_VOLUME,
} from "./ui/icons.js";

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

  const roomId = getParam("room");
  const userId = getParam("user") ?? "";
  const guildId = getParam("guild");
  if (!roomId) {
    setPageStatus('Link invalido: falta o parametro "?room=...". Abra esta pagina pelo botao "Assistir numa aba do navegador" dentro da Activity.');
    return;
  }

  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app root element not found.");

  document.body.classList.add("viewer");

  root.innerHTML = `
    <div class="player" id="player">
      <canvas id="viewer-canvas"></canvas>
      <div class="stream-picker" id="stream-picker" role="tablist" aria-label="Escolher transmissão"></div>
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
  const streamPicker = root.querySelector<HTMLDivElement>("#stream-picker")!;

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

    renderStreamPicker();

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
    endStreamButton.style.display = isAdmin && hasPresenter() && !isSelf() ? "" : "none";

    videoToggleButton.disabled = isPausedHere || !hasPresenter();
    videoToggleButton.innerHTML = videoDisabled ? ICON_VIDEO_OFF : ICON_VIDEO;
    videoToggleButton.title = videoDisabled ? "Ativar vídeo" : "Desativar vídeo (somente áudio)";
  }

  /** Tabs for picking which broadcast to watch -- see App.ts for the rationale. */
  function renderStreamPicker(): void {
    if (streams.length < 2) {
      streamPicker.style.display = "none";
      streamPicker.replaceChildren();
      return;
    }
    streamPicker.style.display = "";

    streamPicker.replaceChildren(
      ...streams.map((stream, index) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "stream-tab";
        tab.setAttribute("role", "tab");
        const isSelected = stream.slot === selectedSlot;
        tab.classList.toggle("is-active", isSelected);
        tab.setAttribute("aria-selected", String(isSelected));
        tab.textContent =
          userId !== "" && stream.presenterId === userId ? "Sua transmissão" : `Transmissão ${index + 1}`;
        tab.addEventListener("click", () => void selectStream(stream.slot));
        return tab;
      }),
    );
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
        isAdmin = message.isAdmin;
        viewerCount = message.viewerCount;
        streams = message.streams;
        // Mirror the server's choice of default slot for a fresh connection.
        selectedSlot = streams[0]?.slot ?? 0;
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

      case "streams-changed": {
        streams = message.streams;
        // The watched stream may have ended; the server already moved this connection
        // to a surviving slot, so follow it instead of receiving nothing.
        if (!currentStream()) selectedSlot = streams[0]?.slot ?? selectedSlot;
        lastAudioParams = audioParamsForSelection();
        render();
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
        return;

      case "error":
        setPageStatus(`Erro: ${message.message}`);
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

  endStreamButton.addEventListener("click", () => {
    const stream = currentStream();
    if (!stream) return;
    if (!window.confirm("Encerrar a transmissão desta pessoa?")) return;
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
