/**
 * The janja:// link that opens the Janja desktop app's transmit dialog for a room --
 * even with the app closed (see desktop/src/main/deepLink.ts, which parses it back).
 * present.html tries it first, so "Compartilhar tela" in the Activity reaches the app
 * whenever it is installed, and stays a plain browser share when it isn't.
 */
export function janjaTransmitLink(roomId: string, guildId: string | null): string {
  const params = new URLSearchParams({ room: roomId });
  if (guildId) params.set("guild", guildId);
  return `janja://transmit?${params.toString()}`;
}

/**
 * Whether firing the link unasked is safe here. Chromium (Chrome, Edge, Opera) quietly
 * does nothing for a scheme no app claims; other browsers may replace the page with an
 * error, losing the browser share -- there it waits for a click instead.
 */
export function canTryLinkSilently(nav: Navigator): boolean {
  return "userAgentData" in nav;
}
