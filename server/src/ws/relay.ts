import { randomUUID } from "node:crypto";
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
import { resolveChannelName, resolveGuildName, resolveUserName } from "../auth/discordNames.js";

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
  /**
   * Opaque handle for this connection in WebRTC signalling. Generated here, never
   * supplied by the client: it's what lets a presenter address one specific viewer
   * without either side learning anything about the other, and what stops a client
   * from claiming to be a peer it was never introduced to.
   */
  peerId: string;
  /**
   * The slot this viewer is receiving over a direct WebRTC connection instead of the
   * relay, or null when everything still comes over the WebSocket.
   *
   * Set only once the viewer reports an actual painted frame -- never on the peer
   * connection merely reporting "connected", which a stalled peer does just as
   * convincingly. Until then the relay keeps sending, so a connection that negotiates
   * successfully and then delivers nothing costs some duplicate bandwidth rather than
   * a black screen.
   */
  rtcActiveSlot: number | null;
}

const connectionState = new WeakMap<WebSocket, ConnectionState>();

// [debug-video-toggle] TEMPORARY: traces transport changes around the video toggle.
function debugLog(state: ConnectionState, event: string): void {
  const time = new Date().toISOString().slice(11, 23);
  console.info(`[debug-video-toggle] ${time} user=${state.userId} peer=${state.peerId.slice(0, 8)} ${event}`);
}

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
      peerId: randomUUID(),
      rtcActiveSlot: null,
    };
    connectionState.set(ws, state);
  }
  return state;
}

/**
 * Sends the broadcast list: every broadcast on this relay (all rooms, and therefore all
 * Discord servers) when `onlyRoomId` is null, or just the ones in that room.
 *
 * Name lookups run in parallel and are cached, so the repeated polling that keeps the
 * panel fresh costs at most a handful of API calls when something new appears.
 */
async function sendActiveBroadcasts(ws: WebSocket, onlyRoomId: string | null): Promise<void> {
  const rooms = roomManager.allRooms().filter((room) => onlyRoomId === null || room.id === onlyRoomId);
  const entries = rooms.flatMap((room) => room.streams.map((stream) => ({ room, stream })));

  const broadcasts = await Promise.all(
    entries.map(async ({ room, stream }) => {
      const [guildName, channelName, presenterName] = await Promise.all([
        resolveGuildName(room.guildId),
        resolveChannelName(room.id),
        resolveUserName(stream.presenterId),
      ]);
      return {
        roomId: room.id,
        guildId: room.guildId,
        guildName,
        channelName,
        slot: stream.slot,
        presenterId: stream.presenterId,
        presenterName,
        viewerCount: room.viewerCount,
      };
    }),
  );

  send(ws, { kind: "active-broadcasts", broadcasts });
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
    endDirectConnection(room, viewerState, viewerState.selectedSlot);
    send(viewer, { kind: "viewing-paused" });
    updateRelayChunks(room, viewerState.selectedSlot);
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
    updateRelayChunks(room, viewerState.selectedSlot);
    requestKeyframeFromSlot(room, viewerState.selectedSlot);
    inviteDirectConnection(room, viewer, viewerState);
  });
}

// ---- Direct viewer<->presenter connections (WebRTC), layered on top of the relay ----
//
// The relay below is the floor and is never switched off pre-emptively: every viewer
// starts on it and stays there until a direct connection is *demonstrably* painting
// frames. What the direct path buys is not fewer hops, it's a different transport.
// The relay runs over TCP, which cannot discard a late frame -- when the network
// tightens it delivers everything, in order, later, so the picture doesn't degrade, it
// falls into the past. WebRTC runs over SRTP/UDP: it drops its own bitrate on detecting
// loss, repairs with NACK, and abandons stale frames. It degrades quality instead of
// time. When it can't be established at all (symmetric NAT with no TURN, a sandbox that
// blocks it, a corporate network), nothing happens and the viewer just stays on the
// relay -- which is exactly why the WebCodecs path stays in the codebase.

/** The viewer connection holding `peerId` in this room, if it's still around. */
function findViewerByPeerId(room: Room, peerId: string): WebSocket | null {
  let found: WebSocket | null = null;
  room.forEachViewer((viewer) => {
    if (getState(viewer).peerId === peerId) found = viewer;
  });
  return found;
}

/**
 * Introduces a viewer to the presenter it's watching so the presenter offers it a
 * direct connection. The side holding the media is the side that offers.
 *
 * Skipped for a paused connection (it isn't being sent anything anyway) and for an
 * audio-only one: with video arriving over a peer connection the server could no
 * longer filter it out, so "audio only" would quietly stop saving any bandwidth --
 * the entire point of that mode. Also skipped for your own broadcast, which no viewer
 * ever renders back to itself.
 */
function inviteDirectConnection(room: Room, ws: WebSocket, state: ConnectionState): void {
  if (state.isPaused || state.videoDisabled) return;

  const presenter = room.getPresenter(state.selectedSlot);
  if (!presenter || presenter.ws === ws) return;
  if (presenter.presenterId !== null && presenter.presenterId === state.userId) return;

  debugLog(state, `rtc-want sent to presenter (slot ${state.selectedSlot})`);
  send(presenter.ws, { kind: "rtc-want", peerId: state.peerId });
}

/** Same, for every viewer currently watching `slot` -- used when a broadcast appears. */
function inviteViewersOfSlot(room: Room, slot: number): void {
  room.forEachViewer((viewer) => {
    const viewerState = getState(viewer);
    if (viewerState.selectedSlot !== slot) return;
    inviteDirectConnection(room, viewer, viewerState);
  });
}

/**
 * Tears down this viewer's direct connection to `slot` and puts it back on the relay.
 *
 * Resetting `hasReceivedKeyframe` matters: whatever decoder the viewer falls back to is
 * cold, and without a fresh keyframe it would sit on a frozen frame until the next
 * scheduled one -- up to KEYFRAME_INTERVAL_MS away. Callers that still have a live
 * presenter follow this with requestKeyframeFromSlot().
 */
function endDirectConnection(room: Room, state: ConnectionState, slot: number): void {
  const presenter = room.getPresenter(slot);
  if (presenter) send(presenter.ws, { kind: "rtc-bye", peerId: state.peerId });

  if (state.rtcActiveSlot === slot) {
    state.rtcActiveSlot = null;
    state.hasReceivedKeyframe = false;
  }
}

/**
 * Tells the presenter of `slot` whether anyone still needs the WebSocket relay.
 *
 * Once every viewer of a broadcast is on a direct connection -- or nobody is watching
 * it at all -- the WebCodecs encode produces frames with nowhere to go, while the
 * presenter's upload is being contended for by the peer connections that *are*
 * carrying the picture. Recomputed from scratch on every event that could change the
 * answer and sent only when it actually flips, since the inputs change far more often
 * than the result.
 */
function updateRelayChunks(room: Room, slot: number): void {
  const presenter = room.getPresenter(slot);
  if (!presenter) return;

  let needsRelay = false;
  room.forEachViewer((viewer) => {
    const viewerState = getState(viewer);
    if (viewerState.selectedSlot !== slot) return;
    if (viewerState.isPaused) return;
    if (viewerState.rtcActiveSlot === slot) return;
    // An audio-only viewer still counts: its audio comes over the relay.
    needsRelay = true;
  });

  if (presenter.relayChunksEnabled === needsRelay) return;
  console.info(`[debug-video-toggle] ${new Date().toISOString().slice(11, 23)} relay-chunks slot ${slot} -> ${needsRelay}`);
  presenter.relayChunksEnabled = needsRelay;
  send(presenter.ws, { kind: "relay-chunks", enabled: needsRelay });
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
    // Already getting this broadcast straight from the presenter, audio included.
    if (viewerState.rtcActiveSlot === slot) return;

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

  // Admins skip the membership check on purpose: monitoring rooms across servers means
  // opening broadcasts in channels they are not connected to, which is the whole point
  // of the active-broadcast list.
  if (message.guildId && message.userId && !isAdmin(message.userId)) {
    const allowed = await isUserInVoiceChannel(message.guildId, message.roomId, message.userId);
    if (!allowed) {
      send(ws, { kind: "error", message: "You must be in this voice channel to join." });
      return;
    }
  }

  // Re-joining on a live socket (an admin hopping to another room) has to leave the old
  // one first, or this connection stays a viewer there and keeps being sent its frames
  // -- paying for two streams while watching one.
  if (state.roomId && state.roomId !== message.roomId) {
    const previous = roomManager.getRoom(state.roomId);
    if (previous) {
      previous.removeViewer(ws);
      broadcastControl(previous, { kind: "viewer-count", count: previous.viewerCount });
      roomManager.removeRoomIfEmpty(state.roomId);
    }
  }

  state.roomId = message.roomId;
  state.userId = message.userId;
  // Recorded so the admin list can name the server a room belongs to. Only set once:
  // it never changes for a given channel, and later joins may omit it.
  room.guildId ??= message.guildId;
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

  // Sent after "joined" so the client has its room state before any signalling shows
  // up. The relay starts delivering immediately either way; this only opens the
  // attempt at a better transport alongside it.
  updateRelayChunks(room, state.selectedSlot);
  inviteDirectConnection(room, ws, state);
}

function handleControlMessage(ws: WebSocket, message: ControlMessage): void {
  const state = getState(ws);

  switch (message.kind) {
    case "join": {
      // Async, so the try/catch around handleMessage in wsServer.ts never sees its
      // errors -- left unhandled, one bad join takes the whole relay down for everyone.
      handleJoin(ws, state, message).catch((error) => console.error("Failed to handle join:", error));
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
      // Viewers already sitting on this slot (it was empty until now, or they were
      // moved here when another broadcast ended) never got introduced to anyone.
      updateRelayChunks(room, slot);
      inviteViewersOfSlot(room, slot);
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

      const previousSlot = state.selectedSlot;
      // A direct connection was negotiated around one broadcast's tracks; watching a
      // different one means a different peer entirely, so this one goes away.
      endDirectConnection(room, state, previousSlot);

      state.selectedSlot = message.slot;
      state.hasReceivedKeyframe = false; // new stream, decoder starts cold
      requestKeyframeFromSlot(room, message.slot);
      // The broadcast just left may have nobody on the relay anymore; the one just
      // joined definitely has one more.
      updateRelayChunks(room, previousSlot);
      updateRelayChunks(room, message.slot);
      inviteDirectConnection(room, ws, state);
      return;
    }

    // Admin-only, unconditionally: unlike stopping a broadcast there's no "your own"
    // case that anyone may do, so this needs no slot comparison -- reject any request
    // from a non-admin outright.
    case "play-alert": {
      if (!state.roomId || !isAdmin(state.userId) || message.slot === undefined) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      const presenter = room.getPresenter(message.slot);
      if (presenter) send(presenter.ws, { kind: "play-alert" });
      return;
    }

    // Everyone gets the list -- it's how a viewer picks which broadcast to watch -- but
    // only an admin sees other rooms. Scoped here rather than trusted to the client:
    // a non-admin's list never even contains another channel's broadcasts.
    case "request-active-broadcasts": {
      if (isAdmin(state.userId)) {
        void sendActiveBroadcasts(ws, null);
      } else if (state.roomId) {
        void sendActiveBroadcasts(ws, state.roomId);
      }
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
      updateRelayChunks(room, state.selectedSlot);
      requestKeyframeFromSlot(room, state.selectedSlot);
      inviteDirectConnection(room, ws, state);
      return;
    }

    // Audio-only toggle: doesn't touch room membership or the pause mechanism, just
    // which frame types get forwarded to this specific connection (see handleMessage).
    case "set-video-enabled": {
      debugLog(state, `set-video-enabled ${message.enabled} (rtcActiveSlot before: ${state.rtcActiveSlot})`);
      state.videoDisabled = !message.enabled;
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      if (message.enabled) {
        state.hasReceivedKeyframe = false; // missed whatever aired while video was off
        requestKeyframeFromSlot(room, state.selectedSlot);
        inviteDirectConnection(room, ws, state);
      } else {
        // Video has to arrive over the relay for the server to be able to withhold it:
        // a peer connection carries the whole broadcast or none of it, so staying on a
        // direct connection here would mean "audio only" saved nothing at all.
        endDirectConnection(room, state, state.selectedSlot);
      }
      updateRelayChunks(room, state.selectedSlot);
      return;
    }

    /**
     * Signalling relay. The envelope is never opened -- only re-addressed, and always
     * from server-side state: a presenter says which viewer (`peerId`) and the server
     * fills in the slot; a viewer says which slot and the server fills in its own
     * `peerId`. Neither can reach a peer it wasn't introduced to, and a viewer can only
     * signal about the broadcast it is actually watching.
     */
    case "rtc-signal": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      const presenterSlot = room.slotOf(ws);
      if (presenterSlot !== null) {
        if (!message.peerId) return;
        const viewer = findViewerByPeerId(room, message.peerId);
        if (viewer) send(viewer, { kind: "rtc-signal", slot: presenterSlot, payload: message.payload });
        return;
      }

      if (message.slot === undefined || message.slot !== state.selectedSlot) return;
      if (message.payload.type !== "ice") debugLog(state, `viewer sent rtc ${message.payload.type}`);
      const presenter = room.getPresenter(message.slot);
      if (presenter) send(presenter.ws, { kind: "rtc-signal", peerId: state.peerId, payload: message.payload });
      return;
    }

    /**
     * The viewer reporting whether its direct connection is actually delivering. This
     * is the only thing that moves a viewer off the relay, and it deliberately isn't
     * the peer connection's own `connectionState`: a peer that reports "connected" and
     * then delivers nothing is indistinguishable from a working one, and cutting the
     * relay on its word leaves a black screen with every status light green.
     */
    case "rtc-active": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;
      if (message.slot !== state.selectedSlot) return;
      debugLog(state, `rtc-active ${message.active} (rtcActiveSlot before: ${state.rtcActiveSlot})`);

      if (message.active) {
        state.rtcActiveSlot = message.slot;
      } else {
        // Forwarded even when this viewer never took over: a negotiation that timed out
        // still left a peer connection open on the presenter's side, and it would go on
        // refusing to open a new one for this viewer until ICE eventually gives up.
        const presenter = room.getPresenter(message.slot);
        if (presenter) send(presenter.ws, { kind: "rtc-bye", peerId: state.peerId });

        if (state.rtcActiveSlot !== message.slot) return;
        state.rtcActiveSlot = null;
        state.hasReceivedKeyframe = false; // falling back onto a cold decoder
        requestKeyframeFromSlot(room, message.slot);
      }
      updateRelayChunks(room, message.slot);
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
    // No rtc-bye here: the presenter socket is the thing that just went away, so
    // there's nobody to tell. The viewer notices its peer die and cleans up its own
    // side; the server just stops believing the direct connection exists.
    if (viewerState.rtcActiveSlot === freedSlot) viewerState.rtcActiveSlot = null;
    if (fallback !== null) viewerState.selectedSlot = fallback;
  });

  broadcastStreams(room);
  if (fallback !== null) {
    updateRelayChunks(room, fallback);
    requestKeyframeFromSlot(room, fallback);
    inviteViewersOfSlot(room, fallback);
  }
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
      const departedSlot = state.selectedSlot;
      endDirectConnection(room, state, departedSlot);
      room.removeViewer(ws);
      broadcastControl(room, { kind: "viewer-count", count: room.viewerCount });
      // Recomputed after removeViewer so the leaver isn't counted: it may well have
      // been the last one still needing the relay for that broadcast.
      updateRelayChunks(room, departedSlot);
    }

    // If this connection had paused a sibling tab of the same user, that tab has
    // nothing else showing it the stream anymore -- resume it automatically.
    if (state.userId) resumeConnectionForUser(room, state.userId);

    roomManager.removeRoomIfEmpty(state.roomId);
  }

  connectionState.delete(ws);
}
