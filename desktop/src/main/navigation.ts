/**
 * The app's window shows pages from the relay server and nothing else: the preload's
 * `window.desktop` API (pick a capture source, log in, ...) must never be reachable
 * from a page some link wandered off to. Compared by origin, so scheme, host and port
 * all have to match -- a lookalike host or a plain-http downgrade is a different origin.
 */
export function isAllowedNavigation(url: string, serverOrigin: string): boolean {
  try {
    return new URL(url).origin === new URL(serverOrigin).origin;
  } catch {
    return false;
  }
}
