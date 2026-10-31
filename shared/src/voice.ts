import { decodeFrame, encodeFrame, FrameType, type EncodedFrame } from "./protocol.js";

/**
 * Voice rooms ("Salas de voz" in the desktop app): rooms anyone logged into the app can
 * create and talk in, on their own WebSocket (/voice) beside the screen-share relay. A
 * room exists while someone is in it and disappears with its last member.
 *
 * Audio travels as protocol.ts frames (FrameType.Audio, Opus mono 48 kHz); the server
 * stamps `slot` with the speaker's seat in the room, which is how listeners tell voices
 * apart. Control messages are FrameType.Control frames carrying JSON, as on /ws.
 */

export const VOICE_SAMPLE_RATE = 48_000;
export const VOICE_CHANNELS = 1;
export const VOICE_BITRATE_KBPS = 40;
export const VOICE_ROOM_NAME_MAX = 40;
export const VOICE_MAX_ROOMS = 30;
export const VOICE_MAX_MEMBERS = 12;
/** Larger than any Opus packet a 20 ms voice frame produces; anything bigger is dropped. */
export const VOICE_MAX_PACKET_BYTES = 4000;

export interface VoiceMember {
  /** Seat in the room; the `slot` on that member's audio frames. */
  slot: number;
  userId: string;
  name: string;
  avatarUrl: string | null;
  muted: boolean;
  deafened: boolean;
}

export interface VoiceRoomInfo {
  id: string;
  name: string;
  members: VoiceMember[];
}

export type VoiceClientMessage =
  /** First message: the desktop session proves who this is; name and avatar are for display. */
  | { kind: "hello"; session: string; name: string; avatarUrl: string | null }
  /** Creates a room and joins it. */
  | { kind: "create-room"; name: string }
  | { kind: "join-room"; roomId: string }
  | { kind: "leave-room" }
  | { kind: "set-state"; muted: boolean; deafened: boolean };

export type VoiceServerMessage =
  | { kind: "welcome"; userId: string }
  /** Every room, sent to everyone on any change -- there are few and they are small. */
  | { kind: "rooms"; rooms: VoiceRoomInfo[] }
  /** Where this connection is now; null when it isn't in a room (left, or joined elsewhere). */
  | { kind: "in-room"; roomId: string | null; slot: number | null }
  | { kind: "error"; message: string; code?: "invalid-session" };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeVoiceControl(message: VoiceClientMessage | VoiceServerMessage): Uint8Array {
  return encodeFrame(
    { slot: 0, type: FrameType.Control, timestamp: Date.now(), clock: 0 },
    textEncoder.encode(JSON.stringify(message)),
  );
}

/** The JSON a control frame carries; `unknown`, since the server must not trust it. */
export function decodeVoiceControl(frame: EncodedFrame): unknown {
  return JSON.parse(textDecoder.decode(frame.payload));
}

export { decodeFrame as decodeVoiceFrame };
