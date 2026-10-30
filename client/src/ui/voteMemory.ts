/**
 * Who already got through the "em quem você votou?" poll (ui/votePoll.ts), so each
 * Discord user answers once per device instead of on every launch. Only a pass is
 * remembered -- which candidate isn't -- and it stays on this device's storage, never
 * the server. A Lula answer is not remembered: the app closes, and remembering it
 * would close it on every launch with no way left to even log out.
 *
 * The desktop app forgets a user when they log out; the Activity has no logout, so
 * there it lasts for that Discord account.
 */

type VoteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface VoteMemory {
  hasPassed(userId: string): boolean;
  remember(userId: string): void;
  forget(userId: string): void;
}

const KEY_PREFIX = "screenshare-bot:vote-passed:";

/** Without usable storage (blocked, private window) nobody is remembered: the poll just asks again. */
export function createVoteMemory(storage: VoteStorage | null): VoteMemory {
  const key = (userId: string) => `${KEY_PREFIX}${userId}`;
  return {
    hasPassed(userId) {
      try {
        return storage?.getItem(key(userId)) === "1";
      } catch {
        return false;
      }
    },
    remember(userId) {
      try {
        storage?.setItem(key(userId), "1");
      } catch {
        // Not remembered: the poll asks again next launch.
      }
    },
    forget(userId) {
      try {
        storage?.removeItem(key(userId));
      } catch {
        // Nothing to forget if it couldn't be stored.
      }
    },
  };
}

/** The page's localStorage, or null where reading it throws. */
export function browserVoteMemory(): VoteMemory {
  try {
    return createVoteMemory(window.localStorage);
  } catch {
    return createVoteMemory(null);
  }
}
