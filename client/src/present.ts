// See main.ts: the stylesheet is imported from JS so Discord's proxy can't pin a
// stale copy of a never-changing stylesheet URL.
import "./ui/app.css";
// Imported rather than referenced by path from public/: Vite fingerprints the emitted
// filename, so a changed sound can never be masked by Discord's proxy serving a cached
// copy of a stable URL -- the same trap that bit the stylesheet earlier in this project.
import doorKnockUrl from "../assets/DoorKnock.mp3";
import {
  buildQualityPreset,
  FrameType,
  SLOT_PRESENTER,
  type BitrateLevelKey,
  type ControlMessage,
  type FramerateKey,
  type QualityPreset,
  type ResolutionKey,
  type RtcSignalPayload,
} from "@screenshare-bot/shared";
import { WsClient } from "./net/wsClient.js";
import { createPeer, iceServers, supportsWebRtc, tuneVideoSender } from "./net/rtc.js";
import { startScreenCapture } from "./capture/screenCapture.js";
import { startVideoEncodePipeline, type VideoEncodePipeline } from "./capture/videoEncodePipeline.js";
import { startAudioEncodePipeline, type AudioEncodePipeline } from "./capture/audioEncodePipeline.js";

/**
 * Entry point for present.html -- a plain page opened in a normal browser tab
 * (via discordSdk.commands.openExternalLink() from inside the Activity), never
 * loaded inside Discord's iframe. Screen capture only works here: Discord's
 * Activity iframe denies the "display-capture" Permissions-Policy, so
 * getDisplayMedia() always throws NotAllowedError inside index.html.
 */

const ICON_SCREEN = `<svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`;

const QUALITY_STORAGE_KEY = "screenshare-bot:quality";

function getRoomId(): string | null {
  return new URLSearchParams(window.location.search).get("room");
}

/** Discord user id, forwarded by the Activity when it opens this tab. */
function getUserId(): string | null {
  return new URLSearchParams(window.location.search).get("user");
}

/** Discord guild id, forwarded so this tab's own "join" passes the same optional
 *  voice-membership check as the Activity's. */
function getGuildId(): string | null {
  return new URLSearchParams(window.location.search).get("guild");
}

function main(): void {
  const statusEl = document.querySelector<HTMLParagraphElement>("#status");
  const setStatus = (text: string) => {
    if (statusEl) statusEl.textContent = text;
  };

  const roomId = getRoomId();
  if (!roomId) {
    setStatus('Link invalido: falta o parametro "?room=...". Abra esta pagina pelo botao "Compartilhar tela" dentro da Activity.');
    return;
  }

  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app root element not found.");

  root.innerHTML = `
    <div class="present-card">
      <div class="present-icon">${ICON_SCREEN}</div>
      <h1 class="present-title">Compartilhar sua tela</h1>
      <p class="present-lead">
        A transmissão aparece para todos que abrirem a atividade no canal de voz.
        Você pode deixar esta aba em segundo plano depois de começar.
      </p>

      <div class="quality-row">
        <label class="quality-field">
          <span>Resolução</span>
          <select id="resolution-select">
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            <option value="1080p" selected>1080p</option>
          </select>
        </label>
        <label class="quality-field">
          <span>Taxa de quadros</span>
          <select id="fps-select">
            <option value="30">30 fps</option>
            <option value="60" selected>60 fps</option>
          </select>
        </label>
        <label class="quality-field">
          <span>Qualidade</span>
          <select id="bitrate-select">
            <option value="balanced" selected>Equilibrada</option>
            <option value="high">Alta</option>
            <option value="max">Máxima</option>
          </select>
        </label>
      </div>

      <p class="quality-hint" id="quality-hint"></p>
      <p class="present-tip">
        <strong>Áudio:</strong> marque “compartilhar áudio” no seletor. Prefira compartilhar
        <strong>uma aba</strong> do navegador — ela envia só o áudio daquela aba. Compartilhar a
        tela inteira captura o áudio do sistema, o que inclui o próprio Discord e faz os outros
        se ouvirem de volta.
      </p>
      <label class="loopback-field">
        <input id="loopback-check" type="checkbox" checked />
        <span>
          Enviar o áudio do sistema mesmo ao compartilhar a tela inteira
          <small>Necessário para jogo em tela cheia, que não tem como sair por aba. Só marque se o
          áudio do Discord estiver fora dessa mistura, senão a call se ouve de volta.</small>
        </span>
      </label>
      <p class="audio-notice" id="audio-notice"></p>
      <button id="share-btn" class="btn-primary btn-lg" type="button">Compartilhar tela</button>
    </div>
  `;
  const shareButton = root.querySelector<HTMLButtonElement>("#share-btn")!;
  const resolutionSelect = root.querySelector<HTMLSelectElement>("#resolution-select")!;
  const fpsSelect = root.querySelector<HTMLSelectElement>("#fps-select")!;
  const bitrateSelect = root.querySelector<HTMLSelectElement>("#bitrate-select")!;
  const qualityHint = root.querySelector<HTMLParagraphElement>("#quality-hint")!;
  const audioNotice = root.querySelector<HTMLParagraphElement>("#audio-notice")!;
  const loopbackCheck = root.querySelector<HTMLInputElement>("#loopback-check")!;

  let videoEncodePipeline: VideoEncodePipeline | null = null;
  let audioEncodePipeline: AudioEncodePipeline | null = null;
  let isPresenting = false;
  let videoClock = 0;
  let audioClock = 0;
  /** Frame slot assigned by the server when this tab started presenting. */
  let presenterSlot = SLOT_PRESENTER;
  /** Lazily created on the first alert; see playAlertChime. */
  let alertAudio: HTMLAudioElement | null = null;

  // --- Direct connections to viewers (see net/rtc.ts) ---
  /** One peer connection per viewer that asked for one, keyed by the opaque id the
   *  server assigned it. This tab never learns anything else about them. */
  const peers = new Map<string, RTCPeerConnection>();
  /** The captured tracks, kept around so they can be attached to new peers as viewers
   *  arrive mid-broadcast. */
  let captureStream: MediaStream | null = null;
  /** The preset in force, reused as the bitrate ceiling for each peer connection. */
  let activeQuality: QualityPreset | null = null;
  /**
   * Whether anybody still needs the WebSocket relay. Flipped by the server once every
   * viewer is on a direct connection (or nobody is watching); while false the encoder
   * is paused and nothing is put on the wire, because it would have nowhere to go.
   */
  let relayEnabled = true;

  // Restore the previous choice so a presenter who always uses, say, 720p30 doesn't
  // have to re-pick it every time the Activity opens this tab.
  try {
    const saved = localStorage.getItem(QUALITY_STORAGE_KEY);
    if (saved) {
      const { resolution, fps, bitrate, systemAudio } = JSON.parse(saved) as {
        resolution?: string;
        fps?: number;
        bitrate?: string;
        systemAudio?: boolean;
      };
      if (resolution && resolutionSelect.querySelector(`option[value="${resolution}"]`)) {
        resolutionSelect.value = resolution;
      }
      if (fps === 30 || fps === 60) fpsSelect.value = String(fps);
      if (bitrate && bitrateSelect.querySelector(`option[value="${bitrate}"]`)) {
        bitrateSelect.value = bitrate;
      }
      // Defaults to on, matching the markup: full-screen games can't be shared as a tab,
      // so the common case needs system audio. Only an explicitly saved `false` turns it
      // off -- entries saved before this option existed have no field here and should
      // land on the default like a first-time visitor, not read as "unchecked".
      loopbackCheck.checked = systemAudio !== false;
    }
  } catch {
    // A corrupt/unavailable localStorage entry must not block sharing; defaults apply.
  }

  function currentQuality(): QualityPreset {
    return buildQualityPreset(
      resolutionSelect.value as ResolutionKey,
      Number(fpsSelect.value) as FramerateKey,
      bitrateSelect.value as BitrateLevelKey,
    );
  }

  function updateQualityHint(): void {
    const quality = currentQuality();
    qualityHint.textContent =
      `${quality.width}x${quality.height} · ${quality.framerate} fps · ~${(quality.bitrateKbps / 1000).toFixed(1)} Mbps por espectador`;
  }

  function persistQuality(): void {
    try {
      localStorage.setItem(
        QUALITY_STORAGE_KEY,
        JSON.stringify({
          resolution: resolutionSelect.value,
          fps: Number(fpsSelect.value),
          bitrate: bitrateSelect.value,
          systemAudio: loopbackCheck.checked,
        }),
      );
    } catch {
      // Non-fatal: the selection just won't be remembered next time.
    }
  }

  for (const control of [resolutionSelect, fpsSelect, bitrateSelect, loopbackCheck]) {
    control.addEventListener("change", () => {
      updateQualityHint();
      persistQuality();
    });
  }
  updateQualityHint();

  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${window.location.host}/ws`;

  const wsClient = new WsClient(wsUrl, {
    onOpen: () => {
      setStatus("Conectado. Entrando na sala...");
      wsClient.sendControl({ kind: "join", roomId, userId: getUserId(), guildId: getGuildId() });
    },
    onClose: () => setStatus("Desconectado. Tentando reconectar..."),
    onControl: (message) => handleControl(message),
    onFrame: () => {
      // This tab only publishes; it never renders incoming frames.
    },
  });

  function handleControl(message: ControlMessage): void {
    switch (message.kind) {
      case "joined":
        setStatus("");
        // A reconnect (tunnel blip, server restart) lands on a fresh server-side state
        // that knows nothing about this broadcast, and the old socket's close already
        // ended it for every viewer -- while the capture here is still running. Without
        // this the tab keeps saying "compartilhando" over a broadcast nobody receives,
        // and the only way out is to stop and share again.
        if (isPresenting) resumePresenting();
        return;
      // The server decides which slot this broadcast occupies, since a room can carry
      // several at once. Stamp it on outgoing frames from here on.
      case "presenting-started":
        presenterSlot = message.slot;
        return;
      case "room-full":
        setStatus("Sala cheia - nao foi possivel entrar.");
        return;
      case "error":
        setStatus(`Erro: ${message.message}`);
        return;
      case "request-keyframe":
        videoEncodePipeline?.requestKeyframe();
        return;
      // A moderator is trying to get this presenter's attention.
      case "play-alert":
        playAlertChime();
        return;
      // The user pressed "Parar transmissão" inside the Discord Activity; the capture
      // lives in this tab, so the actual teardown has to happen here.
      case "request-stop-presenting":
        if (isPresenting) stopPresenting();
        return;
      case "viewer-count":
        if (isPresenting) setStatus(`Compartilhando -- ${message.count} espectador(es).`);
        return;
      // A viewer wants a direct connection. The side holding the media is the side
      // that offers, so negotiation starts here even though the viewer triggered it.
      case "rtc-want":
        void openPeer(message.peerId);
        return;
      case "rtc-bye":
        closePeer(message.peerId);
        return;
      case "rtc-signal":
        if (message.peerId) void receiveSignal(message.peerId, message.payload);
        return;
      // Nobody needs the WebSocket relay anymore (everyone is on a direct connection,
      // or nobody is watching). Pausing the encoder is the point: those frames have
      // nowhere to go, and the upload they were using is now carrying the peers.
      case "relay-chunks":
        relayEnabled = message.enabled;
        videoEncodePipeline?.setEncodingEnabled(message.enabled);
        return;
      default:
        return;
    }
  }

  // --- Direct connections (see net/rtc.ts) ---

  function sendSignal(peerId: string, payload: RtcSignalPayload): void {
    wsClient.sendControl({ kind: "rtc-signal", peerId, payload });
  }

  async function openPeer(peerId: string): Promise<void> {
    if (!supportsWebRtc() || !captureStream || peers.has(peerId)) return;

    try {
      const ice = await iceServers();
      // The viewer may have switched streams or left while ICE was being fetched.
      const stream = captureStream;
      if (!stream || peers.has(peerId)) return;

      const pc = createPeer({
        ice,
        onIceCandidate: (candidate) => sendSignal(peerId, { type: "ice", candidate }),
        onDead: () => closePeer(peerId),
      });
      peers.set(peerId, pc);

      // The tracks already being captured, not a second capture: the same source feeds
      // the relay's encoder and every peer connection.
      for (const track of stream.getTracks()) pc.addTrack(track, stream);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (activeQuality) {
        await tuneVideoSender(pc, {
          bitrateBps: activeQuality.bitrateKbps * 1000,
          framerate: activeQuality.framerate,
        });
      }
      sendSignal(peerId, { type: "offer", sdp: pc.localDescription?.sdp ?? offer.sdp ?? "" });
    } catch (error) {
      console.warn("[rtc] offer failed:", error);
      closePeer(peerId);
    }
  }

  async function receiveSignal(peerId: string, payload: RtcSignalPayload): Promise<void> {
    const pc = peers.get(peerId);
    if (!pc) return;

    try {
      if (payload.type === "answer") {
        await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      } else if (payload.type === "ice") {
        await pc.addIceCandidate(payload.candidate as RTCIceCandidateInit);
      }
      // An offer never arrives here: this tab is always the offerer.
    } catch (error) {
      console.warn("[rtc]", error);
    }
  }

  function closePeer(peerId: string): void {
    const pc = peers.get(peerId);
    if (!pc) return;
    peers.delete(peerId);
    pc.close();
  }

  function closeAllPeers(): void {
    for (const peerId of [...peers.keys()]) closePeer(peerId);
  }

  shareButton.addEventListener("click", () => {
    if (isPresenting) {
      stopPresenting();
    } else {
      void startPresenting();
    }
  });

  async function startPresenting(): Promise<void> {
    try {
      const quality = currentQuality();
      const capture = await startScreenCapture({
        quality,
        allowSystemAudioLoopback: loopbackCheck.checked,
      });
      const { videoTrack, audioTrack } = capture;

      // Held for the direct connections: every viewer that asks for one gets these same
      // tracks attached to its own peer, alongside the relay's encoder.
      captureStream = capture.stream;
      activeQuality = quality;
      relayEnabled = true;

      videoEncodePipeline = await startVideoEncodePipeline(videoTrack, (chunk) => {
        // A chunk already in flight when the server said the relay was no longer
        // needed. Cheap to drop, and it saves sending bytes nobody will read.
        if (!relayEnabled) return;
        const payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);
        videoClock += 1;
        wsClient.sendFrame(
          {
            slot: presenterSlot,
            type: FrameType.Video,
            // The chunk's own timestamp (inherited from the captured VideoFrame), NOT
            // performance.now(). Stamping at send time bakes in however long this frame
            // spent being encoded, which varies with scene complexity and with how deep
            // the encoder queue happens to be -- audio encodes in a fraction of that
            // time and far more consistently, so send-time stamps make the A/V
            // relationship jitter by tens of milliseconds at the source, before the
            // network is even involved. Capture timestamps come off a clock shared with
            // the audio track, which is what lets the viewer line the two back up.
            timestamp: chunk.timestamp / 1000,
            clock: videoClock,
            keyFrame: chunk.type === "key",
          },
          payload,
        );
      }, { quality });

      // Tab/system audio only (see screenCapture.ts) -- optional, since not every
      // capture source offers it (e.g. sharing a window without "share audio" checked).
      if (audioTrack) {
        audioEncodePipeline = await startAudioEncodePipeline(audioTrack, (chunk) => {
          // Same gate as video: when nobody is on the relay, its audio has no listener
          // either -- everyone still watching is getting this track over their peer.
          if (!relayEnabled) return;
          const payload = new Uint8Array(chunk.byteLength);
          chunk.copyTo(payload);
          audioClock += 1;
          wsClient.sendFrame(
            // Capture timestamp rather than send time, for the same reason as video
            // above -- and critically, on the same capture clock as the video track, so
            // the viewer can align the two streams instead of guessing.
            { slot: presenterSlot, type: FrameType.Audio, timestamp: chunk.timestamp / 1000, clock: audioClock },
            payload,
          );
        });
      }

      videoTrack.addEventListener("ended", () => stopPresenting());

      // Sent after the audio pipeline exists so viewers get the real Opus params
      // (sample rate / channel count) and can configure a matching decoder.
      announcePresenting();
      isPresenting = true;
      shareButton.textContent = "Parar de compartilhar";
      shareButton.classList.add("is-stop");

      // getDisplayMedia only returns an audio track when the picker's "share audio"
      // checkbox is ticked, and Windows offers it only for a whole screen or a Chrome
      // tab -- never for a single window. Without this the broadcast is silently mute.
      if (capture.audioDropped === "system-loopback") {
        // Audio was there and was deliberately dropped -- a different problem from
        // never having been offered one, and with a different fix, so say which.
        audioNotice.textContent =
          "Áudio desligado: você compartilhou a tela inteira, e o áudio do sistema inclui a saída do " +
          "Discord — a call inteira se ouviria de volta. Compartilhe uma aba do navegador, ou marque " +
          "a opção acima e transmita de novo se o áudio do Discord não estiver nessa mistura.";
        audioNotice.classList.add("is-warning");
      } else if (audioTrack) {
        audioNotice.textContent = "";
        audioNotice.classList.remove("is-warning");
        if (loopbackCheck.checked && capture.displaySurface !== "browser") {
          audioNotice.textContent =
            "Atenção: enviando o áudio do sistema. Se a saída do Discord estiver nessa mistura, " +
            "todo mundo na call vai se ouvir de volta.";
          audioNotice.classList.add("is-warning");
        }
      } else {
        audioNotice.textContent =
          "Sem áudio: você não marcou “compartilhar áudio” ao escolher a tela. " +
          "Pare e compartilhe de novo marcando a opção (disponível ao compartilhar a tela inteira ou uma aba do navegador).";
        audioNotice.classList.add("is-warning");
      }
      // Quality is baked into the encoder at configure() time, so changing it
      // mid-broadcast would have no effect until a restart.
      resolutionSelect.disabled = true;
      fpsSelect.disabled = true;
      bitrateSelect.disabled = true;
      loopbackCheck.disabled = true;
      setStatus("Voce esta compartilhando a tela. Pode deixar esta aba aberta em segundo plano.");
    } catch (error) {
      console.error("Failed to start screen capture:", error);
      setStatus("Nao foi possivel iniciar a captura de tela.");
    }
  }

  /**
   * Plays the knock sound for a moderator trying to get this presenter's attention.
   *
   * One element, reused and rewound, rather than a new Audio() per alert: that keeps
   * the file decoded and ready so the sound fires immediately, and stops repeated
   * alerts from layering on top of each other.
   *
   * Autoplay policy isn't a concern here: this tab only ever reaches the presenting
   * state through a click on "Compartilhar tela", so it always has user activation.
   */
  function playAlertChime(): void {
    alertAudio ??= new Audio(doorKnockUrl);
    alertAudio.currentTime = 0;
    alertAudio.play().catch((error) => console.error("Failed to play alert sound:", error));
  }

  function announcePresenting(): void {
    wsClient.sendControl({
      kind: "start-presenting",
      presenterId: getUserId(),
      audio: audioEncodePipeline?.params ?? null,
    });
  }

  /** Re-registers the running capture after the socket reconnected; see "joined". */
  function resumePresenting(): void {
    // The server dropped every direct connection along with the old socket, and the
    // viewers let go of theirs when the broadcast vanished. A stale entry would also
    // make openPeer() ignore that viewer's next invitation, leaving it on the relay.
    closeAllPeers();
    // The relay state belonged to the old socket; the server sends a fresh relay-chunks
    // right after this. Starting on a keyframe lets every viewer's cold decoder pick up
    // the picture immediately instead of waiting for the next periodic one.
    relayEnabled = true;
    videoEncodePipeline?.setEncodingEnabled(true);
    videoEncodePipeline?.requestKeyframe();
    announcePresenting();
    setStatus("Conexão restabelecida -- você continua compartilhando a tela.");
  }

  function stopPresenting(): void {
    videoEncodePipeline?.stop();
    videoEncodePipeline = null;
    audioEncodePipeline?.stop();
    audioEncodePipeline = null;
    closeAllPeers();
    captureStream = null;
    activeQuality = null;
    relayEnabled = true;
    wsClient.sendControl({ kind: "stop-presenting" });
    isPresenting = false;
    shareButton.textContent = "Compartilhar tela";
    shareButton.classList.remove("is-stop");
    audioNotice.textContent = "";
    audioNotice.classList.remove("is-warning");
    resolutionSelect.disabled = false;
    fpsSelect.disabled = false;
    bitrateSelect.disabled = false;
    loopbackCheck.disabled = false;
    setStatus("Voce parou de compartilhar. Pode fechar esta aba ou compartilhar de novo.");
  }

  window.addEventListener("beforeunload", () => {
    if (isPresenting) wsClient.sendControl({ kind: "stop-presenting" });
  });

  wsClient.connect();
}

main();
