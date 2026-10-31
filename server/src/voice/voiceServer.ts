import type { WebSocket } from "ws";
import {
  decodeVoiceControl,
  decodeVoiceFrame,
  encodeFrame,
  encodeVoiceControl,
  FrameType,
  VOICE_MAX_PACKET_BYTES,
  type EncodedFrame,
  type VoiceServerMessage,
} from "@screenshare-bot/shared";
import { config } from "../config.js";
import { verifySessionToken } from "../auth/session.js";
import { clearBackpressureState, sendOrDrop } from "../ws/backpressure.js";
import { VoiceRooms, type MemberProfile } from "./voiceRooms.js";

/**
 * The /voice WebSocket (see shared/src/voice.ts): signs a desktop session in, keeps the
 * room list in step for everyone, and forwards each speaker's Opus packets to the rest
 * of their room. Only desktop sessions get in -- the signed session is the identity.
 */

const rooms = new VoiceRooms<WebSocket>();
/** Signed-in connections and who they are; a connection is here once its hello passed. */
const profiles = new Map<WebSocket, MemberProfile>();

const NAME_MAX = 64;
/** Avatars only from Discord's CDN, like the desktop page's img-src allows. */
const AVATAR_PREFIX = "https://cdn.discordapp.com/";

function send(ws: WebSocket, message: VoiceServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(encodeVoiceControl(message));
}

function broadcastRooms(): void {
  const message = encodeVoiceControl({ kind: "rooms", rooms: rooms.list() });
  for (const ws of profiles.keys()) if (ws.readyState === ws.OPEN) ws.send(message);
}

function tellSeat(ws: WebSocket): void {
  const seat = rooms.roomOf(ws);
  send(ws, { kind: "in-room", roomId: seat?.roomId ?? null, slot: seat?.slot ?? null });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function signIn(ws: WebSocket, message: Record<string, unknown>): void {
  if (profiles.has(ws)) return;
  const session = typeof message.session === "string" ? message.session : "";
  const userId = config.sessionSecret && session ? verifySessionToken(session, Date.now(), config.sessionSecret) : null;
  if (!userId) {
    send(ws, { kind: "error", message: "Sessão expirada. Entre de novo.", code: "invalid-session" });
    ws.close();
    return;
  }

  const name = typeof message.name === "string" ? message.name.trim().slice(0, NAME_MAX) : "";
  const avatarUrl =
    typeof message.avatarUrl === "string" && message.avatarUrl.startsWith(AVATAR_PREFIX) ? message.avatarUrl : null;
  profiles.set(ws, { userId, name: name || "Alguém", avatarUrl });
  send(ws, { kind: "welcome", userId });
  send(ws, { kind: "rooms", rooms: rooms.list() });
}

function handleControl(ws: WebSocket, raw: unknown): void {
  const message = asRecord(raw);
  if (!message) return;
  if (message.kind === "hello") {
    signIn(ws, message);
    return;
  }

  const profile = profiles.get(ws);
  if (!profile) return;

  switch (message.kind) {
    case "create-room":
    case "join-room": {
      const result =
        message.kind === "create-room"
          ? rooms.create(typeof message.name === "string" ? message.name : "", ws, profile)
          : rooms.join(typeof message.roomId === "string" ? message.roomId : "", ws, profile);
      if (!result.ok) {
        send(ws, { kind: "error", message: result.error });
        return;
      }
      for (const other of result.displaced) tellSeat(other);
      tellSeat(ws);
      broadcastRooms();
      return;
    }
    case "leave-room":
      rooms.leave(ws);
      tellSeat(ws);
      broadcastRooms();
      return;
    case "set-state":
      rooms.setState(ws, { muted: message.muted === true, deafened: message.deafened === true });
      broadcastRooms();
      return;
    default:
      return;
  }
}

/** A speaker's packet goes to everyone else in the room who isn't deafened, stamped with their seat. */
function forwardAudio(ws: WebSocket, frame: EncodedFrame): void {
  if (frame.payload.byteLength > VOICE_MAX_PACKET_BYTES || !rooms.canSpeak(ws)) return;
  const seat = rooms.roomOf(ws);
  if (!seat) return;
  const outgoing = encodeFrame({ ...frame, slot: seat.slot, type: FrameType.Audio }, frame.payload);
  for (const listener of rooms.listenersOf(ws)) sendOrDrop(listener, outgoing, "audio");
}

export function handleVoiceMessage(ws: WebSocket, data: Uint8Array): void {
  const frame = decodeVoiceFrame(data);
  if (frame.type === FrameType.Control) handleControl(ws, decodeVoiceControl(frame));
  else if (frame.type === FrameType.Audio && profiles.has(ws)) forwardAudio(ws, frame);
}

export function handleVoiceClose(ws: WebSocket): void {
  clearBackpressureState(ws);
  const wasSeated = rooms.roomOf(ws) !== null;
  rooms.leave(ws);
  profiles.delete(ws);
  if (wasSeated) broadcastRooms();
}
