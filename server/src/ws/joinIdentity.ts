/**
 * Who a joining connection really is. The Activity and browser tabs only declare a
 * userId; the desktop app proves one with a signed session, and when it does, the
 * proven id wins over whatever the message claims -- so a desktop connection can't be
 * talked into acting as someone else (an admin, say) by editing its join message.
 */
export type JoinIdentity = { ok: true; userId: string | null; verified: boolean } | { ok: false };

export function resolveJoinIdentity(
  message: { userId: string | null; session?: string | null },
  verify: (token: string) => string | null,
): JoinIdentity {
  if (!message.session) return { ok: true, userId: message.userId, verified: false };

  const userId = verify(message.session);
  return userId ? { ok: true, userId, verified: true } : { ok: false };
}
