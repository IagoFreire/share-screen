// Shared inline SVG icons for the viewer overlay controls, used by both the in-Activity
// viewer (App.ts) and the standalone browser viewer (watch.ts) so the two don't drift.

export const ICON_SHARE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm18-7H5v1.63c3.96 1.28 7.09 4.41 8.37 8.37H19V7zM1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>`;
export const ICON_VOLUME = `<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3z"/><path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77zM16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.06c1.48-.74 2.5-2.26 2.5-4.03z"/></svg>`;
export const ICON_MUTED = `<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4l-1.88 1.88L12 7.76V4zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71z"/></svg>`;
export const ICON_FULLSCREEN_ENTER = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zM5 10h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`;
export const ICON_FULLSCREEN_EXIT = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`;
export const ICON_STOP = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`;
export const ICON_IDLE = `<svg viewBox="0 0 24 24" width="46" height="46" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`;
export const ICON_OPEN_EXTERNAL = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM5 5h5V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-5h-2v5H5V5z"/></svg>`;
// Power symbol: reads as "end this broadcast" without implying the viewer's own playback
// stops, which a plain stop square sitting among the playback controls would.
export const ICON_END_STREAM = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v9"/><path d="M6.8 6.8a8 8 0 1 0 10.4 0"/></svg>`;
const VIDEO_CAMERA_PATH = "M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4Z";
export const ICON_VIDEO = `<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="${VIDEO_CAMERA_PATH}"/></svg>`;
// A dimmed camera icon plus a plain diagonal line, rather than one hand-authored
// "camera with a built-in slash" path -- much less likely to end up subtly malformed.
export const ICON_VIDEO_OFF = `<svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" opacity="0.45" d="${VIDEO_CAMERA_PATH}"/><line x1="2" y1="2" x2="22" y2="22" stroke="currentColor" stroke-width="2"/></svg>`;
