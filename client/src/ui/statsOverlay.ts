import type { AudioPlaybackStats } from "../playback/audioDecodePipeline.js";
import type { ReceiverStats } from "../playback/streamReceiver.js";
import type { VideoPlaybackStats } from "../playback/videoDecodePipeline.js";

/**
 * "Estatísticas" over the player (Ctrl+Shift+S): the numbers behind playback, so sync
 * and latency problems can be told apart by measurement rather than by impression --
 * a growing queue delay is the network, overloads are this machine, underruns and
 * catch-ups are the audio buffer.
 */

export interface PlaybackStatsInput {
  audio: AudioPlaybackStats | null;
  video: VideoPlaybackStats | null;
  receiver: ReceiverStats;
  /** Simulcast layer being received; null for a single-version broadcast. */
  layer: number | null;
  autoLayer: boolean;
}

const REFRESH_MS = 500;

const decimal = (value: number, digits: number) => value.toFixed(digits).replace(".", ",");

export function formatPlaybackStats({ audio, video, receiver, layer, autoLayer }: PlaybackStatsInput): string[] {
  const audioLine = audio
    ? `Áudio: folga ${Math.round(audio.leadMs)} ms · velocidade ${decimal(audio.playbackRate, 4)}× · ` +
      `falhas ${audio.underruns} · saltos ao vivo ${audio.catchUps}`
    : "Áudio: sem áudio";
  const videoLine = video
    ? `Vídeo: fila ${video.queuedFrames} · descartados ${video.droppedFrames} · no decoder ${video.decodeQueue} · ` +
      `sobrecargas ${video.overloads}${video.waitingForKeyframe ? " · aguardando keyframe" : ""}`
    : "Vídeo: sem vídeo";
  const delay = receiver.queueDelayMs === null ? "—" : `${Math.round(receiver.queueDelayMs)} ms`;
  const networkLine =
    `Rede: atraso de fila ${delay} · quadros perdidos ${receiver.gaps} · ` +
    `avisos de congestionamento ${receiver.congestionReports}`;
  const qualityLine =
    layer === null ? "Qualidade: versão única" : `Qualidade: camada ${layer}${autoLayer ? " (automático)" : ""}`;
  return [audioLine, videoLine, networkLine, qualityLine];
}

export function isStatsShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && event.code === "KeyS";
}

export interface StatsOverlay {
  toggle(): void;
  destroy(): void;
}

/** A small read-only panel in the corner of `host`, refreshed while it is shown. */
export function createStatsOverlay(host: HTMLElement, read: () => PlaybackStatsInput): StatsOverlay {
  const panel = document.createElement("pre");
  panel.setAttribute("aria-live", "off");
  Object.assign(panel.style, {
    position: "absolute",
    top: "8px",
    left: "8px",
    zIndex: "20",
    margin: "0",
    padding: "8px 10px",
    borderRadius: "6px",
    background: "rgba(0, 0, 0, 0.72)",
    color: "#e6e6e6",
    font: "12px/1.5 ui-monospace, Consolas, monospace",
    pointerEvents: "none",
    display: "none",
  });
  host.append(panel);
  let timer: ReturnType<typeof setInterval> | null = null;

  const refresh = () => {
    panel.textContent = formatPlaybackStats(read()).join("\n");
  };

  return {
    toggle() {
      if (timer === null) {
        refresh();
        panel.style.display = "block";
        timer = setInterval(refresh, REFRESH_MS);
      } else {
        clearInterval(timer);
        timer = null;
        panel.style.display = "none";
      }
    },
    destroy() {
      if (timer !== null) clearInterval(timer);
      panel.remove();
    },
  };
}
