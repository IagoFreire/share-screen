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
    "script-src 'self'",
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

/** Fullscreen for the player, and screen capture (narrowed further by capture.ts). */
const ALLOWED_PERMISSIONS = new Set(["fullscreen", "display-capture"]);

/**
 * getDisplayMedia() reaches the request handler as "media" with an empty `mediaTypes`;
 * the camera and microphone ask as "media" with "video"/"audio" and stay denied. The
 * display-media handler (capture.ts) still decides which single source is granted.
 */
export function isAllowedPermission(
  permission: string,
  requestingUrl: string,
  serverOrigin: string,
  mediaTypes?: readonly string[],
): boolean {
  if (!isAllowedNavigation(requestingUrl, serverOrigin)) return false;
  if (permission === "media") return mediaTypes !== undefined && mediaTypes.length === 0;
  return ALLOWED_PERMISSIONS.has(permission);
}
