import {
  FrameType,
  MAX_PRESENTERS_PER_ROOM,
  type AudioParams,
  type ControlMessage,
  type EncodedFrame,
  type StreamInfo,
} from "@screenshare-bot/shared";
import { WsClient } from "../net/wsClient.js";
import { startVideoDecodePipeline, type VideoDecodePipeline } from "../playback/videoDecodePipeline.js";
import { startAudioDecodePipeline, type AudioDecodePipeline } from "../playback/audioDecodePipeline.js";
import { createMediaClock } from "../playback/mediaClock.js";
import { getDiscordSdk } from "../discord/sdkBootstrap.js";
import {
  ICON_FULLSCREEN_ENTER,
  ICON_FULLSCREEN_EXIT,
  ICON_IDLE,
  ICON_MUTED,
  ICON_OPEN_EXTERNAL,
  ICON_SHARE,
  ICON_STOP,
  ICON_VIDEO,
  ICON_VIDEO_OFF,
  ICON_VOLUME,
} from "./icons.js";

export interface MountAppOptions {
  roomId: string;
  wsUrl: string;
  /** Discord user id of the local viewer; used to recognise their own broadcast. */
  userId: string;
  /** Forwarded to the server for the optional voice-channel membership check, and to
   *  the presenter tab so its own "join" can pass the same check. */
  guildId: string | null;
  setStatus: (text: string) => void;
}

/**
 * Wires the WS client and decode/render pipelines for the Activity itself (runs
 * inside Discord's iframe). Screen capture does NOT happen here: Discord's iframe
 * Permissions-Policy blocks getDisplayMedia() ("display-capture" is denied), so
 * "Compartilhar tela" opens present.html in a real browser tab instead (via
 * discordSdk.commands.openExternalLink()), where capture/encode actually runs.
 */
export function mountApp(options: MountAppOptions): void {
  const { roomId, wsUrl, userId, guildId, setStatus: setPageStatus } = options;

  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app root element not found.");

  // Opts this page into the fixed-height, non-scrolling viewer layout (see app.css).
  // present.html shares the stylesheet but keeps normal document flow/scrolling.
  document.body.classList.add("viewer");

  root.innerHTML = `
    <div class="player" id="player">
      <canvas id="viewer-canvas"></canvas>
      <div class="stream-picker" id="stream-picker" role="tablist" aria-label="Escolher transmissão"></div>
      <div class="idle-screen" id="idle-screen">
        <div class="idle-icon">${ICON_IDLE}</div>
        <p class="idle-title" id="idle-title">Ninguém está transmitindo</p>
        <p class="idle-subtitle" id="idle-subtitle">Clique em “Compartilhar tela” para começar a transmitir.</p>
        <button id="resume-btn" class="btn-share" type="button" style="display: none">Retomar aqui</button>
      </div>
      <div class="controls-zone">
        <div class="overlay-bar">
          <button id="share-btn" class="btn-share" type="button">${ICON_SHARE}<span>Compartilhar tela</span></button>
          <span id="status-text" class="status-text"></span>
          <div class="spacer"></div>
          <button id="video-toggle-btn" class="icon-btn" type="button" title="Desativar vídeo (somente áudio)">${ICON_VIDEO}</button>
          <div class="volume-group">
            <button id="mute-btn" class="icon-btn" type="button" title="Mudo">${ICON_VOLUME}</button>
            <input id="volume-slider" class="volume-slider" type="range" min="0" max="100" value="100" style="--fill: 100%" />
          </div>
          <button id="watch-external-btn" class="icon-btn" type="button" title="Assistir numa aba do navegador">${ICON_OPEN_EXTERNAL}</button>
          <button id="fullscreen-btn" class="icon-btn" type="button" title="Tela cheia">${ICON_FULLSCREEN_ENTER}</button>
        </div>
      </div>
    </div>
  `;

  const player = root.querySelector<HTMLDivElement>("#player")!;
  const shareButton = root.querySelector<HTMLButtonElement>("#share-btn")!;
  const statusText = root.querySelector<HTMLSpanElement>("#status-text")!;
  const videoToggleButton = root.querySelector<HTMLButtonElement>("#video-toggle-btn")!;
  const muteButton = root.querySelector<HTMLButtonElement>("#mute-btn")!;
  const volumeSlider = root.querySelector<HTMLInputElement>("#volume-slider")!;
  const watchExternalButton = root.querySelector<HTMLButtonElement>("#watch-external-btn")!;
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
  /** Which of them this viewer is receiving -- exactly one at a time. */
  let selectedSlot = 0;
  let lastVolumeBeforeMute = 1;
  let isPseudoFullscreen = false;
  /** True while the server has paused this connection because the same user opened
   *  another tab already receiving the stream (see watchExternalButton/presentTab). */
  let isPausedHere = false;
  /** True while this viewer chose to stop receiving video (audio-only, e.g. to listen
   *  along to music without watching). Purely a local preference sent to the server. */
  let videoDisabled = false;
  /**
   * Bumped by every call that decides what the video pipeline should be (join, resume,
   * toggle). `startVideoDecodePipeline()` is async (it awaits `isConfigSupported()`), so
   * two calls can race -- e.g. two quick clicks of the toggle button, or a toggle racing
   * a reconnect's "joined". Whichever call's generation is no longer current when its
   * await resolves lost the race and must stop the pipeline it just built instead of
   * assigning it, or that decoder and its render loop would leak forever.
   */
  let videoPipelineGeneration = 0;

  /** The broadcast currently being received, if it's still live. */
  const currentStream = (): StreamInfo | undefined => streams.find((s) => s.slot === selectedSlot);
  /** True when *this user* is broadcasting, on any slot -- drives the share/stop button. */
  const isPresenting = () => streams.some((s) => s.presenterId !== null && s.presenterId === userId);
  /** True when the stream being watched is this user's own, which is what decides
   *  whether audio must be suppressed (hearing yourself back) -- distinct from
   *  isPresenting(), since you can broadcast while watching someone else. */
  const isWatchingSelf = () => {
    const stream = currentStream();
    return stream?.presenterId !== null && stream?.presenterId === userId;
  };
  const hasPresenter = () => streams.length > 0;
  const audioParamsForSelection = () => currentStream()?.audio ?? null;

  /** Single place that reflects presenter state into the button, status line and idle screen. */
  function render(): void {
    const presenting = isPresenting();

    shareButton.innerHTML = presenting
      ? `${ICON_STOP}<span>Parar transmissão</span>`
      : `${ICON_SHARE}<span>Compartilhar tela</span>`;
    shareButton.classList.toggle("is-stop", presenting);

    // Every slot is taken by someone else: the server would reject another broadcast,
    // so surface that here instead of opening a tab that fails.
    const roomFull = streams.length >= MAX_PRESENTERS_PER_ROOM && !presenting;
    shareButton.disabled = roomFull;
    shareButton.title = roomFull
      ? `Limite de ${MAX_PRESENTERS_PER_ROOM} transmissões simultâneas atingido.`
      : "";

    if (presenting) {
      statusText.textContent = `Você está transmitindo — ${viewerCount} espectador(es).`;
    } else if (streams.length > 1) {
      statusText.textContent = `${streams.length} transmissões — ${viewerCount} espectador(es).`;
    } else if (hasPresenter()) {
      statusText.textContent = `Alguém está transmitindo — ${viewerCount} espectador(es).`;
    } else {
      statusText.textContent = `${viewerCount} pessoa(s) na sala.`;
    }

    renderStreamPicker();

    // Being paused only matters visibly once there's actually a broadcast it's saving
    // bandwidth on -- with no presenter nothing was going to be sent either way, so
    // showing "paused" then would just be confusing for no benefit. Shown even while
    // presenting (presenting's own present.html join pauses this same connection): the
    // player would otherwise be a blank void with no video and no explanation, since
    // the Activity never renders your own broadcast back to you.
    const showPausedUi = isPausedHere && hasPresenter();
    // Audio-only is its own idle-screen state, one rung below "paused" in priority --
    // there's no video pipeline running so the canvas would otherwise just be a blank
    // void, same reasoning as the paused case above. Keyed off which stream is being
    // *watched*, not whether you're broadcasting: your own feed never plays its audio
    // back (see ensureAudioPipeline), so "audio-only" would be a lie for it --
    // showVideoOffSelfUi covers that case instead.
    const watchingSelf = isWatchingSelf();
    const showAudioOnlyUi = !showPausedUi && !watchingSelf && hasPresenter() && videoDisabled;
    // Watching your own broadcast doesn't block video the way it blocks audio: once
    // you hit "Retomar aqui" your Activity connection is a live viewer of your own
    // broadcast (see the resume-viewing handler on the server), so the video toggle is
    // just as real here as for any other viewer -- it just can't be framed as
    // "audio-only" since there's never any audio to fall back to for yourself.
    const showVideoOffSelfUi = !showPausedUi && watchingSelf && videoDisabled;
    const showIdleScreen = !hasPresenter() || showPausedUi || showAudioOnlyUi || showVideoOffSelfUi;
    idleScreen.classList.toggle("is-hidden", !showIdleScreen);

    // Driven by an inline style rather than the .is-hidden class on purpose: the class
    // relies on `#resume-btn.is-hidden { display: none }` outranking `.btn-share`'s
    // `display: inline-flex`, and the button was still showing in the Activity even
    // when the class was correctly applied. An inline style beats every stylesheet rule
    // regardless of specificity, so visibility can't be overridden by CSS at all.
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
      idleSubtitle.textContent = "Clique em “Compartilhar tela” para começar a transmitir.";
    }

    // The presenter never gets their own audio decoded (see ensureAudioPipeline), and a
    // paused connection has no pipeline running at all -- either way there's nothing
    // for these controls to adjust, so show muted and lock them rather than leaving a
    // volume slider that visibly does nothing.
    const controlsDisabled = watchingSelf || isPausedHere;
    muteButton.disabled = controlsDisabled;
    volumeSlider.disabled = controlsDisabled;
    muteButton.innerHTML = controlsDisabled || Number(volumeSlider.value) === 0 ? ICON_MUTED : ICON_VOLUME;

    // Unlike mute/volume, video isn't blocked while presenting -- once resumed (see
    // showVideoOffSelfUi above) your Activity connection genuinely has a video pipeline
    // decoding your own broadcast, so the toggle stays live for it. Only actually being
    // paused (or having no presenter at all) means there's no pipeline to toggle.
    videoToggleButton.disabled = isPausedHere || !hasPresenter();
    videoToggleButton.innerHTML = videoDisabled ? ICON_VIDEO_OFF : ICON_VIDEO;
    videoToggleButton.title = videoDisabled ? "Ativar vídeo" : "Desativar vídeo (somente áudio)";
  }

  /**
   * Tabs for picking which broadcast to watch. Hidden entirely with fewer than two, so
   * the common single-broadcast case looks exactly as it did before this existed.
   */
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
        // No display names available here -- the Activity only ever learns user ids --
        // so identify the broadcaster by position, with "você" for your own.
        tab.textContent =
          stream.presenterId !== null && stream.presenterId === userId
            ? "Sua transmissão"
            : `Transmissão ${index + 1}`;
        tab.addEventListener("click", () => void selectStream(stream.slot));
        return tab;
      }),
    );
  }

  /**
   * Switches which broadcast is received. The server stops sending the old one the
   * moment it processes this, so the decoders have to be rebuilt: the new stream's
   * video decoder starts cold (needs a keyframe) and its audio may well have different
   * Opus parameters, which an AudioDecoder can't be reconfigured into mid-flight.
   */
  async function selectStream(slot: number): Promise<void> {
    if (slot === selectedSlot) return;
    selectedSlot = slot;
    wsClient.sendControl({ kind: "select-stream", slot });

    teardownVideoPipeline();
    clearCanvas();
    render();

    await ensureVideoPipeline();
    ensureAudioPipeline(audioParamsForSelection());
    wsClient.sendControl({ kind: "request-keyframe" });
  }

  const wsClient = new WsClient(wsUrl, {
    onOpen: () => {
      setPageStatus("Conectado. Entrando na sala...");
      wsClient.sendControl({ kind: "join", roomId, userId, guildId });
    },
    onClose: () => setPageStatus("Desconectado. Tentando reconectar..."),
    onControl: (message) => void handleControl(message),
    onFrame: (frame) => handleFrame(frame),
  });

  async function handleControl(message: ControlMessage): Promise<void> {
    switch (message.kind) {
      case "joined":
        // A "joined" always means the server just created a brand-new, unpaused
        // ConnectionState for this socket -- including after a silent WS reconnect
        // (e.g. Discord suspending a backgrounded Activity's network access). Without
        // resetting this here, a pause flag left over from before the reconnect would
        // stick client-side forever even though the server has no idea this connection
        // was ever paused, permanently showing "Retomar aqui" over a feed that's
        // actually flowing fine.
        isPausedHere = false;
        viewerCount = message.viewerCount;
        streams = message.streams;
        // The server picks the lowest live slot for a fresh connection; mirror that so
        // the client doesn't ask for a stream it isn't actually being sent.
        selectedSlot = streams[0]?.slot ?? 0;
        lastAudioParams = audioParamsForSelection();
        render();
        setPageStatus("");
        void ensureVideoPipeline();
        ensureAudioPipeline(lastAudioParams);
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
        // The stream being watched may have just ended. The server already moved this
        // connection to a surviving slot (see handleSlotWentAway), so follow it rather
        // than sitting on a slot that no longer exists and receiving nothing.
        if (!currentStream()) selectedSlot = streams[0]?.slot ?? selectedSlot;
        lastAudioParams = audioParamsForSelection();
        render();
        if (!isPausedHere) {
          ensureAudioPipeline(lastAudioParams);
          if (hasPresenter()) {
            wsClient.sendControl({ kind: "request-keyframe" });
          } else {
            // Everything ended: drop the last decoded frame so the idle screen isn't
            // layered over a frozen still of whatever was on screen when it stopped.
            clearCanvas();
          }
        }
        return;
      }

      // Another tab for this same user (present.html/watch.html) is now receiving the
      // stream -- tear down our own pipelines so it isn't sent to us twice.
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
        ensureAudioPipeline(lastAudioParams);
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

  /**
   * (Re)builds the audio decoder to match the presenter's actual Opus parameters.
   * An AudioDecoder can't be reconfigured to a different channel count/sample rate
   * mid-flight, so a change means tearing the old one down. `null` means the current
   * broadcast has no audio (the presenter didn't share any).
   */
  function ensureAudioPipeline(params: AudioParams | null): void {
    // Never play back your own broadcast: the presenter has the Activity open too, so
    // decoding their own audio here feeds it straight back out of their speakers. Keyed
    // on the stream being *watched*, not on whether you're broadcasting -- while
    // broadcasting you can be watching someone else, and their audio must still play.
    if (isWatchingSelf()) params = null;

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

  function clearCanvas(): void {
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
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

  shareButton.addEventListener("click", () => {
    if (isPresenting()) {
      // The capture lives in the presenter tab, so the server relays this to it.
      wsClient.sendControl({ kind: "request-stop-presenting" });
    } else {
      void openPresenterTab();
    }
  });

  async function openPresenterTab(): Promise<void> {
    const params = new URLSearchParams({ room: roomId, user: userId });
    if (guildId) params.set("guild", guildId);
    const presentUrl = `${window.location.origin}/present.html?${params.toString()}`;
    try {
      const { opened } = await getDiscordSdk().commands.openExternalLink({ url: presentUrl });
      if (opened === false) {
        setPageStatus("O Discord bloqueou a abertura da aba. Veja o console para o link.");
        console.warn("openExternalLink recusado; abra manualmente:", presentUrl);
      }
    } catch (error) {
      console.error("Failed to open presenter tab:", error, presentUrl);
      setPageStatus("Não foi possível abrir a aba de compartilhamento. Veja o console para o link.");
    }
  }

  resumeButton.addEventListener("click", () => {
    wsClient.sendControl({ kind: "resume-viewing" });
  });

  videoToggleButton.addEventListener("click", () => void toggleVideoDisabled());

  async function toggleVideoDisabled(): Promise<void> {
    videoDisabled = !videoDisabled;
    wsClient.sendControl({ kind: "set-video-enabled", enabled: !videoDisabled });
    render();
    if (videoDisabled) {
      teardownVideoPipeline();
      clearCanvas();
    } else {
      await ensureVideoPipeline();
    }
  }

  watchExternalButton.addEventListener("click", () => void openWatchTab());

  async function openWatchTab(): Promise<void> {
    const params = new URLSearchParams({ room: roomId, user: userId });
    if (guildId) params.set("guild", guildId);
    const watchUrl = `${window.location.origin}/watch.html?${params.toString()}`;
    try {
      const { opened } = await getDiscordSdk().commands.openExternalLink({ url: watchUrl });
      if (opened === false) {
        setPageStatus("O Discord bloqueou a abertura da aba. Veja o console para o link.");
        console.warn("openExternalLink recusado; abra manualmente:", watchUrl);
      }
    } catch (error) {
      console.error("Failed to open watch tab:", error, watchUrl);
      setPageStatus("Não foi possível abrir a aba de assistir. Veja o console para o link.");
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

  // --- "Fullscreen" ---
  // Discord's Activity iframe blocks the real Fullscreen API (same Permissions-Policy
  // issue as display-capture), so this maximizes the player over the whole iframe
  // viewport via CSS instead of requestFullscreen() -- it can't grow past whatever
  // panel size Discord itself has allocated for the Activity, but it does reclaim
  // every pixel of that space. Discord's own client also offers a way to enlarge the
  // Activity panel itself (drag-resize / a maximize control in Discord's UI chrome).
  fullscreenButton.addEventListener("click", () => {
    isPseudoFullscreen = !isPseudoFullscreen;
    player.classList.toggle("is-fullscreen", isPseudoFullscreen);
    document.body.classList.toggle("no-scroll", isPseudoFullscreen);
    fullscreenButton.innerHTML = isPseudoFullscreen ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN_ENTER;
    fullscreenButton.title = isPseudoFullscreen ? "Sair da tela cheia" : "Tela cheia";
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isPseudoFullscreen) fullscreenButton.click();
  });

  // Browsers keep receiving/decoding video in a backgrounded tab while throttling
  // rendering, so a long alt-tab away builds up a backlog that would otherwise play
  // back in fast-forward once visible again. Snap straight to live instead: drop what
  // built up and ask the presenter for a fresh keyframe to resume cleanly on.
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
