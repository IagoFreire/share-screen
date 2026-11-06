import { ADMIN_LOBBY_ROOM_ID, VOICE_LIVE_ROOM_PREFIX, voiceRoomIdOfLive } from "@screenshare-bot/shared";

/**
 * Who may join the relay rooms that aren't Discord voice channels: a desktop voice
 * room's lives (voiceLiveRoomId) and the admins' lobby. Discord channels keep their own
 * check (verifyMember.ts); this returns null for them so the relay applies that instead.
 */

export interface JoiningUser {
  userId: string | null;
  /** The id came from a signed desktop session, not the client's word. */
  verified: boolean;
  isAdmin: boolean;
}

export type RoomAccess = { ok: true } | { ok: false; message: string };

const NEEDS_DESKTOP = "Abra pelo app Janja para ver as lives das salas de voz.";
const NOT_SEATED = "Entre na sala de voz para ver as lives dela.";
const ADMINS_ONLY = "Só admins podem entrar aqui.";

export function specialRoomAccess(
  roomId: string,
  user: JoiningUser,
  isSeated: (voiceRoomId: string, userId: string) => boolean,
): RoomAccess | null {
  if (roomId === ADMIN_LOBBY_ROOM_ID) return user.isAdmin ? { ok: true } : { ok: false, message: ADMINS_ONLY };
  if (!roomId.startsWith(VOICE_LIVE_ROOM_PREFIX)) return null;

  // A claimed id proves nothing: voice rooms only know desktop sessions.
  if (!user.verified || !user.userId) return { ok: false, message: NEEDS_DESKTOP };
  if (user.isAdmin) return { ok: true };
  const voiceRoomId = voiceRoomIdOfLive(roomId);
  return voiceRoomId !== null && isSeated(voiceRoomId, user.userId) ? { ok: true } : { ok: false, message: NOT_SEATED };
}

/** The lobby only lists lives; going live there would broadcast to nobody's room. */
export function canPresentIn(roomId: string): boolean {
  return roomId !== ADMIN_LOBBY_ROOM_ID;
}
