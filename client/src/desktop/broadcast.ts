import type { ControlMessage, QualityPreset } from "@screenshare-bot/shared";
import { startAudioEncodePipeline } from "../capture/audioEncodePipeline.js";
import { startScreenCapture } from "../capture/screenCapture.js";
import { startVideoEncodePipeline } from "../capture/videoEncodePipeline.js";
import { WsClient, type WsClientHandlers } from "../net/wsClient.js";
import {
  createPresenterSession,
  type PresenterSession,
  type PresenterSessionDeps,
} from "../session/presenterSession.js";
import type { BroadcastHandle, BroadcastTarget } from "./liveController.js";

/**
 * One desktop broadcast: its own presenter-only WebSocket (like present.html's tab, so
 * the player connection keeps playing), the shared presenter session, and the capture
 * of the source picked in the transmit modal -- Electron grants exactly that source to
 * the getDisplayMedia() call inside startScreenCapture (see desktop/src/main/capture.ts).
 *
 * "Live" here means "the relay has accepted it": if the connection drops (a relay
 * restart frees the slot, and a reconnect only re-joins) or the relay reports an error
 * after the fact, the broadcast ends and says so, instead of showing "ao vivo" while
 * nobody receives anything.
 */

/** How long to wait for the relay to accept the presenter connection. */
const JOIN_TIMEOUT_MS = 10_000;

const DROPPED_MESSAGE = "A conexão com o servidor caiu e a transmissão foi encerrada.";

export interface BroadcastOptions {
  wsUrl: string;
  userId: string;
  session: string;
  selectSource(id: string): Promise<void>;
  onViewerCount(count: number): void;
  /** Someone used "bater na porta" on this broadcast. */
  onAlert(): void;
  /** The broadcast ended because of the relay or the network, not the user. */
  onInterrupted(message: string): void;
}

type WsLike = Pick<WsClient, "connect" | "close" | "sendControl" | "sendFrame">;

/** Seams for tests; production uses the real socket and presenter session. */
export interface BroadcastFactories {
  createWs(url: string, handlers: WsClientHandlers): WsLike;
  createSession(deps: PresenterSessionDeps): PresenterSession;
}

const DEFAULT_FACTORIES: BroadcastFactories = {
  createWs: (url, handlers) => new WsClient(url, handlers),
  createSession: createPresenterSession,
};

export async function startDesktopBroadcast(
  sourceId: string,
  quality: QualityPreset,
  target: BroadcastTarget,
  options: BroadcastOptions,
  factories: BroadcastFactories = DEFAULT_FACTORIES,
): Promise<BroadcastHandle> {
  await options.selectSource(sourceId);

  let onControl: (message: ControlMessage) => void = () => {};
  let onClose: () => void = () => {};
  const ws = factories.createWs(options.wsUrl, {
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
    onClose: () => onClose(),
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

  const session = factories.createSession({
    sendFrame: (header, payload) => ws.sendFrame(header, payload),
    sendControl: (message) => ws.sendControl(message),
    capture: startScreenCapture,
    startVideo: startVideoEncodePipeline,
    startAudio: startAudioEncodePipeline,
    presenterId: options.userId,
  });

  let finished = false;
  const endedListeners: Array<() => void> = [];

  /** Ends the broadcast from our side or the relay's; listeners hear only unasked ends. */
  function finish(reason: "stopped" | "ended" | { interrupted: string }): void {
    if (finished) return;
    finished = true;
    if (reason !== "ended") session.stop();
    ws.close();
    if (reason === "stopped") return;
    if (typeof reason === "object") options.onInterrupted(reason.interrupted);
    for (const listener of endedListeners) listener();
  }

  onControl = (message) => {
    if (session.handleControl(message)) return;
    if (message.kind === "play-alert") options.onAlert();
    else if (message.kind === "viewer-count") options.onViewerCount(message.count);
    else if (message.kind === "error") finish({ interrupted: `A transmissão foi encerrada: ${message.message}` });
  };

  try {
    await session.start(quality);
  } catch (error) {
    console.error("Desktop broadcast failed to start:", error);
    ws.close();
    throw new Error("Não foi possível iniciar a captura dessa fonte.");
  }

  onClose = () => finish({ interrupted: DROPPED_MESSAGE });
  // Source closed or an admin ended it: the session already stopped itself.
  session.onEnded(() => finish("ended"));

  return {
    stop: () => finish("stopped"),
    onEnded: (listener) => endedListeners.push(listener),
  };
}
