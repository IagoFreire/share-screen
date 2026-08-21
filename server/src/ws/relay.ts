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
import { config } from "../config.js";
import type { Room } from "./room.js";
import { sendOrDrop, clearBackpressureState } from "./backpressure.js";
import { isUserInVoiceChannel } from "../auth/verifyMember.js";

interface ConnectionState {
  roomId: string | null;
  /** Discord user id claimed by this connection; used to authorise stop requests and
   *  to pair up a user's multiple simultaneous connections (Activity + an externally
   *  opened tab) for the pause/resume bandwidth-saving below. */
  userId: string | null;
  /** Slot this connection broadcasts on, or null if it isn't presenting. */
  presenterSlot: number | null;
  /**
   * Which broadcast this connection is watching. A room can carry several at once but a
   * viewer receives exactly one, so this is what keeps egress at "viewers x bitrate"
   * rather than multiplying by however many people happen to be live.
   */
  selectedSlot: number;
  /**
   * Whether this viewer has received a keyframe for the stream it currently watches. A
   * decoder can't do anything with a delta frame before its first keyframe, so
   * forwarding one is pure wasted egress -- this lets the relay skip it instead of
   * relying solely on the viewer discarding it after the fact. Reset whenever the
   * selected slot changes, since the new stream's decoder starts cold.
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
      userId: null,
      presenterSlot: null,
      selectedSlot: SLOT_PRESENTER,
      hasReceivedKeyframe: false,
      isPaused: false,
      videoDisabled: false,
    };
    connectionState.set(ws, state);
  }
  return state;
}

/** Whether this user may end broadcasts other than their own (see config.adminUserIds). */
function isAdmin(userId: string | null): boolean {
  return userId !== null && config.adminUserIds.includes(userId);
}

function send(ws: WebSocket, message: ControlMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(encodeControlMessage(SLOT_PRESENTER, message));
  }
}

function broadcastControl(room: Room, message: ControlMessage): void {
  const encoded = encodeControlMessage(SLOT_PRESENTER, message);
  room.forEachViewer((viewer) => sendOrDrop(viewer, encoded));
  room.forEachPresenter((presenter) => sendOrDrop(presenter, encoded));
}

/** Tells everyone the set of live broadcasts changed, so viewers can update their picker. */
function broadcastStreams(room: Room): void {
  broadcastControl(room, { kind: "streams-changed", streams: room.streams });
}

function requestKeyframeFromSlot(room: Room, slot: number): void {
  const presenter = room.getPresenter(slot);
  if (presenter) send(presenter.ws, { kind: "request-keyframe" });
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
    requestKeyframeFromSlot(room, viewerState.selectedSlot);
  });
}

/** Dispatches one incoming binary WS message: either a control message or an A/V frame to relay. */
export function handleMessage(ws: WebSocket, data: Uint8Array): void {
  const frame = decodeFrame(data);

  if (frame.type === FrameType.Control) {
    handleControlMessage(ws, decodeControlMessage(frame));
    return;
  }

  // Only a registered presenter may publish video/audio frames.
  const state = getState(ws);
  if (!state.roomId || state.presenterSlot === null) return;

  const room = roomManager.getRoom(state.roomId);
  if (!room) return;

  // Take the slot from server-side state, never from the frame the client sent: a
  // presenter that stamped someone else's slot would otherwise inject video into their
  // broadcast, and every viewer watching that person would see it.
  const slot = room.slotOf(ws);
  if (slot === null || slot !== state.presenterSlot) return;

  // Audio is prioritised so a congested link thins the video rather than breaking speech.
  const priority = frame.type === FrameType.Audio ? "audio" : "video";
  const outgoing = encodeFrame({ ...frame, slot }, frame.payload);

  room.forEachViewer((viewer) => {
    const viewerState = getState(viewer);
    if (viewerState.isPaused) return; // watching via another tab right now
    if (viewerState.selectedSlot !== slot) return; // watching a different broadcast

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

  // Default to the lowest live slot so a viewer joining mid-broadcast sees something
  // immediately rather than an empty player until they pick from the list.
  const streams = room.streams;
  state.selectedSlot = streams[0]?.slot ?? SLOT_PRESENTER;
  state.hasReceivedKeyframe = false;

  if (message.userId) pauseOtherConnectionsForUser(room, message.userId, ws);

  send(ws, {
    kind: "joined",
    roomId: message.roomId,
    streams,
    viewerCount: room.viewerCount,
    isAdmin: isAdmin(message.userId),
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

      const slot = room.allocateSlot(ws, message.presenterId, message.audio);
      if (slot === null) {
        send(ws, { kind: "error", message: "Room already has the maximum number of broadcasts." });
        return;
      }
      state.userId = message.presenterId;
      state.presenterSlot = slot;
      // A presenting socket stops being a viewer: it never watches its own stream.
      room.removeViewer(ws);

      send(ws, { kind: "presenting-started", slot });
      broadcastStreams(room);
      return;
    }

    case "stop-presenting": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      const freed = room.clearSlotFor(ws);
      state.presenterSlot = null;
      if (freed !== null) handleSlotWentAway(room, freed);
      return;
    }

    // Forwarded to the presenting tab, which owns the capture and actually stops it.
    // Without an explicit slot this ends the requester's own broadcast; with one it
    // ends somebody else's, which only an admin may do. Re-checked here rather than
    // trusting the `isAdmin` the client was told at join time.
    case "request-stop-presenting": {
      if (!state.roomId || !state.userId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      const targetsOther = message.slot !== undefined && message.slot !== room.slotOfUser(state.userId);
      if (targetsOther && !isAdmin(state.userId)) return;

      const slot = message.slot ?? room.slotOfUser(state.userId);
      if (slot === null || slot === undefined) return;
      const presenter = room.getPresenter(slot);
      if (presenter) send(presenter.ws, { kind: "request-stop-presenting" });
      return;
    }

    // Switch which broadcast this viewer receives. The old stream stops flowing
    // immediately, so watching two at once is never possible -- that's the whole reason
    // extra presenters cost no extra egress.
    case "select-stream": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      state.selectedSlot = message.slot;
      state.hasReceivedKeyframe = false; // new stream, decoder starts cold
      requestKeyframeFromSlot(room, message.slot);
      return;
    }

    case "request-keyframe": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (room) requestKeyframeFromSlot(room, state.selectedSlot);
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
      requestKeyframeFromSlot(room, state.selectedSlot);
      return;
    }

    // Audio-only toggle: doesn't touch room membership or the pause mechanism, just
    // which frame types get forwarded to this specific connection (see handleMessage).
    case "set-video-enabled": {
      state.videoDisabled = !message.enabled;
      if (message.enabled && state.roomId) {
        state.hasReceivedKeyframe = false; // missed whatever aired while video was off
        const room = roomManager.getRoom(state.roomId);
        if (room) requestKeyframeFromSlot(room, state.selectedSlot);
      }
      return;
    }

    default:
      return;
  }
}

/**
 * A broadcast ended. Anyone who was watching it is now staring at a frozen last frame,
 * so move them to another live stream if there is one; otherwise leave them on the slot
 * so they pick the picture back up if that presenter returns.
 */
function handleSlotWentAway(room: Room, freedSlot: number): void {
  const remaining = room.streams;
  const fallback = remaining[0]?.slot ?? null;

  room.forEachViewer((viewer) => {
    const viewerState = getState(viewer);
    if (viewerState.selectedSlot !== freedSlot) return;

    viewerState.hasReceivedKeyframe = false;
    if (fallback !== null) viewerState.selectedSlot = fallback;
  });

  broadcastStreams(room);
  if (fallback !== null) requestKeyframeFromSlot(room, fallback);
}

export function handleClose(ws: WebSocket): void {
  const state = connectionState.get(ws);
  clearBackpressureState(ws);
  if (!state?.roomId) return;

  const room = roomManager.getRoom(state.roomId);
  if (room) {
    const freed = room.clearSlotFor(ws);
    if (freed !== null) {
      handleSlotWentAway(room, freed);
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
