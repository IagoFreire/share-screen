import type { ControlMessage, QualityPreset } from "@screenshare-bot/shared";
import { startAudioEncodePipeline } from "../capture/audioEncodePipeline.js";
import { startScreenCapture } from "../capture/screenCapture.js";
import { startVideoEncodePipeline } from "../capture/videoEncodePipeline.js";
import { WsClient } from "../net/wsClient.js";
import { createPresenterSession } from "../session/presenterSession.js";
import type { BroadcastHandle, BroadcastTarget } from "./liveController.js";

/**
 * One desktop broadcast: its own presenter-only WebSocket (like present.html's tab, so
 * the player connection keeps playing), the shared presenter session, and the capture
 * of the source picked in the transmit modal -- Electron grants exactly that source to
 * the getDisplayMedia() call inside startScreenCapture (see desktop/src/main/capture.ts).
 */

/** How long to wait for the relay to accept the presenter connection. */
const JOIN_TIMEOUT_MS = 10_000;

export interface BroadcastOptions {
  wsUrl: string;
  userId: string;
  session: string;
  selectSource(id: string): Promise<void>;
  onViewerCount(count: number): void;
  /** Someone used "bater na porta" on this broadcast. */
  onAlert(): void;
}

export async function startDesktopBroadcast(
  sourceId: string,
  quality: QualityPreset,
  target: BroadcastTarget,
  options: BroadcastOptions,
): Promise<BroadcastHandle> {
  await options.selectSource(sourceId);

  let onControl: (message: ControlMessage) => void = () => {};
  const ws = new WsClient(options.wsUrl, {
    onOpen: () =>
      ws.sendControl({
        kind: "join",
        roomId: target.roomId,
        userId: options.userId,
        guildId: target.guildId,
        session: options.session,
        presenterOnly: true,
      }),
    onControl: (message) => onControl(message),
    onFrame: () => {
      // A presenter connection never renders anything.
    },
  });

  const joined = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("O servidor não respondeu. Tente de novo.")), JOIN_TIMEOUT_MS);
    onControl = (message) => {
      if (message.kind === "joined") {
        clearTimeout(timer);
        resolve();
      } else if (message.kind === "room-full") {
        clearTimeout(timer);
        reject(new Error("A sala está cheia."));
      } else if (message.kind === "error") {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    };
  });

  ws.connect();
  try {
    await joined;
  } catch (error) {
    ws.close();
    throw error;
  }

  const session = createPresenterSession({
    sendFrame: (header, payload) => ws.sendFrame(header, payload),
    sendControl: (message) => ws.sendControl(message),
    capture: startScreenCapture,
    startVideo: startVideoEncodePipeline,
    startAudio: startAudioEncodePipeline,
    presenterId: options.userId,
  });

  onControl = (message) => {
    if (session.handleControl(message)) return;
    if (message.kind === "play-alert") options.onAlert();
    else if (message.kind === "viewer-count") options.onViewerCount(message.count);
  };

  try {
    await session.start(quality);
  } catch (error) {
    console.error("Desktop broadcast failed to start:", error);
    ws.close();
    throw new Error("Não foi possível iniciar a captura dessa fonte.");
  }

  session.onEnded(() => ws.close());
  return {
    stop() {
      session.stop();
      ws.close();
    },
    onEnded: (listener) => session.onEnded(listener),
  };
}
