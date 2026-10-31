/**
 * Who is in a room, for the viewer list (see request-viewers in the protocol). The
 * relay counts connections, but a person can hold several -- the Activity plus a
 * browser tab, or the desktop app's player plus its capture side -- so the list
 * collapses them into one entry per user.
 */

/** What the relay knows about one viewer connection, as far as the list goes. */
export interface ViewerConnection {
  userId: string | null;
  /** The broadcast it receives; null when it watches none. */
  selectedSlot: number | null;
  /** Paused because the same user watches from another tab, so it receives nothing. */
  isPaused: boolean;
}

export interface RoomPerson {
  userId: string | null;
  slot: number | null;
}

/**
 * One entry per user, in join order, on the broadcast that user actually receives:
 * a paused sibling tab or a capture-only connection (watching nothing) never hides
 * the one that is watching. Anonymous connections each stay their own entry.
 */
export function listRoomPeople(connections: Iterable<ViewerConnection>): RoomPerson[] {
  const people: RoomPerson[] = [];
  const indexByUser = new Map<string, number>();

  for (const connection of connections) {
    const slot = connection.isPaused ? null : connection.selectedSlot;
    const { userId } = connection;
    const index = userId === null ? undefined : indexByUser.get(userId);

    if (index === undefined) {
      if (userId !== null) indexByUser.set(userId, people.length);
      people.push({ userId, slot });
    } else if (people[index]?.slot === null && slot !== null) {
      people[index] = { userId, slot };
    }
  }

  return people;
}
