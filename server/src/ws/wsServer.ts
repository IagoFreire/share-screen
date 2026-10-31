import type { Server } from "node:http";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { handleMessage, handleClose } from "./relay.js";
import { handleVoiceClose, handleVoiceMessage } from "../voice/voiceServer.js";

/**
 * How often to ping every connection and check the previous round's pongs.
 * A connection that never answers is declared dead on the following tick, so a
 * hard-killed presenter (crash, unplugged network, closed laptop lid) is detected
 * and its presenter slot freed within roughly one interval, not left stuck forever.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Detects and reaps dead connections. Without this, a peer that vanishes without a
 * clean TCP close (a crash, not a graceful disconnect) never fires the 'close' event:
 * Node has no way to know the socket is gone until the OS eventually times it out,
 * which can take minutes. Until then `room.presenter` keeps pointing at a socket that
 * will never send another frame, and setPresenter() permanently refuses anyone else --
 * the whole room is stuck. ws.ping()/pong() is the standard fix: the browser answers
 * pings automatically, so a healthy peer costs nothing and a dead one gets noticed.
 */
function attachHeartbeat(wss: WebSocketServer): void {
  const alive = new WeakSet<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate(); // triggers 'close' -> handleClose(ws), freeing any presenter slot
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => clearInterval(interval));
}

/** A WebSocket endpoint: binary frames in, and what to do when a connection ends. */
function createEndpoint(
  onMessage: (ws: WebSocket, bytes: Uint8Array) => void,
  onClose: (ws: WebSocket) => void,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  attachHeartbeat(wss);

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) return; // protocol.ts frames (control + A/V) are always sent as binary

      try {
        const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
        onMessage(ws, bytes);
      } catch (error) {
        console.error("Failed to handle WS message:", error);
      }
    });

    ws.on("close", () => onClose(ws));
    ws.on("error", (error) => console.error("WS connection error:", error));
  });

  return wss;
}

/**
 * /ws is the screen-share relay, /voice the voice rooms. ws can't hang two servers with
 * different `path`s on one HTTP server (the first refuses the other's upgrades), so both
 * run without one and this routes each upgrade by its path.
 */
export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  const relay = createEndpoint(handleMessage, handleClose);
  const voice = createEndpoint(handleVoiceMessage, handleVoiceClose);

  httpServer.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const endpoint = pathname === "/ws" ? relay : pathname === "/voice" ? voice : null;
    if (!endpoint) {
      socket.destroy();
      return;
    }
    endpoint.handleUpgrade(request, socket, head, (ws) => endpoint.emit("connection", ws, request));
  });

  return relay;
}
