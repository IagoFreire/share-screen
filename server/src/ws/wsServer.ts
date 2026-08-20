import type { Server } from "node:http";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { handleMessage, handleClose } from "./relay.js";

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

export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  attachHeartbeat(wss);

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) return; // protocol.ts frames (control + A/V) are always sent as binary

      try {
        const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
        handleMessage(ws, bytes);
      } catch (error) {
        console.error("Failed to handle WS message:", error);
      }
    });

    ws.on("close", () => handleClose(ws));
    ws.on("error", (error) => console.error("WS connection error:", error));
  });

  return wss;
}
