/** Where the relay (and the desktop.html page it serves) lives in production. */
const PRODUCTION_SERVER_ORIGIN = "https://share.iagofreire.dev";

/**
 * The server this app talks to. SCREENSHARE_SERVER points it elsewhere for development
 * (e.g. http://localhost:5173, the Vite dev server that proxies /api and /ws).
 */
export function resolveServerOrigin(env: Record<string, string | undefined>): string {
  const override = env.SCREENSHARE_SERVER?.trim();
  return (override || PRODUCTION_SERVER_ORIGIN).replace(/\/+$/, "");
}
