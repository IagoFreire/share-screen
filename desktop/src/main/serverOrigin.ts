/**
 * Where the relay (and the desktop.html page it serves) lives in production, best first:
 * the bot served straight from home on its own port (start-bot.bat with BOT_EXPOSE=direto),
 * then the plain address, which the Cloudflare Tunnel serves. Trying both lets one app
 * version work with either, and keeps working when the bot moves between them.
 */
const PRODUCTION_SERVER_ORIGINS = ["https://share.iagofreire.dev:8443", "https://share.iagofreire.dev"];

/**
 * The servers this app may talk to, in order of preference. SCREENSHARE_SERVER points it
 * at exactly one for development (e.g. http://localhost:5173, the Vite dev server that
 * proxies /api and /ws).
 */
export function serverOriginCandidates(env: Record<string, string | undefined>): string[] {
  const override = env.SCREENSHARE_SERVER?.trim();
  return override ? [override.replace(/\/+$/, "")] : [...PRODUCTION_SERVER_ORIGINS];
}

/**
 * The first candidate whose server answers. All are asked at once, but an earlier one
 * that answers wins without waiting on the rest. With none answering (the bot is down),
 * the first is used; the offline page's retry asks again.
 */
export async function pickServerOrigin(
  candidates: string[],
  isUp: (origin: string) => Promise<boolean>,
): Promise<string> {
  const answers = candidates.map((origin) => isUp(origin).catch(() => false));
  for (const [index, answer] of answers.entries()) {
    if (await answer) return candidates[index]!;
  }
  return candidates[0]!;
}
