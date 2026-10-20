import type { WebPreferences } from "electron";

/**
 * The main window's renderer settings.
 *
 * Background throttling is off because this window is a live player. With it on, Chromium
 * stops requestAnimationFrame as soon as the window is minimized or covered by another
 * app; the player then stops releasing decoded frames, the hardware decoder runs out of
 * surfaces and stops decoding, and every chunk that arrives meanwhile piles up inside
 * the decoder. Coming back, that backlog plays out at roughly real time -- the live
 * visibly "catching up" yet staying behind until the window was focused.
 */
export function mainWindowWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    backgroundThrottling: false,
  };
}
