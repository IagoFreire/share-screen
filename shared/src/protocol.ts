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
  view.setUint8(14, header.keyFrame ? FLAG_KEYFRAME : 0);

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
export interface StreamInfo {
  /** Which frame slot carries this broadcast; assigned by the server, never the client. */
  slot: number;
  presenterId: string | null;
  audio: AudioParams | null;
}

export type ControlMessage =
  /**
   * `userId` lets the server verify that a stop request comes from the presenter.
   * `guildId` is required (alongside `userId`) for the optional bot-token voice
   * membership check -- without it, verification is skipped for that connection even
   * if DISCORD_BOT_TOKEN is configured.
   */
  | { kind: "join"; roomId: string; userId: string | null; guildId: string | null }
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
  | { kind: "start-presenting"; presenterId: string | null; audio: AudioParams | null }
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
   *  A viewer receives exactly one stream at a time no matter how many are live. */
  | { kind: "select-stream"; slot: number }
  /**
   * Plays an attention chime in a presenter's capture tab -- for reaching someone who is
   * heads-down in a game with headphones on. Admin-only, same rule as ending a
   * broadcast.
   *
   * With `slot` it's the admin asking; the server then relays it without one to that
   * slot's presenter, mirroring how request-stop-presenting works.
   */
  | { kind: "play-alert"; slot?: number }
  | { kind: "viewer-count"; count: number }
  | { kind: "request-keyframe" }
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
  | { kind: "error"; message: string };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeControlMessage(slot: number, message: ControlMessage): Uint8Array {
  const payload = textEncoder.encode(JSON.stringify(message));
  return encodeFrame({ slot, type: FrameType.Control, timestamp: Date.now(), clock: 0 }, payload);
}

export function decodeControlMessage(frame: EncodedFrame): ControlMessage {
  return JSON.parse(textDecoder.decode(frame.payload)) as ControlMessage;
}
