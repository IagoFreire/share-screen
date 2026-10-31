import { isAllowedNavigation } from "./navigation";

/**
 * Defense in depth for desktop.html, a remote page that holds a bearer session and a
 * bridge able to list (and screenshot) every window: a Content-Security-Policy so only
 * the server's own scripts ever run in it, and a permission allowlist so it can't be
 * talked into the camera, the microphone or anything else Electron grants by default.
 */

export function buildContentSecurityPolicy(serverOrigin: string): string {
  const url = new URL(serverOrigin);
  const socketOrigin = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  return [
    "default-src 'self'",
    // WebAssembly compiled from the server's own files: the voice rooms' noise
    // suppression (RNNoise) runs as WASM. eval() and inline script stay blocked.
    "script-src 'self' 'wasm-unsafe-eval'",
    // The player and the dev server set inline styles; no inline script is allowed.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://cdn.discordapp.com",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${socketOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Fullscreen for the player, screen capture (narrowed further by capture.ts), and
 * picking the speakers voice rooms play through.
 */
const ALLOWED_PERMISSIONS = new Set(["fullscreen", "display-capture", "speaker-selection"]);

/**
 * getDisplayMedia() reaches the request handler as "media" with an empty `mediaTypes`,
 * and the voice rooms' microphone as "media" with just "audio"; anything asking for
 * "video" (the camera) stays denied. The display-media handler (capture.ts) still
 * decides which single screen source is granted.
 */
export function isAllowedPermission(
  permission: string,
  requestingUrl: string,
  serverOrigin: string,
  mediaTypes?: readonly string[],
): boolean {
  if (!isAllowedNavigation(requestingUrl, serverOrigin)) return false;
  if (permission === "media") return mediaTypes !== undefined && mediaTypes.every((type) => type === "audio");
  return ALLOWED_PERMISSIONS.has(permission);
}
