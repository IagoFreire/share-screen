/**
 * Ambient declarations for getDisplayMedia() constraints that TypeScript's bundled
 * lib.dom.d.ts doesn't know about yet. Both are Chromium-only, which is the same
 * constraint the capture path already lives under (see capture/screenCapture.ts).
 */

interface MediaTrackConstraintSet {
  /**
   * Asks for the system audio mix when the user shares a whole screen. Without it
   * Chrome still shows the "share audio" checkbox but is free to hand back a track
   * with nothing in it depending on platform and source.
   */
  systemAudio?: ConstrainDOMString;
  /**
   * Removes whatever *this page* is playing from the captured mix. Matters because a
   * presenter usually also has a viewer tab open: without it, the stream they are
   * watching gets folded back into the audio they are broadcasting, in a loop.
   */
  restrictOwnAudio?: ConstrainBoolean;
}
