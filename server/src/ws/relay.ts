import type { WebSocket } from "ws";
import {
  decodeFrame,
  decodeControlMessage,
  encodeControlMessage,
  encodeFrame,
  FrameType,
  SLOT_PRESENTER,
  type ControlMessage,
  type LayerInfo,
} from "@screenshare-bot/shared";
import { roomManager } from "../roomManager.js";
import { config } from "../config.js";
import type { Room } from "./room.js";
import { sendOrDrop, clearBackpressureState } from "./backpressure.js";
import { isUserInVoiceChannel } from "../auth/verifyMember.js";
import { verifySessionToken } from "../auth/session.js";
import { pausesSiblingConnections, resolveJoinIdentity, startsWatchingNothing } from "./joinIdentity.js";
import { createAutoLayer, type AutoLayer } from "./autoLayer.js";
import { countAudience } from "./audience.js";
import { listRoomPeople } from "./viewerList.js";

/** The frame header carries the layer in 2 bits. */
const MAX_LAYERS = 4;
import { resolveChannelName, resolveGuildName, resolveUserName } from "../auth/discordNames.js";

interface ConnectionState {
  roomId: string | null;
  /** Discord user id claimed by this connection; used to authorise stop requests and
   *  to pair up a user's multiple simultaneous connections (Activity + an externally
   *  opened tab) for the pause/resume bandwidth-saving below. */
  userId: string | null;
  /** True when `userId` came from a signed desktop session rather than the client's word;
   *  such a connection can't present under any other id (see start-presenting). */
  isVerified: boolean;
  /** Slot this connection broadcasts on, or null if it isn't presenting. */
  presenterSlot: number | null;
  /**
   * Which broadcast this connection is watching. A room can carry several at once but a
   * viewer receives exactly one, so this is what keeps egress at "viewers x bitrate"
   * rather than multiplying by however many people happen to be live. Null when it
   * watches none ("Sair da live"), which also stops it counting as an audience.
   */
  selectedSlot: number | null;
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
  /** A presenter watching their own broadcast because they opened it on purpose (see
   *  select-stream `preview`); its picture keeps flowing for them. */
  ownPreview: boolean;
  /** Which simulcast version this viewer asked for; "auto" lets autoLayer.ts decide. */
  layerChoice: number | "auto";
  /** The automatic choice for the watched broadcast, rebuilt when its layer count changes. */
  autoLayer: AutoLayer | null;
  autoLayerCount: number;
}

const connectionState = new WeakMap<WebSocket, ConnectionState>();

function getState(ws: WebSocket): ConnectionState {
  let state = connectionState.get(ws);
  if (!state) {
    state = {
      roomId: null,
      userId: null,
      isVerified: false,
      presenterSlot: null,
      selectedSlot: SLOT_PRESENTER,
      hasReceivedKeyframe: false,
      isPaused: false,
      videoDisabled: false,
      ownPreview: false,
      layerChoice: "auto",
      autoLayer: null,
      autoLayerCount: 0,
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

/** Sends who is in `room` (the viewer list), names looked up like the broadcast list's. */
async function sendViewers(ws: WebSocket, room: Room): Promise<void> {
  const connections: ConnectionState[] = [];
  room.forEachViewer((viewer) => connections.push(getState(viewer)));

  const viewers = await Promise.all(
    listRoomPeople(connections).map(async (person) => ({ ...person, name: await resolveUserName(person.userId) })),
  );
  send(ws, { kind: "viewers", viewers });
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

/**
 * Asks a presenter for a keyframe -- on one simulcast layer when `layer` is given. A
 * viewer watching nothing (`slot` null) has nobody to ask.
 */
function requestKeyframeFromSlot(room: Room, slot: number | null, layer?: number): void {
  const presenter = slot === null ? undefined : room.getPresenter(slot);
  if (presenter) send(presenter.ws, layer === undefined ? { kind: "request-keyframe" } : { kind: "request-keyframe", layer });
}

/** The simulcast layer this viewer receives from the broadcast on `slot`, the one it watches. */
function effectiveLayer(state: ConnectionState, room: Room, slot: number): number {
  const count = room.layerCountOf(slot);
  if (state.layerChoice !== "auto") return Math.min(state.layerChoice, count - 1);
  if (!state.autoLayer || state.autoLayerCount !== count) {
    state.autoLayer = createAutoLayer(count, Date.now());
    state.autoLayerCount = count;
  }
  return state.autoLayer.layer;
}

/** Moves a viewer onto its (new) layer: it needs that layer's next keyframe to decode. */
function announceLayer(ws: WebSocket, state: ConnectionState, room: Room): void {
  state.hasReceivedKeyframe = false;
  if (state.selectedSlot === null) return; // the choice applies once it picks a broadcast
  const layer = effectiveLayer(state, room, state.selectedSlot);
  requestKeyframeFromSlot(room, state.selectedSlot, layer);
  send(ws, { kind: "layer-changed", layer, auto: state.layerChoice === "auto" });
}

/**
 * Recounts who receives each broadcast and tells every presenter whose audience changed
 * (see "audience-changed"), so one nobody watches stops spending its upload. Safe to
 * call after any change to who watches what; presenters only hear about real changes.
 *
 * Returns whether some broadcast went from watched to unwatched or back, which changes
 * its `paused` flag in the stream list -- the caller decides when to announce that.
 */
function syncAudiences(room: Room): boolean {
  const viewers: ConnectionState[] = [];
  room.forEachViewer((viewer) => viewers.push(getState(viewer)));

  let pausedChanged = false;
  for (const { slot, presenterId } of room.streams) {
    const wasPaused = room.isPaused(slot);
    const audience = countAudience(viewers, slot, presenterId);
    if (!room.setAudience(slot, audience)) continue;

    const presenter = room.getPresenter(slot);
    if (presenter) send(presenter.ws, { kind: "audience-changed", ...audience });
    if (room.isPaused(slot) !== wasPaused) pausedChanged = true;
  }
  return pausedChanged;
}

/** syncAudiences, then the new stream list when a broadcast paused or resumed. */
function refreshAudiences(room: Room): void {
  if (syncAudiences(room)) broadcastStreams(room);
}

/** Simulcast layers announced by a presenter, or undefined when it sends a single version. */
function validLayers(value: unknown): LayerInfo[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_LAYERS) return undefined;
  const layers = value.map((entry: Partial<LayerInfo> | null) => ({
    layer: entry?.layer,
    height: entry?.height,
    framerate: entry?.framerate,
  }));
  const valid = layers.every(
    (entry, index) => entry.layer === index && Number.isFinite(entry.height) && Number.isFinite(entry.framerate),
  );
  return valid ? (layers as LayerInfo[]) : undefined;
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
  const isVideo = frame.type === FrameType.Video;
  const frameLayer = frame.layer ?? 0;
  const now = Date.now();

  room.forEachViewer((viewer) => {
    const viewerState = getState(viewer);
    if (viewerState.isPaused) return; // watching via another tab right now
    if (viewerState.selectedSlot !== slot) return; // watching a different broadcast

    if (isVideo) {
      if (viewerState.videoDisabled) return; // chose audio-only
      // Simulcast: exactly one version per viewer, so egress stays "viewers x one layer".
      if (frameLayer !== effectiveLayer(viewerState, room, slot)) return;
      if (!viewerState.hasReceivedKeyframe) {
        // Nothing this viewer's decoder can use yet -- skip rather than waste egress
        // on a frame it will just discard on arrival.
        if (!frame.keyFrame) return;
        viewerState.hasReceivedKeyframe = true;
      }
    }
    const result = sendOrDrop(viewer, outgoing, priority);

    if (isVideo && viewerState.layerChoice === "auto" && room.layerCountOf(slot) > 1) {
      if (viewerState.autoLayer?.report(result, now) != null) announceLayer(viewer, viewerState, room);
    }
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
  const identity = resolveJoinIdentity(message, (token) =>
    config.sessionSecret ? verifySessionToken(token, Date.now(), config.sessionSecret) : null,
  );
  if (!identity.ok) {
    send(ws, { kind: "error", message: "Sessão expirada. Entre de novo.", code: "invalid-session" });
    return;
  }
  const userId = identity.userId;

  const room = roomManager.getOrCreateRoom(message.roomId);
  if (!room || !room.canAddViewer()) {
    send(ws, { kind: "room-full" });
    return;
  }

  // Admins skip the membership check on purpose: monitoring rooms across servers means
  // opening broadcasts in channels they are not connected to, which is the whole point
  // of the active-broadcast list.
  if (message.guildId && userId && !isAdmin(userId)) {
    const allowed = await isUserInVoiceChannel(message.guildId, message.roomId, userId);
    if (!allowed) {
      send(ws, { kind: "error", message: "You must be in this voice channel to join." });
      return;
    }
  }

  // Re-joining on a live socket (an admin hopping to another room) has to leave the old
  // one first, or this connection stays a viewer there and keeps being sent its frames
  // -- paying for two streams while watching one.
  if (state.roomId && state.roomId !== message.roomId) {
    // A broadcasting socket holds a slot in its room; hopping would leave that slot
    // behind as a ghost broadcast nobody can end. Capture tabs never hop anyway.
    if (state.presenterSlot !== null) {
      send(ws, { kind: "error", message: "Stop broadcasting before switching rooms." });
      return;
    }
    const previous = roomManager.getRoom(state.roomId);
    if (previous) {
      previous.removeViewer(ws);
      broadcastControl(previous, { kind: "viewer-count", count: previous.viewerCount });
      // Same as a disconnect (see handleClose): a sibling tab this connection had
      // paused in the old room now has nothing showing it the stream.
      if (state.userId) resumeConnectionForUser(previous, state.userId);
      refreshAudiences(previous);
      roomManager.removeRoomIfEmpty(state.roomId);
    }
    // A pause belonged to the old room's sibling tab; carried over, this connection
    // would show as live while the relay withholds every frame from it.
    state.isPaused = false;
  }

  state.roomId = message.roomId;
  state.userId = userId;
  state.isVerified = identity.verified;
  // Recorded so the admin list can name the server a room belongs to. Only set once:
  // it never changes for a given channel, and later joins may omit it.
  room.guildId ??= message.guildId;
  room.addViewer(ws);

  // Default to the lowest live slot so a viewer joining mid-broadcast sees something
  // immediately rather than an empty player until they pick from the list.
  state.selectedSlot = startsWatchingNothing(message) ? null : (room.streams[0]?.slot ?? SLOT_PRESENTER);
  state.ownPreview = false; // a default pick is never a deliberate one
  state.hasReceivedKeyframe = false;

  if (userId && pausesSiblingConnections(message)) pauseOtherConnectionsForUser(room, userId, ws);

  // Counted before "joined" so the list it carries already shows the broadcast this
  // viewer just un-paused; everyone else hears about it right after.
  const pausedChanged = syncAudiences(room);
  send(ws, {
    kind: "joined",
    roomId: message.roomId,
    streams: room.streams,
    viewerCount: room.viewerCount,
    isAdmin: isAdmin(userId),
  });
  if (pausedChanged) broadcastStreams(room);
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

      const presenterId = state.isVerified ? state.userId : message.presenterId;
      const slot = room.allocateSlot(ws, presenterId, message.audio, validLayers(message.layers));
      if (slot === null) {
        send(ws, { kind: "error", message: "Room already has the maximum number of broadcasts." });
        return;
      }
      state.userId = presenterId;
      state.presenterSlot = slot;
      // A presenting socket stops being a viewer: it never watches its own stream.
      room.removeViewer(ws);

      send(ws, { kind: "presenting-started", slot });
      // Tells the new presenter right away whether anyone is watching yet.
      syncAudiences(room);
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

    // Switch which broadcast this viewer receives, or (null) stop receiving any. The old
    // stream stops flowing immediately, so watching two at once is never possible --
    // that's the whole reason extra presenters cost no extra egress.
    case "select-stream": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      const slot = message.slot;
      if (slot !== null && !Number.isInteger(slot)) return;
      state.selectedSlot = slot;
      state.ownPreview = slot !== null && message.preview === true;
      state.autoLayer = null; // the new broadcast's "auto" starts over from its best layer
      announceLayer(ws, state, room); // new stream, decoder starts cold
      refreshAudiences(room); // the old broadcast may have lost its last viewer, the new one gained one
      return;
    }

    case "select-layer": {
      if (!state.roomId) return;
      const room = roomManager.getRoom(state.roomId);
      if (!room) return;

      const choice = message.layer;
      if (choice !== "auto" && !(Number.isInteger(choice) && choice >= 0 && choice < MAX_LAYERS)) return;
      state.layerChoice = choice;
      state.autoLayer = null;
      announceLayer(ws, state, room);
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
    case "request-viewers": {
      const room = state.roomId ? roomManager.getRoom(state.roomId) : undefined;
      if (room) sendViewers(ws, room).catch((error) => console.error("Failed to send viewer list:", error));
      return;
    }

    case "request-active-broadcasts": {
      if (isAdmin(state.userId)) {
        sendActiveBroadcasts(ws, null).catch((error) => console.error("Failed to send broadcast list:", error));
      } else if (state.roomId) {
        sendActiveBroadcasts(ws, state.roomId).catch((error) => console.error("Failed to send broadcast list:", error));
      }
      return;
    }

    case "request-keyframe": {
      if (!state.roomId || state.selectedSlot === null) return;
      const room = roomManager.getRoom(state.roomId);
      if (room) requestKeyframeFromSlot(room, state.selectedSlot, effectiveLayer(state, room, state.selectedSlot));
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
      refreshAudiences(room);
      return;
    }

    // Audio-only toggle: doesn't touch room membership or the pause mechanism, just
    // which frame types get forwarded to this specific connection (see handleMessage).
    // It does change whether the presenter still needs to encode video at all.
    case "set-video-enabled": {
      state.videoDisabled = !message.enabled;
      const room = state.roomId ? roomManager.getRoom(state.roomId) : undefined;
      if (!room) return;
      if (message.enabled) {
        state.hasReceivedKeyframe = false; // missed whatever aired while video was off
        requestKeyframeFromSlot(room, state.selectedSlot);
      }
      refreshAudiences(room);
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
    viewerState.ownPreview = false; // whatever comes next, they didn't pick it
    if (fallback !== null) viewerState.selectedSlot = fallback;
  });

  syncAudiences(room); // the fallback just inherited those viewers
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

    refreshAudiences(room); // whatever it watched may have just lost its last viewer
    roomManager.removeRoomIfEmpty(state.roomId);
  }

  connectionState.delete(ws);
}
