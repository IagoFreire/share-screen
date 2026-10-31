/**
 * Binary WebSocket frame protocol shared by client and server.
 *
 * Wire format (all multi-byte fields little-endian):
 *   [1 byte  slot     ] which track this frame belongs to (see SLOT_* constants)
 *   [1 byte  type      ] FrameType
 *   [8 bytes timestamp ] capture/send time, ms since epoch (double, for A/V sync)
 *   [4 bytes clock     ] monotonically increasing per-slot sequence number (uint32)
 *   [1 byte  flags     ] bit 0 = keyFrame (video only, ignored otherwise)
 *   [N bytes payload   ] raw encoded chunk (H.264 Annex B video, Opus audio) or UTF-8 JSON for control
 *
 * Header is fixed at 15 bytes; everything after is the payload.
 */

export const FRAME_HEADER_BYTES = 15;

const FLAG_KEYFRAME = 0b0000_0001;
/** Bits 1-2: simulcast layer (0 = best). Senders that predate simulcast leave them 0. */
const LAYER_SHIFT = 1;
const LAYER_MASK = 0b0000_0110;

export enum FrameType {
  Video = 0,
  Audio = 1,
  Control = 2,
}

/** Reserved slot numbers. A room currently supports a single presenter. */
export const SLOT_PRESENTER = 0;
/** Slots >= SLOT_VIEWER_BASE are assigned per-connection when needed (rarely used for uplink). */
export const SLOT_VIEWER_BASE = 1;

export interface FrameHeader {
  slot: number;
  type: FrameType;
  timestamp: number;
  clock: number;
  /** Only meaningful for FrameType.Video; ignored for audio/control. */
  keyFrame?: boolean;
  /** Simulcast layer of a video frame, 0 (best) to 3; 0 when the sender sends one. */
  layer?: number;
}

export interface EncodedFrame extends FrameHeader {
  payload: Uint8Array;
}

export function encodeFrame(header: FrameHeader, payload: Uint8Array): Uint8Array {
  const buffer = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer.buffer);

  view.setUint8(0, header.slot);
  view.setUint8(1, header.type);
  view.setFloat64(2, header.timestamp, true);
  view.setUint32(10, header.clock >>> 0, true);
  view.setUint8(14, (header.keyFrame ? FLAG_KEYFRAME : 0) | (((header.layer ?? 0) << LAYER_SHIFT) & LAYER_MASK));

  buffer.set(payload, FRAME_HEADER_BYTES);
  return buffer;
}

export function decodeFrame(data: ArrayBuffer | Uint8Array): EncodedFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < FRAME_HEADER_BYTES) {
    throw new Error(`frame too short: ${bytes.byteLength} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint8(14);

  return {
    slot: view.getUint8(0),
    type: view.getUint8(1) as FrameType,
    timestamp: view.getFloat64(2, true),
    clock: view.getUint32(10, true),
    keyFrame: (flags & FLAG_KEYFRAME) !== 0,
    layer: (flags & LAYER_MASK) >> LAYER_SHIFT,
    payload: bytes.subarray(FRAME_HEADER_BYTES),
  };
}

// ---- Control-channel messages (sent as FrameType.Control, JSON-encoded UTF-8 payload) ----

/**
 * Actual parameters of the presenter's Opus stream. The viewer's AudioDecoder must be
 * configured with exactly these -- assuming 48kHz stereo silently breaks playback when
 * the captured source is mono (common for Windows system audio).
 * `null` means the presenter is sharing without audio.
 */
export interface AudioParams {
  sampleRate: number;
  channels: number;
}

/**
 * One live broadcast within a room. A room supports several at once (up to
 * MAX_PRESENTERS_PER_ROOM), each pinned to the frame header's `slot` field, and every
 * viewer picks exactly one to watch at a time -- so egress stays "viewers x bitrate"
 * regardless of how many people are broadcasting.
 */
/** One simulcast version of a broadcast; `layer` 0 is the best. */
export interface LayerInfo {
  layer: number;
  height: number;
  framerate: number;
}

export interface StreamInfo {
  /** Which frame slot carries this broadcast; assigned by the server, never the client. */
  slot: number;
  presenterId: string | null;
  audio: AudioParams | null;
  /** Simulcast versions on offer; absent for single-version senders (the browser tab). */
  layers?: LayerInfo[];
  /**
   * Nobody but the presenter is watching, so the presenter sends nothing (see
   * audience-changed). Picking it brings it back within a keyframe.
   */
  paused?: boolean;
}

/**
 * One live broadcast anywhere on this relay, for the broadcast list.
 *
 * Names are resolved server-side through the bot token and are null whenever that
 * lookup isn't possible (no token configured, bot not in that guild, API hiccup); the
 * ids are always present so the UI can fall back to them rather than showing nothing.
 */
export interface ActiveBroadcast {
  /** Voice channel id, which is what a room is keyed by. */
  roomId: string;
  guildId: string | null;
  guildName: string | null;
  channelName: string | null;
  slot: number;
  presenterId: string | null;
  presenterName: string | null;
  /** Viewers in that room, across all of its broadcasts. */
  viewerCount: number;
}

/**
 * One person in a room, for the viewer list. A user's several connections (the
 * Activity plus a browser tab, the desktop app's player plus its capture side) are one
 * entry. `name` is resolved like ActiveBroadcast's and null when that isn't possible;
 * `userId` is null for a connection that never said who it is.
 */
export interface RoomViewer {
  userId: string | null;
  name: string | null;
  /** The broadcast they receive; null when they watch none. */
  slot: number | null;
}

/** The Discord account a desktop-app session belongs to, as the app displays it. */
export interface DesktopUser {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
}

/** The voice channel a desktop user is in right now (GET /api/desktop/voice). */
export interface VoiceLocation {
  guildId: string;
  guildName: string | null;
  guildIconUrl: string | null;
  channelId: string;
  channelName: string | null;
}

/** POST /api/desktop/login response: a signed session plus who it belongs to. */
export interface DesktopLoginResponse {
  session: string;
  user: DesktopUser;
}

export type ControlMessage =
  /**
   * `userId` lets the server verify that a stop request comes from the presenter.
   * `guildId` is required (alongside `userId`) for the optional bot-token voice
   * membership check -- without it, verification is skipped for that connection even
   * if DISCORD_BOT_TOKEN is configured.
   *
   * `session` (desktop app only) is a signed login; when present the server takes the
   * user id from it and ignores `userId`, and an invalid one is refused outright.
   * `presenterOnly` marks a connection that only broadcasts (the desktop app's capture
   * side), so it doesn't pause the same user's player connection. It also watches
   * nothing, as does a join with `watchNothing` (a viewer who left the live before
   * reconnecting); any other join starts on the lowest live broadcast.
   */
  | {
      kind: "join";
      roomId: string;
      userId: string | null;
      guildId: string | null;
      session?: string | null;
      presenterOnly?: boolean;
      watchNothing?: boolean;
    }
  | {
      kind: "joined";
      roomId: string;
      /** Every broadcast currently live in the room; empty when nobody is presenting. */
      streams: StreamInfo[];
      viewerCount: number;
      /** Whether this connection may end other people's broadcasts (ADMIN_USER_IDS).
       *  Purely so the UI knows whether to offer the control -- the server re-checks
       *  on every request and never trusts the client's word for it. */
      isAdmin: boolean;
    }
  /** Sent by the presenter tab (present.html). `presenterId` is the Discord user id
   *  so the Activity can tell "someone is presenting" from "*I* am presenting". */
  | { kind: "start-presenting"; presenterId: string | null; audio: AudioParams | null; layers?: LayerInfo[] }
  /** Server -> presenter tab: which slot was allocated. The tab must stamp this on every
   *  frame it sends; the relay overwrites it anyway, but matching avoids confusion. */
  | { kind: "presenting-started"; slot: number }
  | { kind: "stop-presenting" }
  /**
   * Activity -> server -> presenter socket: asks a presenting tab to stop, so the user
   * can end a broadcast from inside Discord instead of hunting for the browser tab that
   * is actually doing the capture.
   *
   * `slot` targets someone else's broadcast and is honoured only for an admin; omitted,
   * it means "end my own", which anyone may do.
   */
  | { kind: "request-stop-presenting"; slot?: number }
  /** Broadcast whenever a stream starts or stops, replacing the whole list so viewers
   *  never have to reconstruct it from deltas. */
  | { kind: "streams-changed"; streams: StreamInfo[] }
  /** Client -> server: watch this slot and stop receiving whatever it was watching.
   *  A viewer receives exactly one stream at a time no matter how many are live;
   *  `null` receives none ("Sair da live") until the viewer picks one again.
   *  `preview` says a presenter opened their own broadcast on purpose: its picture
   *  then keeps flowing for them (see audience-changed). */
  | { kind: "select-stream"; slot: number | null; preview?: boolean }
  /**
   * Client -> server: which simulcast version this viewer wants. "auto" lets the relay
   * pick from what the viewer's connection keeps up with (see server/src/ws/autoLayer.ts).
   */
  | { kind: "select-layer"; layer: number | "auto" }
  /** Server -> client: the version now being sent, and whether "auto" chose it. */
  | { kind: "layer-changed"; layer: number; auto: boolean }
  /**
   * Plays an attention chime in a presenter's capture tab -- for reaching someone who is
   * heads-down in a game with headphones on. Admin-only, same rule as ending a
   * broadcast.
   *
   * With `slot` it's the admin asking; the server then relays it without one to that
   * slot's presenter, mirroring how request-stop-presenting works.
   */
  | { kind: "play-alert"; slot?: number }
  /**
   * The broadcast list: this channel's broadcasts for everyone, every broadcast on the
   * relay (other Discord servers included) for an admin. Polled by the client while the
   * list is open rather than pushed, so the server doesn't have to track which sockets
   * have a panel showing.
   */
  | { kind: "request-active-broadcasts" }
  | { kind: "active-broadcasts"; broadcasts: ActiveBroadcast[] }
  | { kind: "viewer-count"; count: number }
  /** Who is in this room (the viewer list). Polled while the list is open, like the
   *  broadcast list, rather than pushed on every join and leave. */
  | { kind: "request-viewers" }
  | { kind: "viewers"; viewers: RoomViewer[] }
  /**
   * Server -> presenter: how many other people receive this broadcast (`watchers`), and
   * how many viewers want its picture (`videoWatchers`, which also counts the presenter's
   * own preview when they opened it on purpose). With no watchers the presenter stops
   * sending audio, and with no video watchers it stops the video -- upload nobody would
   * hear or see. Sent on start and whenever either number changes.
   */
  | { kind: "audience-changed"; watchers: number; videoWatchers: number }
  /** Viewer -> server, and server -> presenter; `layer` (to the presenter) names the encoder. */
  | { kind: "request-keyframe"; layer?: number }
  /**
   * Server -> the *other* connection when the same user (matched by userId) joins the
   * room again from a second tab (e.g. opens "assistir numa aba do navegador" while the
   * Activity is still open). Video/audio stop flowing to the paused connection so the
   * same stream isn't sent twice to the same person -- each extra copy is a full extra
   * viewer's worth of egress for zero benefit, since nobody is watching it.
   */
  | { kind: "viewing-paused" }
  /** Server -> a paused connection once frames resume flowing to it again. */
  | { kind: "viewing-resumed" }
  /** Client -> server: explicitly resume a paused connection (e.g. "Retomar aqui" in
   *  the Activity) without waiting for the other tab to disconnect. */
  | { kind: "resume-viewing" }
  /**
   * Client -> server: this viewer wants (or no longer wants) video frames -- audio
   * keeps flowing either way. For someone who only wants to listen along (e.g. music)
   * without watching, this saves the video share of their egress for as long as it's
   * off, unlike pausing the whole connection.
   */
  | { kind: "set-video-enabled"; enabled: boolean }
  | { kind: "room-full" }
  /** `code` is set when the client should react, not just show the text. */
  | { kind: "error"; message: string; code?: "invalid-session" };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeControlMessage(slot: number, message: ControlMessage): Uint8Array {
  const payload = textEncoder.encode(JSON.stringify(message));
  return encodeFrame({ slot, type: FrameType.Control, timestamp: Date.now(), clock: 0 }, payload);
}

export function decodeControlMessage(frame: EncodedFrame): ControlMessage {
  return JSON.parse(textDecoder.decode(frame.payload)) as ControlMessage;
}
