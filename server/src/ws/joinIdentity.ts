/**
 * Who a joining connection really is. The Activity and browser tabs only declare a
 * userId; the desktop app proves one with a signed session, and when it does, the
 * proven id wins over whatever the message claims -- so a desktop connection can't be
 * talked into acting as someone else (an admin, say) by editing its join message.
 */
export type JoinIdentity = { ok: true; userId: string | null; verified: boolean } | { ok: false };

/**
 * Whether this join should pause the same user's other connections (the "you opened
 * another tab" bandwidth saving). A join that starts out watching nothing -- the
 * desktop app's capture side, or a player whose user left the live -- has nothing to
 * show them, so it must not take the stream away from the tab they do watch in.
 */
export function pausesSiblingConnections(message: { presenterOnly?: boolean; watchNothing?: boolean }): boolean {
  return !startsWatchingNothing(message);
}

/**
 * Whether this join starts out receiving no broadcast instead of the lowest live one:
 * a presenter-only connection never renders anything, and a viewer who left the live
 * ("Sair da live") stays out of it across a reconnect. Either would otherwise count as
 * an audience and keep somebody's broadcast running for nobody.
 */
export function startsWatchingNothing(message: { presenterOnly?: boolean; watchNothing?: boolean }): boolean {
  return message.presenterOnly === true || message.watchNothing === true;
}

export function resolveJoinIdentity(
  message: { userId: string | null; session?: string | null },
  verify: (token: string) => string | null,
): JoinIdentity {
  if (!message.session) return { ok: true, userId: message.userId, verified: false };

  const userId = verify(message.session);
  return userId ? { ok: true, userId, verified: true } : { ok: false };
}
