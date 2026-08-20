import type { WebSocket } from "ws";
import {
  decodeFrame,
  decodeControlMessage,
  encodeControlMessage,
  encodeFrame,
  FrameType,
  SLOT_PRESENTER,
  type ControlMessage,
} from "@screenshare-bot/shared";
import { roomManager } from "../roomManager.js";
import type { Room } from "./room.js";
import { sendOrDrop, clearBackpressureState } from "./backpressure.js";
import { isUserInVoiceChannel } from "../auth/verifyMember.js";

interface ConnectionState {
  roomId: string | null;
  isPresenter: boolean;
  /** Discord user id claimed by this connection; used to authorise stop requests and
   *  to pair up a user's multiple simultaneous connections (Activity + an externally
   *  opened tab) for the pause/resume bandwidth-saving below. */
  userId: string | null;
  /**
   * Whether this viewer has received a keyframe from the *current* broadcast yet. A
   * decoder can't do anything with a delta frame before its first keyframe, so
   * forwarding one is pure wasted egress -- this lets the relay skip it instead of
   * relying solely on the viewer discarding it after the fact.
   */
  hasReceivedKeyframe: boolean;
  /**
   * True once this connection has been asked to stop receiving video/audio because the
   * same user opened another tab (present.html/watch.html) already receiving it -- two
   * copies of the same stream to the same person is a full extra viewer's worth of
   * egress for nobody. Cleared automatically when the other connection disconnects, or
   * manually via "resume-viewing".
   */
  isPaused: boolean;
  /** True when this viewer asked to stop receiving video ("only audio", e.g. to
   *  listen along to music without watching). Audio keeps flowing regardless. */
  videoDisabled: boolean;
}

const connectionState = new WeakMap<WebSocket, ConnectionState>();

function getState(ws: WebSocket): ConnectionState {
  let state = connectionState.get(ws);
  if (!state) {
    state = {
      roomId: null,
      isPresenter: false,
      userId: null,
      hasReceivedKeyframe: false,
      isPaused: false,
      videoDisabled: false,
    };
    connectionState.set(ws, state);
  }
  return state;
}

function send(ws: WebSocket, message: ControlMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(encodeControlMessage(SLOT_PRESENTER, message));
  }
}

function broadcastControl(room: Room, message: ControlMessage): void {
  const encoded = encodeControlMessage(SLOT_PRESENTER, message);
  room.forEachViewer((viewer) => sendOrDrop(viewer, encoded));
  if (room.presenter) sendOrDrop(room.presenter, encoded);
}

function requestKeyframeFromPresenter(room: Room): void {
  if (room.presenter) send(room.presenter, { kind: "request-keyframe" });
}

/**
 * Pauses every *other* active viewer connection in `room` belonging to `userId` (there
 * should be at most one, but this doesn't assume it). Called right after a fresh join,
 * so opening a second tab for the same person stops the older connection's stream
 * instead of sending it twice.
 */
function pauseOtherConnectionsForUser(room: Room, userId: string, joiningWs: WebSocket): void {
  room.forEachViewer((viewer) => {
    if (viewer === joiningWs) return;
    const viewerState = getState(viewer);
    if (viewerState.userId !== userId || viewerState.isPaused) return;

    viewerState.isPaused = true;
    viewerState.hasReceivedKeyframe = false; // needs a fresh keyframe whenever it resumes
    send(viewer, { kind: "viewing-paused" });
  });
}

/** Resumes a paused connection belonging to `userId` in `room`, if one exists. */
function resumeConnectionForUser(room: Room, userId: string): void {
  room.forEachViewer((viewer) => {
    const viewerState = getState(viewer);
    if (viewerState.userId !== userId || !viewerState.isPaused) return;

    viewerState.isPaused = false;
    viewerState.hasReceivedKeyframe = false;
    send(viewer, { kind: "viewing-resumed" });
    requestKeyframeFromPresenter(room);
  });
}

/** Dispatches one incoming binary WS message: either a control message or an A/V frame to relay. */
export function handleMessage(ws: WebSocket, data: Uint8Array): void {
  const frame = decodeFrame(data);

  if (frame.type === FrameType.Control) {
    handleControlMessage(ws, decodeControlMessage(frame));
    return;
  }

  // Only the room's current presenter may publish video/audio frames.
  const state = getState(ws);
  if (!state.roomId || !state.isPresenter) return;

  const room = roomManager.getRoom(state.roomId);
  if (!room || room.presenter !== ws) return;

  // Audio is prioritised so a congested link thins the video rather than breaking speech.
  const priority = frame.type === FrameType.Audio ? "audio" : "video";
  const outgoing = encodeFrame(frame, frame.payload);

  room.forEachViewer((viewer) => {
    const viewerState = getState(viewer);
    if (viewerState.isPaused) return; // watching via another tab right now

    if (frame.type === FrameType.Video) {
      if (viewerState.videoDisabled) return; // chose audio-only
      if (!viewerState.hasReceivedKeyframe) {
        // Nothing this viewer's decoder can use yet -- skip rather than waste egress
        // on a frame it will just discard on arrival.
        if (!frame.keyFrame) return;
        viewerState.hasReceivedKeyframe = true;
      }
    }
    sendOrDrop(viewer, outgoing, priority);
  });
}

/**
 * Split out from handleControlMessage because the optional voice-membership check
 * needs to await a Discord API call; the rest of the control-message handling stays
 * synchronous.
 */
async function handleJoin(
  ws: WebSocket,
  state: ConnectionState,
  message: Extract<ControlMessage, { kind: "join" }>,
): Promise<void> {
  const room = roomManager.getOrCreateRoom(message.roomId);
  if (!room || !room.canAddViewer()) {
    send(ws, { kind: "room-full" });
    return;
  }

  if (message.guildId && message.userId) {
    const allowed = await isUserInVoiceChannel(message.guildId, message.roomId, message.userId);
    if (!allowed) {
      send(ws, { kind: "error", message: "You must be in this voice channel to join." });
      return;
    }
  }

  state.roomId = message.roomId;
  state.userId = message.userId;
  room.addViewer(ws);

  if (message.userId) pauseOtherConnectionsForUser(room, message.userId, ws);

  send(ws, {
    kind: "joined",
    roomId: message.roomId,
    hasPresenter: room.hasPresenter,
    presenterId: room.presenterId,
    audio: room.audioParams,
    viewerCount: room.viewerCount,
  });
}

function handleControlMessage(ws: WebSocket, message: ControlMessage): void {
  const state = getState(ws);

  switch (message.kind) {
    case "join": {
      void handleJoin(ws, state, message);
      return;
    }

    case "start-presenting": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      if (!room.setPresenter(ws, message.presenterId, message.audio)) {
        send(ws, { kind: "error", message: "Room already has a presenter." });
        return;
      }
      state.userId = message.presenterId;
      state.isPresenter = true;
      room.removeViewer(ws);
      room.forEachViewer((viewer) => {
        getState(viewer).hasReceivedKeyframe = false;
      });
      broadcastControl(room, {
        kind: "presenter-changed",
        hasPresenter: true,
        presenterId: room.presenterId,
        audio: room.audioParams,
      });
      return;
    }

    case "stop-presenting": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      room.clearPresenterIfMatches(ws);
      state.isPresenter = false;
      broadcastControl(room, { kind: "presenter-changed", hasPresenter: false, presenterId: null, audio: null });
      return;
    }

    // Forwarded to the presenting tab, which owns the capture and actually stops it.
    // Gated on the requester being the presenter, so one viewer can't cut off someone
    // else's broadcast.
    case "request-stop-presenting": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room?.presenter || !room.presenterId) return;
      if (room.presenterId !== state.userId) return;

      send(room.presenter, { kind: "request-stop-presenting" });
      return;
    }

    case "request-keyframe": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (room) requestKeyframeFromPresenter(room);
      return;
    }

    // Explicit "Retomar aqui": un-pause this connection without waiting for whichever
    // other tab paused it to disconnect. The user might want both open at once.
    case "resume-viewing": {
      if (!state.roomId || !state.isPaused) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      state.isPaused = false;
      state.hasReceivedKeyframe = false;
      send(ws, { kind: "viewing-resumed" });
      requestKeyframeFromPresenter(room);
      return;
    }

    // Audio-only toggle: doesn't touch room membership or the pause mechanism, just
    // which frame types get forwarded to this specific connection (see handleMessage).
    case "set-video-enabled": {
      state.videoDisabled = !message.enabled;
      if (message.enabled && state.roomId) {
        state.hasReceivedKeyframe = false; // missed whatever aired while video was off
        const room = roomManager.getRoom(state.roomId);
        if (room) requestKeyframeFromPresenter(room);
      }
      return;
    }

    default:
      return;
  }
}

export function handleClose(ws: WebSocket): void {
  const state = connectionState.get(ws);
  clearBackpressureState(ws);
  if (!state?.roomId) return;

  const room = roomManager.getRoom(state.roomId);
  if (room) {
    if (state.isPresenter) {
      room.clearPresenterIfMatches(ws);
      broadcastControl(room, { kind: "presenter-changed", hasPresenter: false, presenterId: null, audio: null });
    } else {
      room.removeViewer(ws);
      broadcastControl(room, { kind: "viewer-count", count: room.viewerCount });
    }

    // If this connection had paused a sibling tab of the same user, that tab has
    // nothing else showing it the stream anymore -- resume it automatically.
    if (state.userId) resumeConnectionForUser(room, state.userId);

    roomManager.removeRoomIfEmpty(state.roomId);
  }

  connectionState.delete(ws);
}
