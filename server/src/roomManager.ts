import { config } from "./config.js";
import { Room } from "./ws/room.js";

/**
 * Global registry of active rooms. Caps concurrent rooms so both memory and the
 * bitrate x viewers egress budget (see docs/DEPLOY.md) stay bounded on a 1GB box.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly maxConcurrentRooms: number;
  private readonly maxViewersPerRoom: number;

  constructor(maxConcurrentRooms: number, maxViewersPerRoom: number) {
    this.maxConcurrentRooms = maxConcurrentRooms;
    this.maxViewersPerRoom = maxViewersPerRoom;
  }

  /** Returns null if the room doesn't exist yet and the concurrent-room cap is reached. */
  getOrCreateRoom(roomId: string): Room | null {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;

    if (this.rooms.size >= this.maxConcurrentRooms) {
      return null;
    }

    const room = new Room(roomId, this.maxViewersPerRoom);
    this.rooms.set(roomId, room);
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  removeRoomIfEmpty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.isEmpty()) {
      this.rooms.delete(roomId);
    }
  }

  get roomCount(): number {
    return this.rooms.size;
  }
}

export const roomManager = new RoomManager(config.maxConcurrentRooms, config.maxViewersPerRoom);
