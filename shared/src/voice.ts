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
  /** Broadcasting a live to this room right now (see voiceLiveRoomId). */
  live?: boolean;
}

/**
 * A voice room's lives go through the screen-share relay like a Discord channel's, in a
 * relay room of its own. The prefix keeps those ids apart from Discord's (all digits),
 * and tells the relay to admit only the people seated in that voice room.
 */
export const VOICE_LIVE_ROOM_PREFIX = "voice:";

export function voiceLiveRoomId(voiceRoomId: string): string {
  return `${VOICE_LIVE_ROOM_PREFIX}${voiceRoomId}`;
}

/** The voice room a relay room carries the lives of, or null for any other relay room. */
export function voiceRoomIdOfLive(relayRoomId: string): string | null {
  return relayRoomId.startsWith(VOICE_LIVE_ROOM_PREFIX) ? relayRoomId.slice(VOICE_LIVE_ROOM_PREFIX.length) || null : null;
}

/**
 * Where an admin's player waits while they are in no call: a relay room only admins may
 * join and nobody may broadcast in. It is there so the admin can ask for every live and
 * hop straight into any of them.
 */
export const ADMIN_LOBBY_ROOM_ID = "lobby:admins";

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
  | { kind: "set-state"; muted: boolean; deafened: boolean }
  /** Admin only: closes a room, taking everyone in it out. The server checks the admin itself. */
  | { kind: "delete-room"; roomId: string }
  /** Admin only: turns voice rooms on or off for everyone; off closes every room. */
  | { kind: "set-enabled"; enabled: boolean };

export type VoiceServerMessage =
  /** `isAdmin` (ADMIN_USER_IDS) only says whether to offer deleting rooms. */
  | { kind: "welcome"; userId: string; isAdmin: boolean }
  /**
   * Every room, sent to everyone on any change -- there are few and they are small.
   * `enabled` is false while voice rooms are off: the default, until an admin turns them on (set-enabled).
   */
  | { kind: "rooms"; rooms: VoiceRoomInfo[]; enabled: boolean }
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
