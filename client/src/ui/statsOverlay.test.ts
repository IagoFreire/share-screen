import { describe, expect, it } from "vitest";
import { formatPlaybackStats, isStatsShortcut } from "./statsOverlay.js";

const receiver = { queueDelayMs: 12.4, gaps: 1, congestionReports: 0 };

describe("stats overlay", () => {
  it("describes audio, video, network and quality in a few lines", () => {
    const lines = formatPlaybackStats({
      audio: { leadMs: 301.6, underruns: 2, catchUps: 1, playbackRate: 1.0015, peakDb: -12.4 },
      video: {
        droppedFrames: 9,
        queuedFrames: 17,
        decodeQueue: 1,
        decodeLagMs: 33.3,
        overloads: 0,
        waitingForKeyframe: false,
      },
      receiver,
      layer: 1,
      autoLayer: true,
    });

    expect(lines).toEqual([
      "Áudio: nível -12 dB · folga 302 ms · velocidade 1,0015× · falhas 2 · saltos ao vivo 1",
      "Vídeo: fila 17 · descartados 9 · no decoder 1 (33 ms) · sobrecargas 0",
      "Rede: atraso de fila 12 ms · quadros perdidos 1 · avisos de congestionamento 0",
      "Qualidade: camada 1 (automático)",
    ]);
  });

  it("says when a part isn't playing", () => {
    const lines = formatPlaybackStats({ audio: null, video: null, receiver, layer: null, autoLayer: false });

    expect(lines.slice(0, 2)).toEqual(["Áudio: sem áudio", "Vídeo: sem vídeo"]);
    expect(lines[3]).toBe("Qualidade: versão única");
  });

  it("flags a picture waiting for a keyframe", () => {
    const [, video] = formatPlaybackStats({
      audio: null,
      video: { droppedFrames: 0, queuedFrames: 0, decodeQueue: 0, decodeLagMs: 0, overloads: 0, waitingForKeyframe: true },
      receiver,
      layer: 0,
      autoLayer: false,
    });

    expect(video).toBe("Vídeo: fila 0 · descartados 0 · no decoder 0 (0 ms) · sobrecargas 0 · aguardando keyframe");
  });

  it("calls a silent stream silence", () => {
    const [audio] = formatPlaybackStats({
      audio: { leadMs: 300, underruns: 0, catchUps: 0, playbackRate: 1, peakDb: -Infinity },
      video: null,
      receiver,
      layer: null,
      autoLayer: false,
    });

    expect(audio).toBe("Áudio: nível silêncio · folga 300 ms · velocidade 1,0000× · falhas 0 · saltos ao vivo 0");
  });

  it("opens on Ctrl+Shift+S only", () => {
    expect(isStatsShortcut({ ctrlKey: true, shiftKey: true, code: "KeyS" } as KeyboardEvent)).toBe(true);
    expect(isStatsShortcut({ ctrlKey: true, shiftKey: false, code: "KeyS" } as KeyboardEvent)).toBe(false);
  });
});
