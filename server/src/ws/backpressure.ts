import type { WebSocket } from "ws";
import {
  BACKPRESSURE_BUFFERED_BYTES_THRESHOLD,
  BACKPRESSURE_AUDIO_HARD_LIMIT_BYTES,
  BACKPRESSURE_STALL_FRAME_COUNT,
} from "@screenshare-bot/shared";

const stallCounts = new WeakMap<WebSocket, number>();

export type SendResult = "sent" | "dropped" | "stalled";

/** Audio is tiny but essential; video is huge and individually disposable. */
export type FramePriority = "video" | "audio";

/**
 * Sends `data` to `ws` unless its outgoing buffer is already backed up, in which case
 * the frame is dropped instead of queued. This is the core safety mechanism keeping one
 * slow/bad-network viewer from growing server memory unbounded on a 1GB box: a viewer
 * stuck above the threshold for too many consecutive frames is force-disconnected.
 *
 * Audio is deliberately exempt from the normal threshold. It accounts for roughly 1.5%
 * of a broadcast's bitrate, so dropping it saves almost no bandwidth while destroying
 * intelligibility -- and on a slow link it's the video stream that fills the buffer,
 * which would otherwise take the audio down with it. Audio still has a much higher hard
 * limit so a genuinely dead socket can't grow memory without bound.
 */
export function sendOrDrop(ws: WebSocket, data: Uint8Array, priority: FramePriority = "video"): SendResult {
  if (ws.readyState !== ws.OPEN) return "dropped";

  if (priority === "audio") {
    if (ws.bufferedAmount > BACKPRESSURE_AUDIO_HARD_LIMIT_BYTES) {
      ws.terminate();
      return "stalled";
    }
    ws.send(data);
    return "sent";
  }

  if (ws.bufferedAmount > BACKPRESSURE_BUFFERED_BYTES_THRESHOLD) {
    const count = (stallCounts.get(ws) ?? 0) + 1;
    stallCounts.set(ws, count);
    if (count >= BACKPRESSURE_STALL_FRAME_COUNT) {
      ws.terminate();
      return "stalled";
    }
    return "dropped";
  }

  stallCounts.delete(ws);
  ws.send(data);
  return "sent";
}

export function clearBackpressureState(ws: WebSocket): void {
  stallCounts.delete(ws);
}
