import { randomUUID } from "node:crypto";
import {
  VOICE_MAX_MEMBERS,
  VOICE_MAX_ROOMS,
  VOICE_ROOM_NAME_MAX,
  type VoiceMember,
  type VoiceRoomInfo,
} from "@screenshare-bot/shared";

/**
 * Who is in which voice room (shared/src/voice.ts), with no I/O: voiceServer.ts owns
 * the sockets and asks this for seats and listeners. `C` is whatever identifies a
 * connection -- the WebSocket in production, a string in tests.
 *
 * Rooms live only in memory and only while someone is in them.
 */

export interface MemberProfile {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

export type SeatResult<C> =
  | { ok: true; roomId: string; slot: number; displaced: C[] }
  | { ok: false; error: string };

interface Seat<C> {
  conn: C;
  member: VoiceMember;
}

interface Room<C> {
  id: string;
  name: string;
  seats: Array<Seat<C>>;
}

/** Trims, drops control characters, collapses spaces and cuts to the limit. */
function cleanName(raw: string): string {
  return raw
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, VOICE_ROOM_NAME_MAX);
}

export class VoiceRooms<C> {
  private readonly rooms: Array<Room<C>> = [];

  create(rawName: string, conn: C, profile: MemberProfile): SeatResult<C> {
    const name = cleanName(rawName);
    if (!name) return { ok: false, error: "Dê um nome para a sala." };
    if (this.rooms.length >= VOICE_MAX_ROOMS) return { ok: false, error: "Já tem salas demais abertas agora." };

    const room: Room<C> = { id: randomUUID(), name, seats: [] };
    this.rooms.push(room);
    return this.seat(room, conn, profile);
  }

  join(roomId: string, conn: C, profile: MemberProfile): SeatResult<C> {
    const room = this.rooms.find((candidate) => candidate.id === roomId);
    if (!room) return { ok: false, error: "Essa sala não existe mais." };
    const alreadyHere = room.seats.some((seat) => seat.conn === conn);
    if (!alreadyHere && room.seats.length >= VOICE_MAX_MEMBERS) return { ok: false, error: "A sala está cheia." };
    return this.seat(room, conn, profile);
  }

  /** Takes `conn` out of its room, deleting the room if it is now empty. */
  leave(conn: C): void {
    const room = this.roomWith(conn);
    if (!room) return;
    room.seats = room.seats.filter((seat) => seat.conn !== conn);
    if (room.seats.length === 0) this.rooms.splice(this.rooms.indexOf(room), 1);
  }

  setState(conn: C, state: { muted: boolean; deafened: boolean }): void {
    const seat = this.roomWith(conn)?.seats.find((candidate) => candidate.conn === conn);
    if (!seat) return;
    // Deafened implies muted, as in Discord: you can't talk to a room you can't hear.
    seat.member = { ...seat.member, muted: state.muted || state.deafened, deafened: state.deafened };
  }

  roomOf(conn: C): { roomId: string; slot: number } | null {
    const room = this.roomWith(conn);
    const seat = room?.seats.find((candidate) => candidate.conn === conn);
    return room && seat ? { roomId: room.id, slot: seat.member.slot } : null;
  }

  /** Whether audio from `conn` should go anywhere: seated and not muted. */
  canSpeak(conn: C): boolean {
    const seat = this.roomWith(conn)?.seats.find((candidate) => candidate.conn === conn);
    return seat !== undefined && !seat.member.muted;
  }

  /** The other members of `conn`'s room who want to hear it (not deafened). */
  listenersOf(conn: C): C[] {
    const room = this.roomWith(conn);
    if (!room) return [];
    return room.seats.filter((seat) => seat.conn !== conn && !seat.member.deafened).map((seat) => seat.conn);
  }

  list(): VoiceRoomInfo[] {
    return this.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      members: room.seats.map((seat) => seat.member),
    }));
  }

  private roomWith(conn: C): Room<C> | undefined {
    return this.rooms.find((room) => room.seats.some((seat) => seat.conn === conn));
  }

  /** Sits `conn` in `room`: out of any other room first, and the same person's other devices out too. */
  private seat(room: Room<C>, conn: C, profile: MemberProfile): SeatResult<C> {
    const current = this.roomWith(conn);
    if (current && current !== room) this.leave(conn);

    const displaced = this.rooms
      .flatMap((candidate) => candidate.seats)
      .filter((seat) => seat.conn !== conn && seat.member.userId === profile.userId)
      .map((seat) => seat.conn);
    for (const other of displaced) this.leave(other);

    const existing = room.seats.find((seat) => seat.conn === conn);
    if (existing) return { ok: true, roomId: room.id, slot: existing.member.slot, displaced };

    const taken = new Set(room.seats.map((seat) => seat.member.slot));
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    room.seats.push({
      conn,
      member: { slot, userId: profile.userId, name: profile.name, avatarUrl: profile.avatarUrl, muted: false, deafened: false },
    });
    // Displacing the same person may have emptied (and dropped) this very room: keep it.
    if (!this.rooms.includes(room)) this.rooms.push(room);
    return { ok: true, roomId: room.id, slot, displaced };
  }
}
